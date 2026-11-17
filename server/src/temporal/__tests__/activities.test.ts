import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { MockActivityEnvironment } from "@temporalio/testing";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { createDb } from "../../db/client.ts";
import { builds, projectIcons, projects, usage } from "../../db/schema.ts";
import { listEvents } from "../../services/builds.ts";
import { createProject, transition } from "../../services/projects.ts";
import {
  AGENT_ALLOWED_TOOLS,
  GIT_CONFIG,
  buildPrompt,
  createActivities,
  gitConfigFile,
  specPrompt,
  type Config,
  type Query,
} from "../activities.ts";
import { DEMO_TENANT_ID } from "../../__tests__/testAuth.ts";

const db = createDb(process.env.DATABASE_URL ?? "");
afterAll(() => db.$client.end());
// These activities never start a workflow.
const deps = { db, workflows: {} as never, taskQueue: "test" };

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    env: { ...process.env, GIT_CONFIG_GLOBAL: gitConfigFile(join(cwd, "..")) },
  }).toString();

// A data dir plus a one-commit template repository beside it.
const setup = () => {
  const root = mkdtempSync(join(tmpdir(), "schmeide-test-"));
  const dataDir = join(root, "data");
  mkdirSync(join(dataDir, "bin"), { recursive: true });
  writeFileSync(gitConfigFile(dataDir), GIT_CONFIG);
  writeFileSync(gitConfigFile(root), GIT_CONFIG);
  const template = join(root, "template");
  mkdirSync(template);
  writeFileSync(join(template, "AGENTS.md"), "# rules\n");
  mkdirSync(join(template, "frontend"));
  writeFileSync(
    join(template, "frontend", "index.html"),
    "<html>\n  <head>\n    <title>Notes</title>\n  </head>\n</html>\n"
  );
  writeFileSync(
    join(template, "Makefile"),
    [
      "check:\n\t@echo checking on $$WEB_PORT",
      "test:\n\t@echo test db $$TEST_DB_PORT; test ! -f broken",
      "build:\n\t@echo building",
      "up:\n\t@echo up $$COMPOSE_PROJECT_NAME",
      "",
    ].join("\n")
  );
  git(template, "init", "-q");
  git(template, "add", "-A");
  git(template, "commit", "-q", "-m", "template");
  const config: Config = {
    dataDir,
    template,
    agentModels: { fallback: "opus", byKind: {} },
    claudeBin: undefined,
    makeBin: "make",
  };
  return { config, dataDir };
};

const newBuild = async (kind: "initial" | "change" = "initial") => {
  const project = await createProject(db, { name: `a ${randomUUID()}`, tenantId: DEMO_TENANT_ID });
  await transition(db, project.id, ["draft"], { status: "building", spec: "## Features\n- notes" });
  const [build] = await db
    .insert(builds)
    .values({ projectId: project.id, kind, request: "spec", status: "passed" })
    .returning();
  return { project, build };
};

const messages = (buildId: number) =>
  listEvents(db, buildId, 0).then((events) => events.map((event) => event.message));

// Stands in for the Claude Agent SDK: edits a file in the workspace and reports usage.
const fakeQuery = (calls: { prompt: string; options: Options }[], fail = false): Query =>
  ((params: { prompt: string; options: Options }) => {
    calls.push(params);
    return (async function* (): AsyncGenerator<SDKMessage> {
      yield { type: "system", subtype: "init", model: "claude-test" } as SDKMessage;
      writeFileSync(join(params.options.cwd ?? "", "todos.ts"), "export const todos = [];\n");
      yield {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Writing the to-do service." },
            { type: "tool_use", id: "1", name: "Bash", input: { command: "make test" } },
            {
              type: "tool_use",
              id: "2",
              name: "Edit",
              input: { file_path: join(params.options.cwd ?? "", "todos.ts") },
            },
          ],
        },
      } as SDKMessage;
      yield {
        type: "result",
        subtype: fail ? "error_max_turns" : "success",
        is_error: fail,
        num_turns: 3,
        total_cost_usd: 0.5,
        session_id: "session-1",
        result: "## Features\n- notes",
        permission_denials: [],
        modelUsage: {
          "claude-test": {
            inputTokens: 10,
            outputTokens: 20,
            cacheReadInputTokens: 30,
            cacheCreationInputTokens: 40,
            costUSD: 0.5,
          },
        },
      } as unknown as SDKMessage;
    })();
  }) as unknown as Query;

describe("specPrompt", () => {
  it("writes from the typed requests when there is no plan", () => {
    const prompt = specPrompt("Keep a list of clients", "");

    expect(prompt).toContain("with these features, one per line:\n\nKeep a list of clients");
    expect(prompt).not.toContain("wanted later");
  });

  it("leads with the plan, adds the typed requests, and leaves out what was put off", () => {
    const prompt = specPrompt("Keep a list of clients", "What it does:\n- Create an invoice");

    expect(prompt).toContain("the plan they agreed");
    expect(prompt).toContain("What it does:\n- Create an invoice");
    expect(prompt).toContain("in their own words, one per line:\n\nKeep a list of clients");
    expect(prompt).toContain("Leave out everything listed as wanted later.");
    expect(specPrompt("", "What it does:\n- Create an invoice")).not.toContain("own words");
  });
});

describe("buildPrompt", () => {
  it("gives a change the first spec and every change built since, oldest first", () => {
    const prompt = buildPrompt("change", "## Features\n- Invoices", "Add a due date", [
      "Add client phone numbers",
      "Send invoices by email",
    ]);

    expect(prompt).toContain("Spec the app was first built from");
    expect(prompt).toMatch(
      /Changes built since then, oldest first[^]*1\. Add client phone numbers\n2\. Send invoices by email[^]*Change request:\n\nAdd a due date/
    );
  });

  it("says nothing about earlier changes when this is the first one", () => {
    expect(buildPrompt("change", "## Features", "Add a due date", [])).not.toContain(
      "Changes built since"
    );
  });
});

describe("build activities", () => {
  it("prepares a fresh one-commit workspace from the template, then reuses it", async () => {
    const { config, dataDir } = setup();
    const { project, build } = await newBuild();
    const activities = createActivities(deps, config);
    const env = new MockActivityEnvironment();

    await env.run(activities.prepareWorkspace, build.id);
    await env.run(activities.prepareWorkspace, build.id);

    const workspace = join(dataDir, "projects", project.slug);
    expect(existsSync(join(workspace, "AGENTS.md"))).toBe(true);
    expect(git(workspace, "log", "--oneline").trim().split("\n")).toHaveLength(1);
    expect(git(workspace, "log", "-1", "--format=%an").trim()).toBe("Schmeide");
    expect(await messages(build.id)).toEqual([
      "Copying the template into a fresh workspace",
      "Workspace ready",
      "Reusing the project workspace",
    ]);
  });

  it("runs the agent in the workspace with the allowlist and records its usage", async () => {
    const { config, dataDir } = setup();
    const { project, build } = await newBuild();
    const calls: { prompt: string; options: Options }[] = [];
    const activities = createActivities(deps, config, fakeQuery(calls));
    const env = new MockActivityEnvironment();
    await env.run(activities.prepareWorkspace, build.id);

    const session = await env.run(activities.runAgent, { buildId: build.id });

    const workspace = join(dataDir, "projects", project.slug);
    expect(session).toBe("session-1");
    expect(readFileSync(join(workspace, "todos.ts"), "utf8")).toContain("todos");
    expect(calls[0].prompt).toContain("## Features\n- notes");
    expect(calls[0].options).toMatchObject({
      cwd: workspace,
      model: "opus",
      permissionMode: "dontAsk",
      settingSources: ["project"],
      tools: expect.arrayContaining(["Skill"]),
      allowedTools: AGENT_ALLOWED_TOOLS,
      env: expect.objectContaining({
        WEB_PORT: String(project.webPort),
        COMPOSE_PROJECT_NAME: `schmeide-${project.slug}`,
      }),
    });
    expect(AGENT_ALLOWED_TOOLS).toContain("Skill");
    expect(calls[0].options.env?.DATABASE_URL).toBeUndefined();
    expect(await messages(build.id)).toEqual(
      expect.arrayContaining([
        "Model opus for this initial run (SCHMEIDE_AGENT_MODEL fallback, SCHMEIDE_AGENT_MODEL_INITIAL is not set)",
        "Agent started (claude-test)",
        "Writing the to-do service.",
        "Editing todos.ts",
        "$ make test",
      ])
    );
    expect(await db.select().from(usage).where(eq(usage.buildId, build.id))).toEqual([
      expect.objectContaining({
        runKind: "initial",
        model: "claude-test",
        inputTokens: 10,
        costUsd: 0.5,
      }),
    ]);
  });

  it("routes spec, initial, and change runs to their own models and labels their usage", async () => {
    const { config } = setup();
    const routed: Config = {
      ...config,
      agentModels: {
        fallback: "opus",
        byKind: { spec: "haiku", initial: "fable", change: "sonnet" },
      },
    };
    const calls: { prompt: string; options: Options }[] = [];
    const activities = createActivities(deps, routed, fakeQuery(calls));
    const env = new MockActivityEnvironment();
    const initial = await newBuild("initial");
    const change = await newBuild("change");
    const drafted = await createProject(db, {
      name: `a ${randomUUID()}`,
      tenantId: DEMO_TENANT_ID,
    });
    await transition(db, drafted.id, ["draft"], { status: "spec_generating" });

    await env.run(activities.generateSpec, drafted.id);
    for (const { build } of [initial, change]) {
      await env.run(activities.prepareWorkspace, build.id);
      await env.run(activities.runAgent, { buildId: build.id });
    }
    // A fix-up run resumes the build's session on the same model.
    await env.run(activities.runAgent, {
      buildId: change.build.id,
      resume: "session-1",
      feedback: "make test failed",
    });

    expect(calls.map((call) => call.options.model)).toEqual(["haiku", "fable", "sonnet", "sonnet"]);
    expect(await messages(change.build.id)).toContain(
      "Model sonnet for this change run (SCHMEIDE_AGENT_MODEL_CHANGE routes change runs)"
    );
    const kindsOf = async (projectId: number) =>
      (await db.select().from(usage).where(eq(usage.projectId, projectId))).map(
        (row) => row.runKind
      );
    expect(await kindsOf(drafted.id)).toEqual(["spec"]);
    expect(await kindsOf(initial.project.id)).toEqual(["initial"]);
    expect(await kindsOf(change.project.id)).toEqual(["change", "change"]);
  });

  it("tells the agent about the changes already built, and not about failed or waiting ones", async () => {
    const { config } = setup();
    const { project } = await newBuild();
    const rows = await db
      .insert(builds)
      .values([
        { projectId: project.id, kind: "change", request: "built one", status: "passed" },
        { projectId: project.id, kind: "change", request: "broke", status: "failed" },
        { projectId: project.id, kind: "site", request: "page icon", status: "passed" },
        { projectId: project.id, kind: "change", request: "built two", status: "passed" },
        { projectId: project.id, kind: "change", request: "this one", status: "running" },
        { projectId: project.id, kind: "change", request: "waiting", status: "queued" },
      ])
      .returning();
    const current = rows[4];
    const calls: { prompt: string; options: Options }[] = [];
    const activities = createActivities(deps, config, fakeQuery(calls));
    const env = new MockActivityEnvironment();
    await env.run(activities.prepareWorkspace, current.id);

    await env.run(activities.runAgent, { buildId: current.id });

    expect(calls[0].prompt).toContain("1. built one\n2. built two");
    expect(calls[0].prompt).toContain("Change request:\n\nthis one");
    expect(calls[0].prompt).not.toMatch(/broke|waiting|page icon/);
  });

  it("fails the activity when the agent run does not succeed", async () => {
    const { config } = setup();
    const { build } = await newBuild();
    const activities = createActivities(deps, config, fakeQuery([], true));
    const env = new MockActivityEnvironment();
    await env.run(activities.prepareWorkspace, build.id);

    await expect(env.run(activities.runAgent, { buildId: build.id })).rejects.toThrow(
      /error_max_turns/
    );
  });

  it("runs check, test, and build with the project's ports and reports the first failure", async () => {
    const { config, dataDir } = setup();
    const { project, build } = await newBuild();
    const activities = createActivities(deps, config);
    const env = new MockActivityEnvironment();
    await env.run(activities.prepareWorkspace, build.id);

    const passing = await env.run(activities.runChecks, build.id);
    writeFileSync(join(dataDir, "projects", project.slug, "broken"), "");
    const failing = (await env.run(activities.runChecks, build.id)) as Awaited<
      ReturnType<typeof activities.runChecks>
    >;

    expect(passing).toEqual({ ok: true, output: "" });
    expect(failing.ok).toBe(false);
    expect(failing.output).toContain(`test db ${5600 + project.webPort - 8100}`);
    expect(await messages(build.id)).toEqual(
      expect.arrayContaining(["make check passed", "make test failed (exit 2)"])
    );
  });

  it("writes the page title and icon into the app and commits them, and takes the icon away again", async () => {
    const { config, dataDir } = setup();
    const { project, build } = await newBuild();
    const activities = createActivities(deps, config);
    const env = new MockActivityEnvironment();
    await env.run(activities.prepareWorkspace, build.id);
    const workspace = join(dataDir, "projects", project.slug);
    const index = () => readFileSync(join(workspace, "frontend", "index.html"), "utf8");
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
    await db
      .update(projects)
      .set({ pageTitle: "Tom & Jerry's <b>" })
      .where(eq(projects.id, project.id));
    await db.insert(projectIcons).values({ projectId: project.id, data: png.toString("base64") });

    await env.run(activities.applySite, build.id);
    await env.run(activities.applySite, build.id);

    expect(index()).toContain("<title>Tom &amp; Jerry&#39;s &lt;b&gt;</title>");
    expect(index()).toContain('<link rel="icon" type="image/png" href="/site-icon.png" />');
    expect(readFileSync(join(workspace, "frontend", "public", "site-icon.png"))).toEqual(png);
    // Applying the same values again commits nothing.
    expect(git(workspace, "log", "--format=%s").trim().split("\n")).toEqual([
      "set the page title and icon",
      "start from the schmeide template",
    ]);
    expect(git(workspace, "status", "--porcelain")).toBe("");

    await db.delete(projectIcons).where(eq(projectIcons.projectId, project.id));
    await db.update(projects).set({ pageTitle: null }).where(eq(projects.id, project.id));
    await env.run(activities.applySite, build.id);

    expect(index()).toBe(
      `<html>\n  <head>\n    <title>${project.name}</title>\n  </head>\n</html>\n`
    );
    expect(existsSync(join(workspace, "frontend", "public", "site-icon.png"))).toBe(false);
  });
});
