// The admin audit log: what admins did, to whom, and when. Rows are only ever inserted, by
// `withAudit`, alongside the action itself; nothing here updates or deletes one.
import { and, desc, eq, lt, type SQL } from "drizzle-orm";
import type { z } from "zod";
import type { Db } from "../db/client.ts";
import { adminActions, tenants, users, type auditQuerySchema } from "../db/schema.ts";

// Who did it: a signed-in admin, or the command line (no person).
export type Actor = { readonly id: string | null; readonly label: string };
export const COMMAND_LINE: Actor = { id: null, label: "command line" };

// Whom the action was done to, and anything worth reading later. Every field is optional.
export type AuditTarget = Partial<
  Pick<typeof adminActions.$inferInsert, "targetUserId" | "targetTenantId" | "detail">
>;

// Runs `work` and records `action` by `actor` in one transaction: both are stored, or neither.
// `work` gets the transaction to write with and `audit`, which names the target as it is found.
export const withAudit = <T>(
  db: Db,
  actor: Actor,
  action: string,
  work: (tx: Db, audit: (target: AuditTarget) => void) => Promise<T>
): Promise<T> =>
  db.transaction(async (tx) => {
    let target: AuditTarget = {};
    const result = await work(tx as unknown as Db, (more) => {
      target = { ...target, ...more };
    });
    await tx
      .insert(adminActions)
      .values({ adminId: actor.id, adminLabel: actor.label, action, ...target });
    return result;
  });

// Newest first, a page at a time: `nextCursor` is passed back as `cursor` for the next page.
export const listAdminActions = async (
  db: Db,
  { admin, tenantId, cursor, limit }: z.infer<typeof auditQuerySchema>
) => {
  const conditions: readonly (SQL | undefined)[] = [
    admin === undefined ? undefined : eq(adminActions.adminLabel, admin),
    tenantId === undefined ? undefined : eq(adminActions.targetTenantId, tenantId),
    cursor ? lt(adminActions.id, cursor) : undefined,
  ];
  const rows = await db
    .select({
      id: adminActions.id,
      admin: adminActions.adminLabel,
      action: adminActions.action,
      targetEmail: users.email,
      targetBusiness: tenants.name,
      targetTenantId: adminActions.targetTenantId,
      detail: adminActions.detail,
      createdAt: adminActions.createdAt,
    })
    .from(adminActions)
    .leftJoin(users, eq(users.id, adminActions.targetUserId))
    .leftJoin(tenants, eq(tenants.id, adminActions.targetTenantId))
    .where(and(...conditions))
    .orderBy(desc(adminActions.id))
    .limit(limit + 1);
  const entries = rows.slice(0, limit);
  return {
    entries,
    nextCursor: rows.length > limit ? entries[entries.length - 1].id : null,
  };
};

// What the log can be filtered by: every admin in it, and every business something was done to.
export const auditFilters = async (db: Db) => ({
  admins: (
    await db
      .selectDistinct({ label: adminActions.adminLabel })
      .from(adminActions)
      .orderBy(adminActions.adminLabel)
  ).map(({ label }) => label),
  businesses: await db
    .selectDistinct({ id: tenants.id, name: tenants.name, slug: tenants.slug })
    .from(adminActions)
    .innerJoin(tenants, eq(tenants.id, adminActions.targetTenantId))
    .orderBy(tenants.name, tenants.id),
});
