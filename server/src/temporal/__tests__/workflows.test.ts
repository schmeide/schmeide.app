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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../../db/client.ts";
import { builds } from "../../db/schema.ts";
import { getBuild, listEvents } from "../../services/builds.ts";
import { createProject, transition } from "../../services/projects.ts";
import { GIT_CONFIG, INTERRUPTED_NOTE, createActivities, gitConfigFile } from "../activities.ts";
import { MAX_FIX_ATTEMPTS, buildWorkflow } from "../workflows.ts";

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
};

const setup = ({ fixOnRun, interruptFirstAgentRun, cancelDuringPrepare }: Options) => {
  const root = mkdtempSync(join(tmpdir(), "schmeide-wf-"));
  const dataDir = join(root, "data");
  mkdirSync(join(dataDir, "bin"), { recursive: true });
  writeFileSync(gitConfigFile(dataDir), GIT_CONFIG);
  const template = join(root, "template");
  mkdirSync(template);
  writeFileSync(
    join(template, "Makefile"),
    "check:\n\t@echo ok\ntest:\n\t@echo run $$(cat ../../runs); test ! -f broken\nbuild:\n\t@echo ok\n"
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
  writeFileSync(
    agent,
    `#!/bin/sh
n=$(( $(cat ${runs} 2>/dev/null || echo 0) + 1 )); echo $n > ${runs}
printf '%s\\n---\\n' "$AGENT_PROMPT" >> ${prompts}
if [ $n -ge ${fixOnRun} ]; then rm -f broken; else touch broken; fi
`
  );
  chmodSync(agent, 0o755);
  const activities = createActivities(db, {
    dataDir,
    template,
    agentModel: "opus",
    claudeBin: undefined,
    makeBin: "make",
    agentCmd: agent,
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
  // Deploying needs Docker and a real app.
  const deploy = async () => undefined;
  return { activities: { ...activities, prepareWorkspace, runAgent, deploy }, runPrompts };
};

const runBuild = async (options: Options) => {
  const { activities, runPrompts } = setup(options);
  const project = await createProject(db, { name: `wf ${randomUUID()}` });
  await transition(db, project.id, ["draft"], { status: "building", spec: "## Features\n- notes" });
  const [build] = await db
    .insert(builds)
    .values({ projectId: project.id, kind: "initial", request: "spec" })
    .returning();
  const taskQueue = `test-${randomUUID()}`;
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
      args: [project.id, build.id],
    });
    if (options.cancelDuringPrepare) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      await handle.cancel();
    }
    return handle.result().then(
      () => "passed",
      () => "failed"
    );
  });
  const events = (await listEvents(db, build.id, 0)).map((event) => event.message);
  return { outcome, build: await getBuild(db, build.id), prompts: runPrompts(), events };
};

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

  it("records a cancel only after the running step has stopped", async () => {
    const { outcome, build, prompts, events } = await runBuild({
      fixOnRun: 1,
      cancelDuringPrepare: true,
    });

    expect(outcome).toBe("failed");
    expect(prompts).toHaveLength(0);
    expect(events).toEqual([
      "Copying the template into a fresh workspace",
      "Workspace ready",
      "Build canceled",
    ]);
    expect(build.error).toBe("Build canceled");
    expect(build.finishedAt!.getTime() - build.startedAt.getTime()).toBeGreaterThanOrEqual(2000);
  }, 120_000);
});
