import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@temporalio/activity";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../../db/client.ts";
import { builds, projects } from "../../db/schema.ts";
import { appendEvent, getBuild, listEvents } from "../../services/builds.ts";
import { createProject, transition } from "../../services/projects.ts";
import { GIT_CONFIG, INTERRUPTED_NOTE, createActivities, gitConfigFile } from "../activities.ts";
import {
  MAX_ACCEPTANCE_ROUNDS,
  MAX_FIX_ATTEMPTS,
  MAX_REVIEW_ROUNDS,
  buildWorkflow,
} from "../workflows.ts";
import { DEMO_TENANT_ID } from "../../__tests__/testAuth.ts";

const db = createDb(process.env.DATABASE_URL ?? "");
let env: TestWorkflowEnvironment;
beforeAll(async () => {
  env = await TestWorkflowEnvironment.createLocal();
}, 120_000);
afterAll(async () => {
  await env?.teardown();
  await db.$client.end();
});

// A template whose `make test` fails while a file named `broken` exists, and a fake agent
// (SCHMEIDE_AGENT_CMD) that creates `broken` on its first run and removes it on run `fixOnRun`.
type Options = {
  readonly fixOnRun: number;
  readonly interruptFirstAgentRun?: boolean;
  readonly cancelDuringPrepare?: boolean;
  // Requests queued behind the build; each starts after the one before it passes.
  readonly queued?: readonly string[];
  readonly kind?: "initial" | "site" | "promote" | "discard" | "rollback";
  // Turns the design team on, with a reviewer that finds a serious problem on its first review
  // only, or on every one.
  readonly review?: "once" | "never";
  // A tester that finds a check broken the first time it follows them only, or every time.
  readonly accept?: "once" | "never";
};

const setup = (
  { fixOnRun, interruptFirstAgentRun, cancelDuringPrepare, review, accept }: Options,
  taskQueue: string
) => {
  const root = mkdtempSync(join(tmpdir(), "schmeide-wf-"));
  const dataDir = join(root, "data");
  mkdirSync(join(dataDir, "bin"), { recursive: true });
  writeFileSync(gitConfigFile(dataDir), GIT_CONFIG);
  const template = join(root, "template");
  mkdirSync(template);
  writeFileSync(
    join(template, "Makefile"),
    "check:\n\t@echo ok\ntest:\n\t@echo run $$(cat ../../runs); test ! -f broken\nbuild:\n\t@mkdir -p frontend/dist; echo '<meta name=viewport content=width=device-width><style>body{margin:0}</style>' > frontend/dist/index.html\n"
  );
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: gitConfigFile(dataDir) };
  for (const args of [
    ["init", "-q"],
    ["add", "-A"],
    ["commit", "-q", "-m", "template"],
  ]) {
    execFileSync("git", args, { cwd: template, env: gitEnv });
  }
  const runs = join(dataDir, "runs");
  const prompts = join(root, "prompts");
  const agent = join(root, "agent.sh");
  const reviews = join(root, "reviews");
  const problem = `{"severity":"serious","screen":"Notes","problem":"The list ignores the tokens.","fix":"Use them."}`;
  writeFileSync(
    agent,
    `#!/bin/sh
case "$1" in
  design) echo '{"style":"calm","reason":"Notes are personal.","screens":[]}'; exit 0;;
  review)
    r=$(( $(cat ${reviews} 2>/dev/null || echo 0) + 1 )); echo $r > ${reviews}
    if [ "${review}" = never ] || [ $r -eq 1 ]; then echo '{"problems":[${problem}]}'; else echo '{"problems":[]}'; fi
    exit 0;;
esac
n=$(( $(cat ${runs} 2>/dev/null || echo 0) + 1 )); echo $n > ${runs}
printf '%s\\n---\\n' "$AGENT_PROMPT" >> ${prompts}
if [ $n -ge ${fixOnRun} ]; then rm -f broken; else touch broken; fi
`
  );
  chmodSync(agent, 0o755);
  const deps = { db, workflows: env.client.workflow, taskQueue };
  const activities = createActivities(deps, {
    dataDir,
    template,
    agentModels: { fallback: "opus", byKind: {} },
    claudeBin: undefined,
    makeBin: "make",
    builderPlugin: join(root, "builder-plugin"),
    agentCmd: agent,
    designTeam: review !== undefined,
  });
  const runPrompts = () =>
    existsSync(prompts) ? readFileSync(prompts, "utf8").split("\n---\n").slice(0, -1) : [];
  // A server restart fails the running activity on the dying worker ("Worker is shutting down").
  const runAgent: typeof activities.runAgent = async (input) => {
    if (interruptFirstAgentRun && Context.current().info.attempt === 1) {
      throw new Error("Worker is shutting down and this activity did not complete in time");
    }
    return activities.runAgent(input);
  };
  // A slow clone: the build is canceled while it runs.
  const prepareWorkspace: typeof activities.prepareWorkspace = async (buildId) => {
    if (cancelDuringPrepare) await new Promise((resolve) => setTimeout(resolve, 2000));
    return activities.prepareWorkspace(buildId);
  };
  // Deploying needs Docker and a real app; only its effect on the project is kept. A deploy held
  // for the acceptance checks notes that it ran, and going live does the rest.
  const live = async (buildId: number) => {
    const { projectId } = await getBuild(db, buildId);
    await db.update(projects).set({ status: "live" }).where(eq(projects.id, projectId));
  };
  const deploy: typeof activities.deploy = async (buildId, options) => {
    if (options?.hold) await appendEvent(db, buildId, "deploy", "On staging");
    else await live(buildId);
  };
  const goLive: typeof activities.goLive = async (buildId) => {
    await appendEvent(db, buildId, "deploy", "Went live");
    await live(buildId);
  };
  // The tester needs a browser and a running app; it only says what `accept` has it find.
  let followed = 0;
  const checkAcceptance: typeof activities.checkAcceptance = async ({ buildId, last }) => {
    followed++;
    const broken = accept === "never" || (accept === "once" && followed === 1);
    await appendEvent(db, buildId, "check", broken ? "Tester: F1.1 is broken" : "Tester: all work");
    return broken && !last
      ? { ok: false, output: "F1.1 is broken: the picture stayed red." }
      : { ok: true, output: "" };
  };
  // Releasing needs Docker too; it only notes that it ran.
  const release = async (buildId: number) => {
    await appendEvent(db, buildId, "deploy", "Released");
  };
  return {
    activities: {
      ...activities,
      prepareWorkspace,
      runAgent,
      deploy,
      goLive,
      checkAcceptance,
      release,
    },
    runPrompts,
  };
};

const runBuild = async (options: Options) => {
  const taskQueue = `test-${randomUUID()}`;
  const { activities, runPrompts } = setup(options, taskQueue);
  const project = await createProject(db, { name: `wf ${randomUUID()}`, tenantId: DEMO_TENANT_ID });
  await transition(db, project.id, ["draft"], { status: "building", spec: "## Features\n- notes" });
  const [build] = await db
    .insert(builds)
    .values({ projectId: project.id, kind: options.kind ?? "initial", request: "spec" })
    .returning();
  const queued = await Promise.all(
    (options.queued ?? []).map(async (request) => {
      const [row] = await db
        .insert(builds)
        .values({ projectId: project.id, kind: "change", request, status: "queued" })
        .returning();
      return row;
    })
  );
  const worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue,
    workflowsPath: new URL("../workflows.ts", import.meta.url).pathname,
    activities,
  });
  const outcome = await worker.runUntil(async () => {
    const handle = await env.client.workflow.start(buildWorkflow, {
      taskQueue,
      workflowId: `build-${build.id}`,
      args: [project.id, build.id, options.kind ?? "initial"],
    });
    if (options.cancelDuringPrepare) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      await handle.cancel();
    }
    const outcome = await handle.result().then(
      () => "passed",
      () => "failed"
    );
    for (const row of outcome === "passed" ? queued : []) {
      await env.client.workflow.getHandle(`build-${row.id}`).result();
    }
    return outcome;
  });
  const events = (await listEvents(db, build.id, 0)).map((event) => event.message);
  return {
    outcome,
    build: await getBuild(db, build.id),
    queued: await Promise.all(queued.map((row) => getBuild(db, row.id))),
    prompts: runPrompts(),
    events,
  };
};

describe("buildWorkflow acceptance gate", () => {
  it("puts a build on staging, has its features checked, and only then goes live", async () => {
    const { outcome, prompts, events } = await runBuild({ fixOnRun: 1 });

    expect(outcome).toBe("passed");
    expect(prompts).toHaveLength(1);
    expect(events.filter((message) => /^(On staging|Tester|Went live)/.test(message))).toEqual([
      "On staging",
      "Tester: all work",
      "Went live",
    ]);
  }, 120_000);

  it("sends a broken check back to the builder, checks its fix, and follows the checks again", async () => {
    const { outcome, build, prompts, events } = await runBuild({ fixOnRun: 1, accept: "once" });

    expect(outcome).toBe("passed");
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("F1.1 is broken: the picture stayed red.");
    expect(
      events.filter((message) =>
        /^(On staging|Tester|Went live|Agent is fixing|make build passed)/.test(message)
      )
    ).toEqual([
      "make build passed",
      "On staging",
      "Tester: F1.1 is broken",
      "Agent is fixing features that do not work",
      "make build passed",
      "On staging",
      "Tester: all work",
      "Went live",
    ]);
    expect(build.status).toBe("passed");
  }, 120_000);

  it(`goes live after ${MAX_ACCEPTANCE_ROUNDS} fix rounds with what is still broken recorded`, async () => {
    const { outcome, prompts, events } = await runBuild({ fixOnRun: 1, accept: "never" });

    expect(outcome).toBe("passed");
    expect(prompts).toHaveLength(1 + MAX_ACCEPTANCE_ROUNDS);
    expect(events.filter((message) => message === "Tester: F1.1 is broken")).toHaveLength(
      1 + MAX_ACCEPTANCE_ROUNDS
    );
    expect(events.filter((message) => message === "Went live")).toHaveLength(1);
  }, 120_000);

  it("deploys a change of page title or icon as before, with no tester", async () => {
    const { outcome, events } = await runBuild({ fixOnRun: 1, kind: "site" });

    expect(outcome).toBe("passed");
    expect(events.filter((message) => /^(On staging|Tester|Went live)/.test(message))).toEqual([]);
  }, 120_000);
});

describe("buildWorkflow check and fix loop", () => {
  it(`feeds failing check output back to the agent and fails after ${MAX_FIX_ATTEMPTS} rounds`, async () => {
    const { outcome, build, prompts, events } = await runBuild({ fixOnRun: 99 });

    expect(outcome).toBe("failed");
    expect(prompts).toHaveLength(1 + MAX_FIX_ATTEMPTS);
    expect(prompts[0]).toContain("Build the web app");
    for (const [round, prompt] of prompts.slice(1).entries()) {
      expect(prompt).toContain("they failed");
      expect(prompt).toContain(`$ make test\nrun ${round + 1}`);
    }
    expect(events.filter((message) => message === "Agent is fixing failed checks")).toHaveLength(
      MAX_FIX_ATTEMPTS
    );
    expect(build.status).toBe("failed");
    expect(build.error).toContain(`Checks still failing after ${MAX_FIX_ATTEMPTS} fix attempts`);
    expect(build.error).toContain(`run ${1 + MAX_FIX_ATTEMPTS}`);
  }, 120_000);

  it("passes once a later fix round makes the checks pass", async () => {
    const { outcome, build, prompts, events } = await runBuild({ fixOnRun: 3 });

    expect(outcome).toBe("passed");
    expect(prompts).toHaveLength(3);
    expect(events).toEqual(expect.arrayContaining(["make test passed", "Build passed"]));
    expect(build.status).toBe("passed");
  }, 120_000);

  it("runs an interrupted agent step again, telling it to continue", async () => {
    const { outcome, prompts, events } = await runBuild({
      fixOnRun: 1,
      interruptFirstAgentRun: true,
    });

    expect(outcome).toBe("passed");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain(INTERRUPTED_NOTE);
    expect(events).toEqual(
      expect.arrayContaining(["The server restarted; the agent picks up where it stopped"])
    );
  }, 120_000);

  it("records a cancel only after the running step has stopped, and leaves the queue waiting", async () => {
    const { outcome, build, prompts, events, queued } = await runBuild({
      fixOnRun: 1,
      cancelDuringPrepare: true,
      queued: ["add due dates"],
    });

    expect(outcome).toBe("failed");
    expect(prompts).toHaveLength(0);
    expect(events).toEqual([
      "Copying the template into a fresh workspace",
      "Workspace ready",
      "Build canceled",
    ]);
    expect(build.status).toBe("canceled");
    expect(build.error).toBeNull();
    expect(queued.map((row) => row.status)).toEqual(["queued"]);
    const [project] = await db.select().from(projects).where(eq(projects.id, build.projectId));
    expect(project.status).toBe("failed");
    expect(build.finishedAt!.getTime() - build.startedAt.getTime()).toBeGreaterThanOrEqual(2000);
  }, 120_000);

  it("starts the queued changes one after another once the build passes", async () => {
    const { outcome, queued, prompts } = await runBuild({
      fixOnRun: 1,
      queued: ["add due dates", "sort by date"],
    });

    expect(outcome).toBe("passed");
    expect(queued.map((build) => build.status)).toEqual(["passed", "passed"]);
    expect(queued[0].finishedAt!.getTime()).toBeLessThanOrEqual(queued[1].startedAt.getTime());
    expect(prompts.map((prompt) => prompt.split("Change request:\n\n")[1])).toEqual([
      undefined,
      "add due dates",
      "sort by date",
    ]);
  }, 120_000);

  it("leaves queued changes waiting when the build fails", async () => {
    const { outcome, queued } = await runBuild({ fixOnRun: 99, queued: ["add due dates"] });

    expect(outcome).toBe("failed");
    expect(queued.map((build) => build.status)).toEqual(["queued"]);
  }, 120_000);

  it("gives the builder a fix round for a serious design problem, then passes", async () => {
    const { outcome, build, prompts, events } = await runBuild({ fixOnRun: 1, review: "once" });

    expect(outcome).toBe("passed");
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain("Foundation first");
    expect(prompts[1]).toContain("design review");
    expect(prompts[1]).toContain("1. [serious] Notes: The list ignores the tokens.");
    expect(events).toEqual(
      expect.arrayContaining([
        "Design: the Calm look. Notes are personal.",
        "Design review found 1 problem (1 serious)",
        "Agent is fixing design problems",
        "Design review passed",
      ])
    );
    // The fix round's work is checked again before it is reviewed again.
    expect(events.filter((message) => message === "make test passed")).toHaveLength(2);
    expect(build.status).toBe("passed");
  }, 120_000);

  it(`stops the design fix rounds at ${MAX_REVIEW_ROUNDS} and publishes with what is left`, async () => {
    const { outcome, build, prompts, events } = await runBuild({ fixOnRun: 1, review: "never" });

    expect(outcome).toBe("passed");
    expect(prompts).toHaveLength(1 + MAX_REVIEW_ROUNDS);
    expect(events.filter((message) => message === "Agent is fixing design problems")).toHaveLength(
      MAX_REVIEW_ROUNDS
    );
    expect(events).toEqual(
      expect.arrayContaining([
        `Design review still found 1 problem (1 serious) after ${MAX_REVIEW_ROUNDS} fix rounds; the app is published with them`,
        "Left for later (serious): Notes: The list ignores the tokens.",
        "Build passed",
      ])
    );
    expect(build.status).toBe("passed");
  }, 120_000);

  it("applies the page title and icon and deploys without the agent for a site build", async () => {
    const { outcome, prompts, events } = await runBuild({ fixOnRun: 1, kind: "site" });

    expect(outcome).toBe("passed");
    expect(prompts).toHaveLength(0);
    expect(events).toEqual([
      "Copying the template into a fresh workspace",
      "Workspace ready",
      "No frontend/index.html; the page title and icon were not set",
      "Build passed",
    ]);
  }, 120_000);

  it("moves a copy without the workspace or the agent for a promote, a discard, or a roll back", async () => {
    for (const kind of ["promote", "discard", "rollback"] as const) {
      const { outcome, prompts, events } = await runBuild({ fixOnRun: 1, kind });

      expect(outcome).toBe("passed");
      expect(prompts).toHaveLength(0);
      expect(events).toEqual(["Released", "Build passed"]);
    }
  }, 120_000);
});
