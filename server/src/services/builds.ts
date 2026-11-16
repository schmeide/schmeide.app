import { and, asc, eq, gt } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import {
  buildEvents,
  builds,
  usage,
  type Build,
  type BuildEvent,
  type BuildEventKind,
  type NewUsage,
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

export const recordUsage = async (db: Db, rows: readonly NewUsage[]): Promise<void> => {
  if (rows.length > 0) await db.insert(usage).values([...rows]);
};
