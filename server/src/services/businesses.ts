// Businesses (tenants) and who belongs to them. Every API call acts inside one business, and
// nothing in another business can be seen or changed from it.
import { randomUUID } from "node:crypto";
import { and, asc, eq, ne, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { approvedEmails, builds, memberships, projects, tenants, users } from "../db/schema.ts";
import type { AuditTarget } from "./audit.ts";
import type { Person } from "./auth.ts";
import { BusinessSuspendedError, ConflictError, NotFoundError } from "./errors.ts";

// `suspended`: its members cannot open it (router.ts `callerOf`), though they still see it listed.
export type Business = { readonly id: number; readonly name: string; readonly suspended: boolean };

const isSuspended = sql<boolean>`${tenants.state} = 'suspended'`;

const membershipsOf = (db: Db, userId: string): Promise<Business[]> =>
  db
    .select({ id: tenants.id, name: tenants.name, suspended: isSuspended })
    .from(memberships)
    .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
    .where(eq(memberships.userId, userId))
    .orderBy(asc(memberships.createdAt), asc(tenants.id));

// The person's businesses, oldest first. A person with none gets one on the spot: the business
// their approval names, or a new one of their own. So a signed-in person always has a business,
// except an admin, who works from the admin area and is given none. Nor is one made while an admin
// views the app as the person: the person would find a business they did not make.
export const businessesOf = async (db: Db, person: Person): Promise<readonly Business[]> => {
  const existing = await membershipsOf(db, person.id);
  if (existing.length > 0 || person.admin || person.impersonatedBy) return existing;
  return db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    // Two first requests at once must not make two businesses: the second waits here.
    await tx.execute(sql`select 1 from ${users} where ${users.id} = ${person.id} for update`);
    const again = await membershipsOf(tx, person.id);
    if (again.length > 0) return again;
    const [approval] = await tx
      .select({ tenantId: approvedEmails.tenantId })
      .from(approvedEmails)
      .where(eq(approvedEmails.email, person.email));
    if (approval?.tenantId) await joinBusiness(tx, person.id, approval.tenantId);
    else {
      const [tenant] = await tx
        .insert(tenants)
        .values({ slug: `b-${randomUUID()}`, name: `${person.name}’s business` })
        .returning();
      await tx
        .insert(memberships)
        .values({ userId: person.id, tenantId: tenant.id, role: "owner" });
    }
    return membershipsOf(tx, person.id);
  });
};

// Adds the person to a business, as `role` when given: otherwise its owner when it has nobody yet,
// an editor when it has. Someone already in it keeps their role.
export const joinBusiness = async (
  db: Db,
  userId: string,
  tenantId: number,
  role?: "owner" | "editor"
): Promise<void> => {
  const [anyone] = await db
    .select({ userId: memberships.userId })
    .from(memberships)
    .where(eq(memberships.tenantId, tenantId))
    .limit(1);
  await db
    .insert(memberships)
    .values({ userId, tenantId, role: role ?? (anyone ? "editor" : "owner") })
    .onConflictDoNothing();
};

export const findTenantBySlug = async (db: Db, slug: string): Promise<number> => {
  const [tenant] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.slug, slug));
  if (!tenant) throw new NotFoundError(`There is no business with the slug "${slug}"`);
  return tenant.id;
};

// Both throw exactly what a missing project or build throws, so a caller cannot tell "in another
// business" from "does not exist".
export const assertProjectIn = async (db: Db, tenantId: number, id: number): Promise<void> => {
  const [project] = await db
    .select({ tenantId: projects.tenantId })
    .from(projects)
    .where(eq(projects.id, id));
  if (project?.tenantId !== tenantId) throw new NotFoundError(`Project ${id} not found`);
};

export const assertBuildIn = async (db: Db, tenantId: number, buildId: number): Promise<void> => {
  const [build] = await db
    .select({ tenantId: projects.tenantId })
    .from(builds)
    .innerJoin(projects, eq(projects.id, builds.projectId))
    .where(eq(builds.id, buildId));
  if (build?.tenantId !== tenantId) throw new NotFoundError(`Build ${buildId} not found`);
};

// Whether nothing may run for the business: it is suspended, or gone. For work nobody asked for in
// a request, which `callerOf` cannot see: the worker's build steps and spec runs, and a queued
// change starting on its own.
export const businessSuspended = async (db: Db, tenantId: number): Promise<boolean> => {
  const [tenant] = await db
    .select({ suspended: isSuspended })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  return !tenant || tenant.suspended;
};

export const assertActive = async (db: Db, tenantId: number): Promise<void> => {
  if (await businessSuspended(db, tenantId)) throw new BusinessSuspendedError();
};

type Audit = (target: AuditTarget) => void;

// Suspends or restores a business, keeping why and when. Asking for the state it is already in is
// refused, so the audit log only ever records a change. Nothing running is stopped: its live apps
// keep answering, and a build already running stops at its next step (temporal/activities.ts).
export const setBusinessState = async (
  db: Db,
  audit: Audit,
  { id, reason }: { readonly id: number; readonly reason: string },
  state: "active" | "suspended"
): Promise<{ readonly id: number; readonly state: "active" | "suspended" }> => {
  const [changed] = await db
    .update(tenants)
    .set({ state, stateReason: reason, stateChangedAt: new Date() })
    .where(and(eq(tenants.id, id), ne(tenants.state, state)))
    .returning({ id: tenants.id });
  if (!changed) {
    await assertTenantExists(db, id);
    throw new ConflictError(
      state === "suspended"
        ? "This business is already suspended"
        : "This business is not suspended"
    );
  }
  audit({ targetTenantId: id, detail: reason });
  return { id, state };
};

const assertTenantExists = async (db: Db, id: number): Promise<void> => {
  const [tenant] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, id));
  if (!tenant) throw new NotFoundError(`Business ${id} not found`);
};

// Takes a person out of a business. The business is gone for them on their very next call, since
// every call reads their memberships again; their sessions are left alone, as they may work in
// other businesses. An approval that named this business stops naming it, or their next sign-in
// with no business left would put them straight back in (businessesOf). The last owner stays:
// a business with no owner has nobody who can run it.
export const removeMember = async (
  db: Db,
  audit: Audit,
  { id, email, reason }: { readonly id: number; readonly email: string; readonly reason: string }
): Promise<{ readonly removed: true }> => {
  // Two admins removing its two owners at once: the second waits here and sees one owner left.
  const [tenant] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.id, id))
    .for("update");
  if (!tenant) throw new NotFoundError(`Business ${id} not found`);
  const [member] = await db
    .select({ userId: memberships.userId, role: memberships.role })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.tenantId, id), eq(users.email, email)));
  if (!member) throw new NotFoundError(`${email} is not in this business`);
  if (member.role === "owner") {
    const owners = await db.$count(
      memberships,
      and(eq(memberships.tenantId, id), eq(memberships.role, "owner"))
    );
    if (owners <= 1)
      throw new ConflictError("The last owner of a business cannot be removed from it");
  }
  await db
    .delete(memberships)
    .where(and(eq(memberships.tenantId, id), eq(memberships.userId, member.userId)));
  await db
    .update(approvedEmails)
    .set({ tenantId: null })
    .where(and(eq(approvedEmails.email, email), eq(approvedEmails.tenantId, id)));
  audit({ targetUserId: member.userId, targetTenantId: id, detail: `${email}: ${reason}` });
  return { removed: true };
};
