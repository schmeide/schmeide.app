import { WorkflowExecutionAlreadyStartedError, type WorkflowClient } from "@temporalio/client";
import { and, asc, desc, eq, inArray, like, lt, ne, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { Db } from "../db/client.ts";
import {
  buildEvents,
  builds,
  interviewQuestions,
  interviews,
  planItems,
  projectIcons,
  projects,
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
import { appendEvent, finishBuild, getBuild } from "./builds.ts";
import { ConflictError, NotFoundError } from "./errors.ts";

export const FIRST_WEB_PORT = 8100;
export const FIRST_TEST_DB_PORT = 5600;

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
  input: { readonly name: string; readonly tenantId: number },
  attempts = 5
): Promise<Project> => {
  try {
    const slug = await uniqueSlug(db, slugify(input.name));
    const [project] = await db
      .insert(projects)
      .values({
        tenantId: input.tenantId,
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

export const listProjects = (db: Db, tenantId: number): Promise<readonly Project[]> =>
  db.select().from(projects).where(eq(projects.tenantId, tenantId)).orderBy(desc(projects.id));

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

export type BuiltChange = Pick<Build, "id" | "request" | "finishedAt">;

export const builtChanges = (
  db: Db,
  projectId: number,
  beforeBuildId?: number
): Promise<readonly BuiltChange[]> =>
  db
    .select({ id: builds.id, request: builds.request, finishedAt: builds.finishedAt })
    .from(builds)
    .where(
      and(
        eq(builds.projectId, projectId),
        eq(builds.kind, "change"),
        eq(builds.status, "passed"),
        beforeBuildId === undefined ? undefined : lt(builds.id, beforeBuildId)
      )
    )
    .orderBy(asc(builds.id));

export const getProject = async (
  db: Db,
  id: number
): Promise<{
  project: Project;
  latestBuild: Build | null;
  queued: readonly Build[];
  changes: readonly BuiltChange[];
  hasIcon: boolean;
  // A build of this project has passed, so the app has been live at least once.
  hasBeenLive: boolean;
  usage: UsageTotals;
}> => {
  const project = await findProject(db, id);
  const [latestBuild] = await db
    .select()
    .from(builds)
    .where(and(eq(builds.projectId, id), ne(builds.status, "queued")))
    .orderBy(desc(builds.id))
    .limit(1);
  const queued = await db
    .select()
    .from(builds)
    .where(and(eq(builds.projectId, id), eq(builds.status, "queued")))
    .orderBy(asc(builds.id));
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
  const [icon] = await db
    .select({ projectId: projectIcons.projectId })
    .from(projectIcons)
    .where(eq(projectIcons.projectId, id));
  const [passed] = await db
    .select({ id: builds.id })
    .from(builds)
    .where(and(eq(builds.projectId, id), eq(builds.status, "passed")))
    .limit(1);
  return {
    project,
    latestBuild: latestBuild ?? null,
    queued,
    changes: await builtChanges(db, id),
    hasIcon: Boolean(icon),
    hasBeenLive: Boolean(passed),
    usage: totals,
  };
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
  // A project is described by typed requests, by the interview's plan, or by both.
  const [planned] = await db
    .select({ id: planItems.id })
    .from(planItems)
    .where(eq(planItems.projectId, id))
    .limit(1);
  if (!current.features.trim() && !planned) {
    throw new ConflictError("Add at least one feature first");
  }
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

// Every decision about which of a project's builds runs (start now or queue, the queue moving on,
// editing or removing a queued change) takes this lock first, so two of them never interleave.
// It is also what keeps a project to one running build: its builds share the workspace.
const lockProject = async (tx: Db, id: number): Promise<Project> => {
  const [project] = await tx.select().from(projects).where(eq(projects.id, id)).for("update");
  if (!project) throw new NotFoundError(`Project ${id} not found`);
  return project;
};

const hasRunningBuild = async (tx: Db, projectId: number): Promise<boolean> =>
  (
    await tx
      .select({ id: builds.id })
      .from(builds)
      .where(and(eq(builds.projectId, projectId), eq(builds.status, "running")))
      .limit(1)
  ).length > 0;

// Called inside the transaction that marks the build running, so a failed start rolls it back. A
// repeated start (an activity retried after its first start went through) leaves the run alone.
const startWorkflow = async ({ workflows, taskQueue }: Deps, build: Build): Promise<void> => {
  try {
    await workflows.start<typeof buildWorkflow>("buildWorkflow", {
      taskQueue,
      workflowId: `build-${build.id}`,
      args: [build.projectId, build.id, build.kind],
    });
  } catch (error) {
    if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
  }
};

const startBuild = async (
  deps: Deps,
  tx: Db,
  id: number,
  from: readonly Status[],
  kind: Build["kind"],
  request: (project: Project) => string
): Promise<{ project: Project; build: Build }> => {
  // ponytail: builds of different projects run side by side on one worker; a task queue per tenant in production
  const project = await transition(tx, id, from, { status: "building" });
  const [build] = await tx
    .insert(builds)
    .values({ projectId: id, kind, request: request(project) })
    .returning();
  await startWorkflow(deps, build);
  return { project, build };
};

export const approveSpec = (deps: Deps, id: number) =>
  deps.db.transaction((tx) =>
    startBuild(
      deps,
      tx as unknown as Db,
      id,
      ["spec_ready"],
      "initial",
      (project) => project.spec ?? ""
    )
  );

// Starts the build now, or queues it behind the project's running build.
const startOrQueue = async (
  deps: Deps,
  tx: Db,
  project: Project,
  kind: Build["kind"],
  request: string
): Promise<{ project: Project; build: Build }> => {
  if (project.status === "building" || (await hasRunningBuild(tx, project.id))) {
    const [build] = await tx
      .insert(builds)
      .values({ projectId: project.id, kind, request, status: "queued" })
      .returning();
    return { project, build };
  }
  return startBuild(deps, tx, project.id, ["live", "failed", "stopped"], kind, () => request);
};

// On a failed or offline project a change starts now even with changes queued: it is the retry,
// and the queue follows it.
export const requestChange = (
  deps: Deps,
  input: { readonly id: number; readonly request: string }
): Promise<{ project: Project; build: Build }> =>
  deps.db.transaction(async (raw) => {
    const tx = raw as unknown as Db;
    return startOrQueue(deps, tx, await lockProject(tx, input.id), "change", input.request);
  });

export const SITE_REQUEST = "Apply the page title and icon";

// Stores the page title and icon (null removes it, undefined keeps it). A live or building app gets
// them through a `site` build, which redeploys without the agent; otherwise they are only stored,
// since every deploy applies them.
export const setSite = (
  deps: Deps,
  input: { readonly id: number; readonly title: string; readonly icon?: string | null }
): Promise<Project> =>
  deps.db.transaction(async (raw) => {
    const tx = raw as unknown as Db;
    const current = await lockProject(tx, input.id);
    const [project] = await tx
      .update(projects)
      .set({ pageTitle: input.title || null })
      .where(eq(projects.id, input.id))
      .returning();
    if (input.icon === null) {
      await tx.delete(projectIcons).where(eq(projectIcons.projectId, input.id));
    } else if (input.icon !== undefined) {
      await tx
        .insert(projectIcons)
        .values({ projectId: input.id, data: input.icon })
        .onConflictDoUpdate({ target: projectIcons.projectId, set: { data: input.icon } });
    }
    if (current.status !== "live" && current.status !== "building") return project;
    // One waiting site build applies whatever is stored when it runs, so a second is not needed.
    const [waiting] = await tx
      .select({ id: builds.id })
      .from(builds)
      .where(
        and(eq(builds.projectId, input.id), eq(builds.status, "queued"), eq(builds.kind, "site"))
      );
    if (waiting) return project;
    return (await startOrQueue(deps, tx, project, "site", SITE_REQUEST)).project;
  });

// When a build passes: starts the project's oldest queued change. Safe to repeat (an activity retry,
// or a restart replaying it): it does nothing while a build runs or the project is not live, so a
// failed or canceled build leaves the queue waiting until a later build passes.
export const startNextChange = (deps: Deps, projectId: number): Promise<Build | undefined> =>
  deps.db.transaction(async (raw) => {
    const tx = raw as unknown as Db;
    const project = await lockProject(tx, projectId);
    if (project.status !== "live" || (await hasRunningBuild(tx, projectId))) return undefined;
    const [next] = await tx
      .select({ id: builds.id })
      .from(builds)
      .where(and(eq(builds.projectId, projectId), eq(builds.status, "queued")))
      .orderBy(asc(builds.id))
      .limit(1);
    if (!next) return undefined;
    await transition(tx, projectId, ["live"], { status: "building" });
    const [build] = await tx
      .update(builds)
      .set({ status: "running", startedAt: new Date() })
      .where(eq(builds.id, next.id))
      .returning();
    await startWorkflow(deps, build);
    return build;
  });

// Changes a queued change's request or removes it; refused once it has started.
const changeQueued = async (
  db: Db,
  buildId: number,
  apply: (tx: Db) => Promise<readonly Build[]>
): Promise<Build> => {
  const { projectId } = await getBuild(db, buildId);
  return db.transaction(async (raw) => {
    const tx = raw as unknown as Db;
    await lockProject(tx, projectId);
    const [build] = await apply(tx);
    if (!build)
      throw new ConflictError("This change has already started, so it can no longer be changed");
    return build;
  });
};

export const editQueuedChange = (
  db: Db,
  input: { readonly buildId: number; readonly request: string }
): Promise<Build> =>
  changeQueued(db, input.buildId, (tx) =>
    tx
      .update(builds)
      .set({ request: input.request })
      .where(
        and(eq(builds.id, input.buildId), eq(builds.status, "queued"), eq(builds.kind, "change"))
      )
      .returning()
  );

export const removeQueuedChange = (db: Db, buildId: number): Promise<Build> =>
  changeQueued(db, buildId, (tx) =>
    tx
      .delete(builds)
      .where(and(eq(builds.id, buildId), eq(builds.status, "queued")))
      .returning()
  );

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
    await tx.delete(projectIcons).where(eq(projectIcons.projectId, id));
    await tx.delete(planItems).where(eq(planItems.projectId, id));
    await tx.delete(interviewQuestions).where(eq(interviewQuestions.projectId, id));
    await tx.delete(interviews).where(eq(interviews.projectId, id));
    await tx.delete(buildEvents).where(inArray(buildEvents.buildId, ids));
    await tx.delete(builds).where(eq(builds.projectId, id));
    await tx.delete(projects).where(eq(projects.id, id));
  });

export const ORPHANED_BUILD =
  "The Schmeide server stopped while this build ran, and the build could not be resumed. Request a change to try again.";

// At startup: a build still marked running whose workflow is gone (Temporal restarted) or ended
// without recording it would hold its project at one running build forever, queuing every change. A workflow still running resumes on its own.
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
