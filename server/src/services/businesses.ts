// Businesses (tenants) and who belongs to them. Every API call acts inside one business, and
// nothing in another business can be seen or changed from it.
import { randomUUID } from "node:crypto";
import { asc, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { approvedEmails, builds, memberships, projects, tenants, users } from "../db/schema.ts";
import type { Person } from "./auth.ts";
import { NotFoundError } from "./errors.ts";

export type Business = { readonly id: number; readonly name: string };

const membershipsOf = (db: Db, userId: string): Promise<Business[]> =>
  db
    .select({ id: tenants.id, name: tenants.name })
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
