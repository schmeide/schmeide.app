import type { query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { and, asc, eq, gt, isNotNull, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import {
  agentRuns,
  buildEvents,
  builds,
  usage,
  type Build,
  type BuildEvent,
  type BuildEventKind,
  type NewAgentRun,
  type NewUsage,
  type RunKind,
} from "../db/schema.ts";
import { NotFoundError } from "./errors.ts";

const EVENTS_PAGE = 500;

export const appendEvent = async (
  db: Db,
  buildId: number,
  kind: BuildEventKind,
  message: string
): Promise<BuildEvent> => {
  const [event] = await db.insert(buildEvents).values({ buildId, kind, message }).returning();
  return event;
};

// Pages forward from afterId, so a poller passes the last id it saw.
export const listEvents = (
  db: Db,
  buildId: number,
  afterId: number
): Promise<readonly BuildEvent[]> =>
  db
    .select()
    .from(buildEvents)
    .where(and(eq(buildEvents.buildId, buildId), gt(buildEvents.id, afterId)))
    .orderBy(asc(buildEvents.id))
    .limit(EVENTS_PAGE);

export const getBuild = async (db: Db, buildId: number): Promise<Build> => {
  const [build] = await db.select().from(builds).where(eq(builds.id, buildId));
  if (!build) throw new NotFoundError(`Build ${buildId} not found`);
  return build;
};

export const finishBuild = async (db: Db, buildId: number, error?: string): Promise<Build> => {
  const [build] = await db
    .update(builds)
    .set({ status: error ? "failed" : "passed", error: error ?? null, finishedAt: new Date() })
    .where(eq(builds.id, buildId))
    .returning();
  return build;
};

// Building time is each finished build's start to finish: what a person waited, checks and publishing
// included. A queued change's start is set when it actually starts (startNextChange), so its wait
// is not counted. Failed builds, canceled ones among them, are summed apart as well.
const buildMs = sql`extract(epoch from ${builds.finishedAt} - ${builds.startedAt}) * 1000`;
export const buildingTime = {
  buildingMs: sql<number>`coalesce(round(sum(${buildMs})), 0)`.mapWith(Number),
  failedBuildingMs:
    sql<number>`coalesce(round(sum(${buildMs}) filter (where ${builds.status} = 'failed')), 0)`.mapWith(
      Number
    ),
};
export const finishedBuild = isNotNull(builds.finishedAt);

// Builder time is how long the model itself ran, over every recorded run.
export const builderTime = {
  builderMs: sql<number>`coalesce(sum(${agentRuns.durationMs}), 0)`.mapWith(Number),
};

// One agent run as its SDK result reports it: the run with its time, and one usage row per model.
export type RunUsage = { readonly run: NewAgentRun; readonly models: readonly NewUsage[] };

// null when nothing ran: a fake agent command stands in for the model.
export const recordUsage = async (db: Db, used: RunUsage | null): Promise<void> => {
  if (!used) return;
  await db.transaction(async (tx) => {
    const [run] = await tx.insert(agentRuns).values(used.run).returning({ id: agentRuns.id });
    if (used.models.length > 0)
      await tx.insert(usage).values(used.models.map((row) => ({ ...row, runId: run.id })));
  });
};

// The Claude Agent SDK entry point; tests pass a stand-in.
export type Query = typeof query;

// buildId is null for model calls made outside a build: writing a spec, asking an interview question.
export const runUsage = (
  message: Extract<SDKMessage, { type: "result" }>,
  projectId: number,
  buildId: number | null,
  runKind: RunKind
): RunUsage => ({
  run: { projectId, buildId, runKind, durationMs: Math.round(message.duration_ms) },
  models: Object.entries(message.modelUsage).map(([model, used]) => ({
    projectId,
    buildId,
    runKind,
    model,
    inputTokens: used.inputTokens,
    outputTokens: used.outputTokens,
    cacheReadTokens: used.cacheReadInputTokens,
    cacheCreationTokens: used.cacheCreationInputTokens,
    costUsd: used.costUSD,
  })),
});
