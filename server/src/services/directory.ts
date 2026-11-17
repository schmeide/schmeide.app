// What the admin area lists across every business: the businesses, their members and projects,
// and every person. Read-only. Columns are picked one by one, so nothing that lets someone sign in
// (a password hash, a session or provider token, an invite token) can ride along.
import { and, asc, desc, eq, exists, ilike, inArray, or, sql } from "drizzle-orm";
import type { z } from "zod";
import type { Db } from "../db/client.ts";
import {
  ADMIN_ROLE,
  approvedEmails,
  memberships,
  projects,
  tenants,
  users,
  type adminListSchema,
} from "../db/schema.ts";
import { NotFoundError } from "./errors.ts";

type ListQuery = z.infer<typeof adminListSchema>;

// `%text%` for ILIKE, with the wildcards in the text matched as themselves.
const containing = (text: string) => `%${text.replace(/[\\%_]/g, "\\$&")}%`;

// One page out of `limit + 1` rows: the extra row only says there is a next page.
const pageOf = <T>(rows: readonly T[], { cursor, limit }: ListQuery) => {
  const offset = cursor ?? 0;
  return {
    entries: rows.slice(0, limit),
    nextCursor: rows.length > limit ? offset + limit : null,
  };
};

// Every business, newest first, found by its name or a member's email.
export const listBusinesses = async (db: Db, query: ListQuery) => {
  const pattern = query.search ? containing(query.search) : undefined;
  const rows = await db
    .select({
      id: tenants.id,
      name: tenants.name,
      slug: tenants.slug,
      members: db.$count(memberships, eq(memberships.tenantId, tenants.id)),
      projects: db.$count(projects, eq(projects.tenantId, tenants.id)),
      createdAt: tenants.createdAt,
    })
    .from(tenants)
    .where(
      pattern
        ? or(
            ilike(tenants.name, pattern),
            exists(
              db
                .select({ one: sql`1` })
                .from(memberships)
                .innerJoin(users, eq(users.id, memberships.userId))
                .where(and(eq(memberships.tenantId, tenants.id), ilike(users.email, pattern)))
            )
          )
        : undefined
    )
    .orderBy(desc(tenants.createdAt), desc(tenants.id))
    .limit(query.limit + 1)
    .offset(query.cursor ?? 0);
  return pageOf(rows, query);
};

// One business with its members, longest-standing first, and its projects, newest first.
export const getBusiness = async (db: Db, id: number) => {
  const [business] = await db
    .select({
      id: tenants.id,
      name: tenants.name,
      slug: tenants.slug,
      createdAt: tenants.createdAt,
    })
    .from(tenants)
    .where(eq(tenants.id, id));
  if (!business) throw new NotFoundError(`Business ${id} not found`);
  const members = await db
    .select({
      name: users.name,
      email: users.email,
      role: memberships.role,
      admin: sql<boolean>`coalesce(${users.role} = ${ADMIN_ROLE}, false)`,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(eq(memberships.tenantId, id))
    .orderBy(asc(memberships.createdAt), asc(users.email));
  const owned = await db
    .select({ id: projects.id, name: projects.name, status: projects.status })
    .from(projects)
    .where(eq(projects.tenantId, id))
    .orderBy(desc(projects.id));
  return { business, members, projects: owned };
};

// Every person with an account, newest first, found by name or email. Two queries a page: the
// people, then all of their businesses at once.
export const listPeople = async (db: Db, query: ListQuery) => {
  const pattern = query.search ? containing(query.search) : undefined;
  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      approved: sql<boolean>`${approvedEmails.email} is not null`,
      admin: sql<boolean>`coalesce(${users.role} = ${ADMIN_ROLE}, false)`,
    })
    .from(users)
    .leftJoin(approvedEmails, eq(approvedEmails.email, users.email))
    .where(pattern ? or(ilike(users.name, pattern), ilike(users.email, pattern)) : undefined)
    .orderBy(desc(users.createdAt), desc(users.id))
    .limit(query.limit + 1)
    .offset(query.cursor ?? 0);
  const ids = rows.map(({ id }) => id);
  const joined =
    ids.length === 0
      ? []
      : await db
          .select({ userId: memberships.userId, id: tenants.id, name: tenants.name })
          .from(memberships)
          .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
          .where(inArray(memberships.userId, ids))
          .orderBy(asc(memberships.createdAt), asc(tenants.id));
  const people = rows.map(({ id, ...person }) => ({
    ...person,
    businesses: joined
      .filter((row) => row.userId === id)
      .map((business) => ({ id: business.id, name: business.name })),
  }));
  return pageOf(people, query);
};
