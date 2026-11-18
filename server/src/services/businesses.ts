// Businesses (tenants) and who belongs to them. Every API call acts inside one business, and
// nothing in another business can be seen or changed from it.
import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { countryCodes } from "../../../data/countries.ts";
import type { Db } from "../db/client.ts";
import {
  approvedEmails,
  builds,
  invites,
  memberships,
  projects,
  tenants,
  users,
  type MemberRole,
} from "../db/schema.ts";
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

// The person's businesses, oldest first. A person with none joins the business their approval
// names on the spot, so someone invited never sees first-run setup. Anyone else has none until
// they set one up (startBusiness). An admin works from the admin area and is joined to none; nor
// is anyone while an admin views the app as them.
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
    if (approval?.tenantId) {
      await joinBusiness(tx, person.id, approval.tenantId);
      await tx
        .update(invites)
        .set({ usedAt: new Date() })
        .where(
          and(
            eq(invites.email, person.email),
            eq(invites.tenantId, approval.tenantId),
            isNull(invites.usedAt)
          )
        );
    }
    return membershipsOf(tx, person.id);
  });
};

const oneLine = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((text) => !/[\r\n]/.test(text));

// First-run setup: the person's name, and their business's name (theirs when left empty),
// country, and what it does.
export const startBusinessSchema = z.object({
  yourName: oneLine(100).pipe(z.string().min(1)),
  name: oneLine(120).optional(),
  country: z.string().refine((code) => countryCodes.includes(code)),
  description: oneLine(200).optional(),
});

export const ALREADY_IN_A_BUSINESS =
  "You already have a business, so there is nothing to set up. Reload the page to go to it.";

// Makes a business with the person as its owner, and saves their name. Only for someone in no
// business yet: a second submit of the form, or a second tab, is refused.
export const startBusiness = (
  db: Db,
  userId: string,
  input: Omit<z.output<typeof startBusinessSchema>, "country"> & {
    readonly country: string | null;
  }
): Promise<Business> =>
  db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    // Two submits at once must not make two businesses: the second waits here.
    await tx.execute(sql`select 1 from ${users} where ${users.id} = ${userId} for update`);
    if ((await membershipsOf(tx, userId)).length > 0)
      throw new ConflictError(ALREADY_IN_A_BUSINESS);
    await tx.update(users).set({ name: input.yourName }).where(eq(users.id, userId));
    const [tenant] = await tx
      .insert(tenants)
      .values({
        slug: `b-${randomUUID()}`,
        name: input.name || `${input.yourName}’s business`,
        country: input.country,
        description: input.description || null,
      })
      .returning({ id: tenants.id, name: tenants.name });
    await tx.insert(memberships).values({ userId, tenantId: tenant.id, role: "owner" });
    return { ...tenant, suspended: false };
  });

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

export const roleIn = async (
  db: Db,
  tenantId: number,
  userId: string
): Promise<MemberRole | undefined> => {
  const [membership] = await db
    .select({ role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, userId)));
  return membership?.role;
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
        ? "This business is already suspended, so there is nothing to change. Reload this page to see its current state, or choose “Restore this business” to open it again."
        : "This business is not suspended, so there is nothing to restore. Reload this page to see its current state."
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
      throw new ConflictError(
        "The last owner of a business cannot be removed, since nobody would be left to run it. Add another owner first, or choose “Suspend this business” instead."
      );
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
