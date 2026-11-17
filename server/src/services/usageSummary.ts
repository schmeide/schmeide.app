// Tokens and cost across businesses, from `usage` (recordUsage, builds.ts), for the admin area.
// Every sum is made by the database, cost as numeric: summing in JavaScript would drift.
// A deleted project takes its usage rows with it (deleteProjectRows, projects.ts), so these sums
// leave it out.
import { and, asc, desc, eq, gte, lt, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn, SelectedFields } from "drizzle-orm/pg-core";
import type { z } from "zod";
import type { Db } from "../db/client.ts";
import { projects, tenants, usage, type usageQuerySchema } from "../db/schema.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

// A period's days run midnight to midnight UTC: from its first day's start, up to but not
// including the start of the day after its last.
export const periodBounds = ({ from, to }: { readonly from?: string; readonly to?: string }) => ({
  start: from === undefined ? undefined : new Date(`${from}T00:00:00Z`),
  end: to === undefined ? undefined : new Date(Date.parse(`${to}T00:00:00Z`) + DAY_MS),
});

const sumOf = (column: AnyPgColumn) => sql<number>`coalesce(sum(${column}), 0)`.mapWith(Number);

const totals = () => ({
  inputTokens: sumOf(usage.inputTokens),
  outputTokens: sumOf(usage.outputTokens),
  cacheReadTokens: sumOf(usage.cacheReadTokens),
  cacheCreationTokens: sumOf(usage.cacheCreationTokens),
  costUsd: sql<number>`coalesce(sum(${usage.costUsd}::numeric), 0)`.mapWith(Number),
});
const byCost = sql`sum(${usage.costUsd}::numeric)`;

// Per business, per project, per model, and per kind of run: one grouped query each, each
// ordered by cost, highest first. `tenantId` narrows all four to one business.
export const usageSummary = async (db: Db, query: z.infer<typeof usageQuerySchema>) => {
  const { start, end } = periodBounds(query);
  const where: SQL | undefined = and(
    start && gte(usage.at, start),
    end && lt(usage.at, end),
    query.tenantId === undefined ? undefined : eq(projects.tenantId, query.tenantId)
  );
  const grouped = <T extends SelectedFields>(fields: T) =>
    db
      .select({ ...fields, ...totals() })
      .from(usage)
      .innerJoin(projects, eq(projects.id, usage.projectId))
      .innerJoin(tenants, eq(tenants.id, projects.tenantId))
      .where(where);
  const [businesses, projectRows, models, runKinds] = await Promise.all([
    grouped({ id: tenants.id, name: tenants.name })
      .groupBy(tenants.id)
      .orderBy(desc(byCost), asc(tenants.id)),
    grouped({
      id: projects.id,
      name: projects.name,
      business: { id: tenants.id, name: tenants.name },
    })
      .groupBy(projects.id, tenants.id)
      .orderBy(desc(byCost), asc(projects.id)),
    grouped({ model: usage.model }).groupBy(usage.model).orderBy(desc(byCost), asc(usage.model)),
    grouped({ runKind: usage.runKind })
      .groupBy(usage.runKind)
      .orderBy(desc(byCost), asc(usage.runKind)),
  ]);
  return { businesses, projects: projectRows, models, runKinds };
};
