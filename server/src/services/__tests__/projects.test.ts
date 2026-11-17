import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createDb } from "../../db/client.ts";
import { builds, projects } from "../../db/schema.ts";
import { appendEvent, finishBuild, getBuild, listEvents, recordUsage } from "../builds.ts";
import { ConflictError, NotFoundError } from "../errors.ts";
import {
  approveSpec,
  createProject,
  deleteProject,
  deleteProjectRows,
  editQueuedChange,
  failOrphanedBuilds,
  findProject,
  getProject,
  generateSpec,
  removeQueuedChange,
  requestChange,
  setFeatures,
  setSite,
  startNextChange,
  slugify,
  stopProject,
  suggestName,
  testDbPort,
  transition,
  type Deps,
} from "../projects.ts";
import { planItemsOf } from "../interview.ts";
import { DEMO_TENANT_ID } from "../../__tests__/testAuth.ts";

// Tests share one database, so they assert only on rows they created.
const db = createDb(process.env.DATABASE_URL ?? "");
afterAll(() => db.$client.end());

const fakeWorkflows = () => {
  const cancel = vi.fn(async () => undefined);
  const workflows = {
    start: vi.fn(async () => ({ result: async () => undefined }) as never),
    getHandle: vi.fn(() => ({ cancel }) as never),
  } satisfies Deps["workflows"];
  return { deps: { db, workflows, taskQueue: "test" } satisfies Deps, workflows, cancel };
};

const startArgs = (workflows: ReturnType<typeof fakeWorkflows>["workflows"]) =>
  workflows.start.mock.calls.map((call: readonly unknown[]) => call[0]);

const specReady = async () => {
  const project = await createProject(db, { name: `p ${randomUUID()}`, tenantId: DEMO_TENANT_ID });
  await setFeatures(db, { id: project.id, features: "a list of to-dos" });
  return transition(db, project.id, ["draft"], { status: "spec_ready", spec: "## Features" });
};

describe("slugify", () => {
  it.each([
    ["Invoice Tracker", "invoice-tracker"],
    ["  Hello, World!  ", "hello-world"],
    ["Ünïcode Café", "unicode-cafe"],
    ["!!!", "project"],
    ["x".repeat(60), "x".repeat(40)],
  ])("turns %j into %j", (name, slug) => {
    expect(slugify(name)).toBe(slug);
  });
});

describe("createProject", () => {
  it("gives repeated names distinct slugs and each project its own ports", async () => {
    const name = `Same ${randomUUID()}`;

    const first = await createProject(db, { name, tenantId: DEMO_TENANT_ID });
    const second = await createProject(db, { name, tenantId: DEMO_TENANT_ID });

    expect(first.slug).toBe(slugify(name));
    expect(second.slug).toBe(`${slugify(name)}-2`);
    expect(first.status).toBe("draft");
    expect(second.webPort).toBeGreaterThan(first.webPort);
    expect(first.webPort).toBeGreaterThanOrEqual(8100);
    expect(testDbPort(first)).toBe(5600 + first.webPort - 8100);
  });

  it("survives concurrent creates racing for the same slug and port", async () => {
    const name = `Race ${randomUUID()}`;

    const created = await Promise.all(
      Array.from({ length: 4 }, () => createProject(db, { name, tenantId: DEMO_TENANT_ID }))
    );

    expect(new Set(created.map((project) => project.slug)).size).toBe(4);
    expect(new Set(created.map((project) => project.webPort)).size).toBe(4);
  });
});

describe("suggestName", () => {
  it.each([
    ["I need to send invoices to my clients and see who has paid.", "Send invoices to my clients"],
    ["i want a way to track jobs", "Track jobs"],
    ["We need an app for booking appointments. It should text people.", "Booking appointments"],
    ["Stock list", "Stock list"],
    ["   ", "My app"],
    [
      "Keep a record of every delivery we make to every wholesale customer each week",
      "Keep a record of every delivery we make",
    ],
  ])("names %j %j", (need, name) => {
    expect(suggestName(need)).toBe(name);
  });
});

describe("createProject from a first answer", () => {
  it("keeps what the person said they need and names the app from it", async () => {
    const need = `I need to track jobs ${randomUUID()}`;

    const project = await createProject(db, { need, tenantId: DEMO_TENANT_ID });

    expect(project.need).toBe(need);
    expect(project.name).toMatch(/^Track jobs/);
    expect(project.features).toBe("");
  });

  it("uses a name that came with the answer", async () => {
    const project = await createProject(db, {
      need: "Send invoices and see who has paid",
      name: "Invoices",
      tenantId: DEMO_TENANT_ID,
    });

    expect(project.name).toBe("Invoices");
    expect(project.need).toBe("Send invoices and see who has paid");
  });
});

describe("createProject from what the person has today", () => {
  it("writes the answers down for the interview and starts the plan with what it replaces", async () => {
    const project = await createProject(db, {
      name: "In place of a spreadsheet",
      today: {
        uses: ["A spreadsheet", "Paper"],
        keep: "The monthly totals",
        fix: "I can never see who has paid",
      },
      tenantId: DEMO_TENANT_ID,
    });

    expect(project.need).toBe(
      [
        "They already have something that does this job today. They want it kept, improved, or replaced without losing anything.",
        "What they use today: A spreadsheet; Paper",
        "What works well and must not change: The monthly totals",
        "What gets in their way today: I can never see who has paid",
      ].join("\n")
    );
    const items = await planItemsOf(db, project.id);
    expect(items.map((item) => [item.section, item.text, item.source, item.phase])).toEqual([
      ["replaces", "A spreadsheet", "you", "day_one"],
      ["replaces", "Paper", "you", "day_one"],
    ]);
  });

  it("says when what must stay was left to Schmeide, and names the app from what gets in the way", async () => {
    const project = await createProject(db, {
      today: { uses: ["A product I pay for"], keepDecided: true, fix: "It costs too much" },
      tenantId: DEMO_TENANT_ID,
    });

    expect(project.need).toContain("What must not change: left for you to decide");
    expect(project.name).toBe("It costs too much");
  });
});

describe("getProject", () => {
  it("reports zero usage and no build for a new project", async () => {
    const project = await createProject(db, {
      name: `g ${randomUUID()}`,
      tenantId: DEMO_TENANT_ID,
    });

    const detail = await getProject(db, project.id);

    expect(detail.latestBuild).toBeNull();
    expect(detail.hasBeenLive).toBe(false);
    expect(detail.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0,
    });
  });
});

describe("getProject changes", () => {
  it("lists the changes built since the first build, oldest first", async () => {
    const project = await createProject(db, {
      name: `c ${randomUUID()}`,
      tenantId: DEMO_TENANT_ID,
    });
    await db.insert(builds).values([
      { projectId: project.id, kind: "initial", request: "spec", status: "passed" },
      { projectId: project.id, kind: "change", request: "add due dates", status: "passed" },
      { projectId: project.id, kind: "change", request: "broke", status: "failed" },
      { projectId: project.id, kind: "site", request: "icon", status: "passed" },
      { projectId: project.id, kind: "change", request: "email invoices", status: "passed" },
      { projectId: project.id, kind: "change", request: "waiting", status: "queued" },
    ]);

    const { changes } = await getProject(db, project.id);

    expect(changes.map((change) => change.request)).toEqual(["add due dates", "email invoices"]);
  });
});

describe("project state machine", () => {
  it("generates a spec only from features", async () => {
    const { deps, workflows } = fakeWorkflows();
    const project = await createProject(db, {
      name: `p ${randomUUID()}`,
      tenantId: DEMO_TENANT_ID,
    });

    await expect(generateSpec(deps, project.id)).rejects.toBeInstanceOf(ConflictError);
    await setFeatures(db, { id: project.id, features: "a list of to-dos" });
    const generating = await generateSpec(deps, project.id);

    expect(generating.status).toBe("spec_generating");
    expect(startArgs(workflows)).toEqual(["specWorkflow"]);
    await expect(
      setFeatures(db, { id: project.id, features: "changed my mind" })
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("editing features after the spec drops the spec", async () => {
    const project = await specReady();

    const edited = await setFeatures(db, { id: project.id, features: "something else" });

    expect(edited).toMatchObject({ status: "draft", spec: null, features: "something else" });
  });

  it("approves only a ready spec, starts a build, and lets other projects build too", async () => {
    const { deps, workflows } = fakeWorkflows();
    const draft = await createProject(db, { name: `p ${randomUUID()}`, tenantId: DEMO_TENANT_ID });
    await expect(approveSpec(deps, draft.id)).rejects.toBeInstanceOf(ConflictError);

    const ready = await specReady();
    const other = await specReady();
    const { project, build } = await approveSpec(deps, ready.id);
    const second = await approveSpec(deps, other.id);
    try {
      expect(project.status).toBe("building");
      expect(build).toMatchObject({ kind: "initial", status: "running", request: "## Features" });
      expect(workflows.start).toHaveBeenCalledWith(
        "buildWorkflow",
        expect.objectContaining({
          workflowId: `build-${build.id}`,
          args: [ready.id, build.id, "initial"],
        })
      );
      expect(second.build.status).toBe("running");
    } finally {
      await finishBuild(db, build.id);
      await finishBuild(db, second.build.id);
    }
  });

  it("takes change requests on live, failed, and stopped projects only", async () => {
    const { deps } = fakeWorkflows();
    const ready = await specReady();
    await expect(
      requestChange(deps, { id: ready.id, request: "add due dates" })
    ).rejects.toBeInstanceOf(ConflictError);

    await transition(db, ready.id, ["spec_ready"], { status: "live" });
    const { build } = await requestChange(deps, { id: ready.id, request: "add due dates" });
    await finishBuild(db, build.id);

    expect(build).toMatchObject({ kind: "change", request: "add due dates" });
  });

  it("stop cancels a running build, or takes a deployment down", async () => {
    const { deps, workflows, cancel } = fakeWorkflows();
    const ready = await specReady();
    const { build } = await approveSpec(deps, ready.id);
    try {
      await stopProject(deps, ready.id);
      expect(workflows.getHandle).toHaveBeenCalledWith(`build-${build.id}`);
      expect(cancel).toHaveBeenCalled();
    } finally {
      await finishBuild(db, build.id);
    }

    await transition(db, ready.id, ["building"], { status: "live" });
    await stopProject(deps, ready.id);
    expect(startArgs(workflows)).toContain("stopWorkflow");

    const draft = await createProject(db, { name: `p ${randomUUID()}`, tenantId: DEMO_TENANT_ID });
    await expect(stopProject(deps, draft.id)).rejects.toBeInstanceOf(ConflictError);
  });
});

describe("the change queue", () => {
  // A project whose build is running, as after approving its spec.
  const building = async () => {
    const fake = fakeWorkflows();
    const { project, build } = await approveSpec(fake.deps, (await specReady()).id);
    return { ...fake, project, build };
  };
  const pass = async (buildId: number, projectId: number) => {
    await finishBuild(db, buildId);
    await db.update(projects).set({ status: "live" }).where(eq(projects.id, projectId));
  };

  it("queues changes behind the running build and starts them oldest first after each pass", async () => {
    const { deps, workflows, project, build } = await building();

    const first = await requestChange(deps, { id: project.id, request: "first" });
    const second = await requestChange(deps, { id: project.id, request: "second" });

    expect([first.build.status, second.build.status]).toEqual(["queued", "queued"]);
    expect(workflows.start).toHaveBeenCalledTimes(1);
    const detail = await getProject(db, project.id);
    expect(detail.latestBuild?.id).toBe(build.id);
    expect(detail.queued.map((queued) => queued.request)).toEqual(["first", "second"]);

    expect(detail.hasBeenLive).toBe(false);

    await pass(build.id, project.id);
    expect((await getProject(db, project.id)).hasBeenLive).toBe(true);
    expect((await startNextChange(deps, project.id))?.id).toBe(first.build.id);
    // Repeating it (an activity retry) does not start the second while the first runs.
    expect(await startNextChange(deps, project.id)).toBeUndefined();
    expect((await getBuild(db, first.build.id)).status).toBe("running");
    expect((await getBuild(db, second.build.id)).status).toBe("queued");
    expect((await findProject(db, project.id)).status).toBe("building");
    expect(workflows.start).toHaveBeenLastCalledWith(
      "buildWorkflow",
      expect.objectContaining({ workflowId: `build-${first.build.id}` })
    );

    await pass(first.build.id, project.id);
    expect((await startNextChange(deps, project.id))?.id).toBe(second.build.id);
    await pass(second.build.id, project.id);
    expect(await startNextChange(deps, project.id)).toBeUndefined();
  });

  it("starts at most one of many changes requested at once", async () => {
    const { deps } = fakeWorkflows();
    const ready = await specReady();
    await transition(db, ready.id, ["spec_ready"], { status: "live" });

    const results = await Promise.all(
      ["a", "b", "c", "d"].map((request) => requestChange(deps, { id: ready.id, request }))
    );

    expect(results.map((result) => result.build.status).sort()).toEqual([
      "queued",
      "queued",
      "queued",
      "running",
    ]);
    for (const { build } of results) await finishBuild(db, build.id);
  });

  it("starts at most one change when the queue is moved on twice at once", async () => {
    const { deps, project, build } = await building();
    await requestChange(deps, { id: project.id, request: "a" });
    await requestChange(deps, { id: project.id, request: "b" });
    await pass(build.id, project.id);

    const started = await Promise.all([
      startNextChange(deps, project.id),
      startNextChange(deps, project.id),
    ]);

    expect(started.filter(Boolean)).toHaveLength(1);
    await finishBuild(db, started.find(Boolean)!.id);
  });

  it("leaves the queue waiting after a failed or canceled build", async () => {
    const { deps, project, build } = await building();
    const queued = await requestChange(deps, { id: project.id, request: "later" });
    await finishBuild(db, build.id, "Build canceled");
    await transition(db, project.id, ["building"], { status: "failed" });

    expect(await startNextChange(deps, project.id)).toBeUndefined();
    expect((await getBuild(db, queued.build.id)).status).toBe("queued");

    // A new change on the failed project is the retry: it starts now, ahead of the queue.
    const retry = await requestChange(deps, { id: project.id, request: "try again" });
    expect(retry.build.status).toBe("running");
    await pass(retry.build.id, project.id);
    expect((await startNextChange(deps, project.id))?.id).toBe(queued.build.id);
    await finishBuild(db, queued.build.id);
  });

  it("edits and removes a queued change, and refuses once it has started", async () => {
    const { deps, project, build } = await building();
    const kept = await requestChange(deps, { id: project.id, request: "tpyo" });
    const dropped = await requestChange(deps, { id: project.id, request: "never mind" });

    expect((await editQueuedChange(db, { buildId: kept.build.id, request: "typo" })).request).toBe(
      "typo"
    );
    await removeQueuedChange(db, dropped.build.id);
    expect((await getProject(db, project.id)).queued.map((queued) => queued.request)).toEqual([
      "typo",
    ]);

    await expect(editQueuedChange(db, { buildId: build.id, request: "x" })).rejects.toBeInstanceOf(
      ConflictError
    );
    await expect(removeQueuedChange(db, build.id)).rejects.toBeInstanceOf(ConflictError);
    await expect(removeQueuedChange(db, dropped.build.id)).rejects.toBeInstanceOf(NotFoundError);
    expect((await getBuild(db, build.id)).request).toBe("## Features");
    await finishBuild(db, build.id);
  });
});

describe("setSite", () => {
  const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").toString("base64");

  it("only stores the title and icon before the first build", async () => {
    const { deps, workflows } = fakeWorkflows();
    const ready = await specReady();

    const project = await setSite(deps, { id: ready.id, title: "My invoices", icon: PNG });

    expect(project.pageTitle).toBe("My invoices");
    expect((await getProject(db, ready.id)).hasIcon).toBe(true);
    expect(workflows.start).not.toHaveBeenCalled();

    await setSite(deps, { id: ready.id, title: "", icon: null });
    const detail = await getProject(db, ready.id);
    expect(detail.project.pageTitle).toBeNull();
    expect(detail.hasIcon).toBe(false);
  });

  it("redeploys a live app without the agent, and waits behind a running build", async () => {
    const { deps, workflows } = fakeWorkflows();
    const ready = await specReady();
    await transition(db, ready.id, ["spec_ready"], { status: "live" });

    await setSite(deps, { id: ready.id, title: "Mine" });
    const { latestBuild } = await getProject(db, ready.id);
    expect(latestBuild).toMatchObject({ kind: "site", status: "running" });
    expect(workflows.start).toHaveBeenLastCalledWith(
      "buildWorkflow",
      expect.objectContaining({ args: [ready.id, latestBuild!.id, "site"] })
    );

    // While it runs, one more site build waits; saving again does not add another.
    await setSite(deps, { id: ready.id, title: "Mine 2" });
    await setSite(deps, { id: ready.id, title: "Mine 3", icon: PNG });
    const { queued } = await getProject(db, ready.id);
    expect(queued.map((build) => build.kind)).toEqual(["site"]);
    expect(workflows.start).toHaveBeenCalledTimes(1);
    await expect(
      editQueuedChange(db, { buildId: queued[0].id, request: "something" })
    ).rejects.toBeInstanceOf(ConflictError);
    await finishBuild(db, latestBuild!.id);
    await removeQueuedChange(db, queued[0].id);
  });
});

describe("deleting a project", () => {
  it("is refused while a build runs and goes through the delete workflow otherwise", async () => {
    const { deps, workflows } = fakeWorkflows();
    const ready = await specReady();
    const { build } = await approveSpec(deps, ready.id);
    try {
      await expect(deleteProject(deps, ready.id)).rejects.toBeInstanceOf(ConflictError);
    } finally {
      await finishBuild(db, build.id);
    }
    await transition(db, ready.id, ["building"], { status: "failed" });

    await deleteProject(deps, ready.id);

    expect(startArgs(workflows)).toContain("deleteWorkflow");
  });

  it("removes the project with its builds, events, and usage", async () => {
    const { deps } = fakeWorkflows();
    const ready = await specReady();
    const { build } = await approveSpec(deps, ready.id);
    await finishBuild(db, build.id);
    await appendEvent(db, build.id, "step", "hello");
    await recordUsage(db, [
      {
        projectId: ready.id,
        buildId: build.id,
        runKind: "initial",
        model: "m",
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0,
      },
    ]);

    await deleteProjectRows(db, ready.id);

    await expect(findProject(db, ready.id)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("failOrphanedBuilds", () => {
  it("fails running builds whose workflow is gone and leaves live workflows alone", async () => {
    const { deps } = fakeWorkflows();
    const orphan = await approveSpec(deps, (await specReady()).id);
    await finishBuild(db, orphan.build.id);
    const alive = await approveSpec(deps, (await specReady()).id);
    await db.update(builds).set({ status: "running" }).where(eq(builds.id, orphan.build.id));
    const workflows = {
      ...deps.workflows,
      // Every other workflow (other test files share the database) reports as running.
      getHandle: vi.fn((id: string) => ({
        describe: async () => {
          if (id === `build-${orphan.build.id}`) throw new Error("workflow not found");
          return { status: { name: "RUNNING" } };
        },
      })) as never,
    };
    try {
      await failOrphanedBuilds({ ...deps, workflows });

      const failed = await getBuild(db, orphan.build.id);
      expect(failed.status).toBe("failed");
      expect(failed.error).toMatch(/server stopped/);
      expect((await findProject(db, orphan.project.id)).status).toBe("failed");
      expect((await listEvents(db, orphan.build.id, 0)).at(-1)?.message).toMatch(/server stopped/);
      expect((await getBuild(db, alive.build.id)).status).toBe("running");
      expect((await findProject(db, alive.project.id)).status).toBe("building");
    } finally {
      await finishBuild(db, alive.build.id);
    }
  });
});
