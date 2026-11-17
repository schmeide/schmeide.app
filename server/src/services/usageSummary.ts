// Tokens, cost, and time across businesses, from `usage`, `agent_runs` (recordUsage, builds.ts),
// and `builds`, for the admin area.
// Every sum is made by the database, cost as numeric: summing in JavaScript would drift.
// A deleted project takes its usage rows with it (deleteProjectRows, projects.ts), so these sums
// leave it out.
import { and, asc, desc, eq, gte, lt, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn, SelectedFields } from "drizzle-orm/pg-core";
import type { z } from "zod";
import type { Db } from "../db/client.ts";
import {
  agentRuns,
  builds,
  projects,
  tenants,
  usage,
  type periodSchema,
  type usageQuerySchema,
} from "../db/schema.ts";
import { builderTime, buildingTime, finishedBuild } from "./builds.ts";

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
  const [businesses, projectRows, models, runKinds, times] = await Promise.all([
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
    timeSummary(db, query),
  ]);
  return { businesses, projects: projectRows, models, runKinds, times };
};

export type BusinessTime = {
  readonly buildingMs: number;
  readonly failedBuildingMs: number;
  readonly builderMs: number;
};
const NO_TIME: BusinessTime = { buildingMs: 0, failedBuildingMs: 0, builderMs: 0 };

// Building and builder time per business (builds.ts says what each is), longest building first. A
// build counts in the period it finished in, a model run in the one it was recorded in; a running
// build counts once it finishes.
export const timeSummary = async (
  db: Db,
  query: z.infer<typeof usageQuerySchema>
): Promise<readonly (BusinessTime & { readonly id: number; readonly name: string })[]> => {
  const { start, end } = periodBounds(query);
  const tenant = query.tenantId === undefined ? undefined : eq(projects.tenantId, query.tenantId);
  const perBusiness = { id: tenants.id, name: tenants.name };
  const [building, builder] = await Promise.all([
    db
      .select({ ...perBusiness, ...buildingTime })
      .from(builds)
      .innerJoin(projects, eq(projects.id, builds.projectId))
      .innerJoin(tenants, eq(tenants.id, projects.tenantId))
      .where(
        and(
          finishedBuild,
          start && gte(builds.finishedAt, start),
          end && lt(builds.finishedAt, end),
          tenant
        )
      )
      .groupBy(tenants.id),
    db
      .select({ ...perBusiness, ...builderTime })
      .from(agentRuns)
      .innerJoin(projects, eq(projects.id, agentRuns.projectId))
      .innerJoin(tenants, eq(tenants.id, projects.tenantId))
      .where(and(start && gte(agentRuns.at, start), end && lt(agentRuns.at, end), tenant))
      .groupBy(tenants.id),
  ]);
  const byId = new Map<number, BusinessTime & { readonly id: number; readonly name: string }>();
  for (const row of [...building, ...builder])
    byId.set(row.id, { ...NO_TIME, ...byId.get(row.id), ...row });
  return [...byId.values()].sort((a, b) => b.buildingMs - a.buildingMs || a.id - b.id);
};

// One business's time for the period: what its own usage page reads.
export const businessTime = async (
  db: Db,
  tenantId: number,
  period: z.infer<typeof periodSchema>
): Promise<BusinessTime> => {
  const [found] = await timeSummary(db, { ...period, tenantId });
  return found
    ? {
        buildingMs: found.buildingMs,
        failedBuildingMs: found.failedBuildingMs,
        builderMs: found.builderMs,
      }
    : NO_TIME;
};
