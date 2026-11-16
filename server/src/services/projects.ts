import type { WorkflowClient } from "@temporalio/client";
import { and, desc, eq, inArray, like, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { Db } from "../db/client.ts";
import {
  buildEvents,
  builds,
  projects,
  tenants,
  usage,
  type Build,
  type Project,
} from "../db/schema.ts";
import type {
  buildWorkflow,
  deleteWorkflow,
  specWorkflow,
  stopWorkflow,
} from "../temporal/workflows.ts";
import { appendEvent, finishBuild } from "./builds.ts";
import { BuildRunningError, ConflictError, NotFoundError } from "./errors.ts";

export const FIRST_WEB_PORT = 8100;
export const FIRST_TEST_DB_PORT = 5600;

// ponytail: every request acts as the seeded `demo` tenant; resolve the tenant from auth in production
const DEMO_TENANT = "demo";

export type Deps = {
  readonly db: Db;
  readonly workflows: Pick<WorkflowClient, "start" | "getHandle">;
  readonly taskQueue: string;
};

type Status = Project["status"];

export const slugify = (name: string): string =>
  name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "") || "project";

// Port n for the stack, test database port n for its throwaway Postgres.
export const testDbPort = (project: Pick<Project, "webPort">): number =>
  FIRST_TEST_DB_PORT + project.webPort - FIRST_WEB_PORT;

const uniqueSlug = async (db: Db, base: string): Promise<string> => {
  const taken = new Set(
    (
      await db
        .select({ slug: projects.slug })
        .from(projects)
        .where(like(projects.slug, `${base}%`))
    ).map((row) => row.slug)
  );
  const candidates = [base, ...Array.from({ length: taken.size }, (_, i) => `${base}-${i + 2}`)];
  return candidates.find((slug) => !taken.has(slug)) ?? `${base}-${taken.size + 2}`;
};

// Slug and port are picked by read-then-insert; a concurrent create can take them first, so a
// unique violation (Postgres 23505) retries with fresh picks.
export const createProject = async (
  db: Db,
  input: { readonly name: string },
  attempts = 5
): Promise<Project> => {
  try {
    const slug = await uniqueSlug(db, slugify(input.name));
    const [project] = await db
      .insert(projects)
      .values({
        tenantId: sql`(select id from ${tenants} where slug = ${DEMO_TENANT})`,
        slug,
        name: input.name,
        webPort: sql`(select coalesce(max(${projects.webPort}) + 1, ${FIRST_WEB_PORT}) from ${projects})`,
      })
      .returning();
    return project;
  } catch (error) {
    const code = (error as { cause?: { code?: string } }).cause?.code;
    if (code !== "23505" || attempts <= 1) throw error;
    return createProject(db, input, attempts - 1);
  }
};

export const listProjects = (db: Db): Promise<readonly Project[]> =>
  db.select().from(projects).orderBy(desc(projects.id));

export const findProject = async (db: Db, id: number): Promise<Project> => {
  const [project] = await db.select().from(projects).where(eq(projects.id, id));
  if (!project) throw new NotFoundError(`Project ${id} not found`);
  return project;
};

const total = (column: AnyPgColumn) => sql`coalesce(sum(${column}), 0)`.mapWith(Number);

export type UsageTotals = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
  readonly costUsd: number;
};

export const getProject = async (
  db: Db,
  id: number
): Promise<{ project: Project; latestBuild: Build | null; usage: UsageTotals }> => {
  const project = await findProject(db, id);
  const [latestBuild] = await db
    .select()
    .from(builds)
    .where(eq(builds.projectId, id))
    .orderBy(desc(builds.id))
    .limit(1);
  const [totals] = await db
    .select({
      inputTokens: total(usage.inputTokens),
      outputTokens: total(usage.outputTokens),
      cacheReadTokens: total(usage.cacheReadTokens),
      cacheCreationTokens: total(usage.cacheCreationTokens),
      costUsd: total(usage.costUsd),
    })
    .from(usage)
    .where(eq(usage.projectId, id));
  return { project, latestBuild: latestBuild ?? null, usage: totals };
};

// Moves a project between statuses only if it is in one of `from`; this is the state machine.
export const transition = async (
  db: Db,
  id: number,
  from: readonly Status[],
  set: Partial<Project> & { readonly status: Status }
): Promise<Project> => {
  const [project] = await db
    .update(projects)
    .set(set)
    .where(and(eq(projects.id, id), inArray(projects.status, [...from])))
    .returning();
  if (project) return project;
  const current = await findProject(db, id);
  throw new ConflictError(
    `Project ${id} is ${current.status}; this needs it to be ${from.join(" or ")}`
  );
};

export const setFeatures = (
  db: Db,
  input: { readonly id: number; readonly features: string }
): Promise<Project> =>
  transition(db, input.id, ["draft", "spec_ready"], {
    status: "draft",
    features: input.features,
    spec: null,
  });

export const generateSpec = async (
  { db, workflows, taskQueue }: Deps,
  id: number
): Promise<Project> => {
  const current = await findProject(db, id);
  if (!current.features.trim()) throw new ConflictError("Add at least one feature first");
  return db.transaction(async (tx) => {
    const project = await transition(tx as unknown as Db, id, ["draft", "spec_ready"], {
      status: "spec_generating",
    });
    await workflows.start<typeof specWorkflow>("specWorkflow", {
      taskQueue,
      workflowId: `spec-${id}-${Date.now()}`,
      args: [id],
    });
    return project;
  });
};

const startBuild = async (
  { db, workflows, taskQueue }: Deps,
  id: number,
  from: readonly Status[],
  kind: Build["kind"],
  request: (project: Project) => string
): Promise<{ project: Project; build: Build }> => {
  // ponytail: one build at a time across all tenants; a task queue per tenant in production
  const [running] = await db
    .select({ id: builds.id })
    .from(builds)
    .where(eq(builds.status, "running"))
    .limit(1);
  if (running)
    throw new BuildRunningError(`Build ${running.id} is still running; wait for it to finish`);
  return db.transaction(async (tx) => {
    const project = await transition(tx as unknown as Db, id, from, { status: "building" });
    const [build] = await tx
      .insert(builds)
      .values({ projectId: id, kind, request: request(project) })
      .returning();
    await workflows.start<typeof buildWorkflow>("buildWorkflow", {
      taskQueue,
      workflowId: `build-${build.id}`,
      args: [id, build.id],
    });
    return { project, build };
  });
};

export const approveSpec = (deps: Deps, id: number) =>
  startBuild(deps, id, ["spec_ready"], "initial", (project) => project.spec ?? "");

export const requestChange = (
  deps: Deps,
  input: { readonly id: number; readonly request: string }
) => startBuild(deps, input.id, ["live", "failed", "stopped"], "change", () => input.request);

// A running build is canceled; otherwise the deployment is taken down.
export const stopProject = async (
  { db, workflows, taskQueue }: Deps,
  id: number
): Promise<Project> => {
  const project = await findProject(db, id);
  if (project.status === "building") {
    const [build] = await db
      .select()
      .from(builds)
      .where(and(eq(builds.projectId, id), eq(builds.status, "running")))
      .limit(1);
    if (build) await workflows.getHandle(`build-${build.id}`).cancel();
    return project;
  }
  if (!["live", "failed", "stopped"].includes(project.status)) {
    throw new ConflictError(`Project ${id} is ${project.status}; there is no deployment to stop`);
  }
  await workflows.start<typeof stopWorkflow>("stopWorkflow", {
    taskQueue,
    workflowId: `stop-${id}-${Date.now()}`,
    args: [id],
  });
  return project;
};

// Removes the deployment, its volumes, the workspace, and every row of the project. Waits for it.
export const deleteProject = async (
  { db, workflows, taskQueue }: Deps,
  id: number
): Promise<void> => {
  const project = await findProject(db, id);
  if (project.status === "building" || project.status === "spec_generating") {
    throw new ConflictError(`Project ${id} is ${project.status}; stop it first`);
  }
  const handle = await workflows.start<typeof deleteWorkflow>("deleteWorkflow", {
    taskQueue,
    workflowId: `delete-${id}-${Date.now()}`,
    args: [id],
  });
  await handle.result();
};

export const deleteProjectRows = (db: Db, id: number): Promise<void> =>
  db.transaction(async (tx) => {
    const ids = tx.select({ id: builds.id }).from(builds).where(eq(builds.projectId, id));
    await tx.delete(usage).where(eq(usage.projectId, id));
    await tx.delete(buildEvents).where(inArray(buildEvents.buildId, ids));
    await tx.delete(builds).where(eq(builds.projectId, id));
    await tx.delete(projects).where(eq(projects.id, id));
  });

export const ORPHANED_BUILD =
  "The Schmeide server stopped while this build ran, and the build could not be resumed. Request a change to try again.";

// At startup: a build still marked running whose workflow is gone (Temporal restarted) or ended
// without recording it would block every new build forever. A workflow still running resumes on its own.
export const failOrphanedBuilds = async ({ db, workflows }: Deps): Promise<void> => {
  const running = await db.select().from(builds).where(eq(builds.status, "running"));
  for (const build of running) {
    const status = await workflows
      .getHandle(`build-${build.id}`)
      .describe()
      .then(
        (description) => description.status.name,
        () => undefined
      );
    if (status === "RUNNING") continue;
    await finishBuild(db, build.id, ORPHANED_BUILD);
    await appendEvent(db, build.id, "error", ORPHANED_BUILD);
    await db
      .update(projects)
      .set({ status: "failed" })
      .where(and(eq(projects.id, build.projectId), eq(projects.status, "building")));
  }
};
