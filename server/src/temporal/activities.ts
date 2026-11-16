import { spawn } from "node:child_process";
import { appendFile, mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { query as sdkQuery, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { Context } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { projects, type BuildEventKind, type NewUsage, type Project } from "../db/schema.ts";
import {
  appendEvent,
  finishBuild as finishBuildRow,
  getBuild,
  recordUsage,
} from "../services/builds.ts";
import { findProject, testDbPort, transition } from "../services/projects.ts";

export type Config = {
  readonly dataDir: string;
  readonly template: string;
  readonly agentModel: string;
  readonly claudeBin: string | undefined;
  // GNU make 4+. Apple's /usr/bin/make 3.81 ignores .SHELLFLAGS and fails every template target.
  readonly makeBin: string;
};

// Written by main.ts under the data dir: bin/make points at GNU make, gitconfig is a neutral identity.
export const shimDir = (dataDir: string) => join(dataDir, "bin");
export const gitConfigFile = (dataDir: string) => join(dataDir, "gitconfig");
export const GIT_CONFIG = `[user]
\tname = Schmeide
\temail = agent@schmeide.invalid
[init]
\tdefaultBranch = main
[commit]
\tgpgsign = false
`;

export type Query = typeof sdkQuery;

const HEARTBEAT_MS = 10_000;
const OUTPUT_TAIL = 12_000;
const MAX_EVENT = 300;

// Bash commands the agent may run; everything else is denied without prompting (dontAsk).
export const AGENT_TOOLS = ["Read", "Edit", "Write", "Glob", "Grep", "Bash", "TodoWrite"];
export const AGENT_ALLOWED_TOOLS = [
  "Read",
  "Glob",
  "Grep",
  "TodoWrite",
  "Edit(./**)",
  "Write(./**)",
  ...[
    "make",
    "npm",
    "npx",
    "node",
    "git",
    "ls",
    "cat",
    "head",
    "tail",
    "wc",
    "mkdir",
    "mv",
    "cp",
    "rm",
    "grep",
  ].map((command) => `Bash(${command}:*)`),
  "Bash(pwd)",
];

const STANDING_RULES = `Standing rules:
- Read AGENTS.md first and follow it. The stack is fixed.
- Write tests first, then the code that makes them pass.
- You are done only when \`make check\`, \`make test\`, and \`make build\` all pass. Run them yourself.
- Never run \`make serve\`, \`make up\`, or \`make down\`; Schmeide deploys the app.
- Keep the interface simple and clear: the customer is not technical.
- When the checks pass, commit everything with git (\`git add -A\` then \`git commit -m "..."\`).`;

export const buildPrompt = (kind: "initial" | "change", spec: string, request: string): string =>
  kind === "initial"
    ? `Build the web app described by the spec below inside this repository, a Schmeide project template.
Replace the sample notes feature entirely (table, migration, service, router, page, and tests) with the spec's features.

${STANDING_RULES}

Spec:

${spec}`
    : `This repository holds a web app built from the spec below. Apply the change request that follows it.

${STANDING_RULES}

Spec the app was built from:

${spec}

Change request:

${request}`;

export const checksFeedbackPrompt = (output: string): string =>
  `Schmeide ran \`make check\`, \`make test\`, and \`make build\` independently and they failed. Fix the cause, re-run all three until they pass, then commit. The failing output:

\`\`\`
${output}
\`\`\``;

const SPEC_PROMPT = (
  features: string
) => `A non-technical customer wants a small web app with these features, one per line:

${features}

Write a short plain-language spec for it in markdown with exactly three sections: "## Features", "## Screens", and "## Data it stores". Use short bullet points a non-technical reader understands. No code, no technology names, no title. Reply with only the markdown.`;

const truncate = (text: string, max = MAX_EVENT): string => {
  const line = text.trim().replace(/\s+/g, " ");
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

// Strip variables meant for this server so they never reach a project's make or agent.
// MAKEFLAGS and friends leak in when the server itself runs under make. The owner's global git
// config (signing, hooks templates) is replaced so project commits never need their keys.
export const projectEnv = (project: Project, dataDir: string): NodeJS.ProcessEnv => {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !/^(DATABASE_URL|TEST_DATABASE_URL|PORT|MAKEFLAGS|MFLAGS|MAKELEVEL|MAKEOVERRIDES|MAKE_TERMOUT|MAKE_TERMERR|SCHMEIDE_.*|TEMPORAL_.*)$/.test(
          key
        )
    )
  );
  return {
    ...env,
    PATH: `${shimDir(dataDir)}:${env.PATH ?? ""}`,
    GIT_CONFIG_GLOBAL: gitConfigFile(dataDir),
    GIT_CONFIG_NOSYSTEM: "1",
    COMPOSE_PROJECT_NAME: `schmeide-${project.slug}`,
    WEB_PORT: String(project.webPort),
    TEST_DB_PORT: String(testDbPort(project)),
  };
};

const usageRows = (
  message: Extract<SDKMessage, { type: "result" }>,
  projectId: number,
  buildId: number | null
): readonly NewUsage[] =>
  Object.entries(message.modelUsage).map(([model, used]) => ({
    projectId,
    buildId,
    model,
    inputTokens: used.inputTokens,
    outputTokens: used.outputTokens,
    cacheReadTokens: used.cacheReadInputTokens,
    cacheCreationTokens: used.cacheCreationInputTokens,
    costUsd: used.costUSD,
  }));

// One short line per tool call, so the UI shows progress rather than raw output.
export const describeToolUse = (
  name: string,
  input: Record<string, unknown>
): string | undefined => {
  const str = (key: string) => (typeof input[key] === "string" ? (input[key] as string) : "");
  switch (name) {
    case "Bash":
      return `$ ${truncate(str("command"), 160)}`;
    case "Edit":
    case "Write":
      return `${name === "Edit" ? "Editing" : "Writing"} ${str("file_path")}`;
    case "Read":
      return `Reading ${str("file_path")}`;
    case "Glob":
    case "Grep":
      return `Searching for ${truncate(str("pattern"), 120)}`;
    case "TodoWrite": {
      const todos = Array.isArray(input.todos)
        ? (input.todos as { status?: string; activeForm?: string }[])
        : [];
      const active = todos.find((todo) => todo.status === "in_progress");
      return active?.activeForm ? `Working on: ${active.activeForm}` : undefined;
    }
    default:
      return `Using ${name}`;
  }
};

export const createActivities = (db: Db, config: Config, query: Query = sdkQuery) => {
  const workspaceOf = (project: Project) => join(config.dataDir, "projects", project.slug);
  const logFile = (buildId: number) => join(config.dataDir, "logs", `build-${buildId}.log`);

  const log = async (buildId: number, text: string) => {
    await mkdir(join(config.dataDir, "logs"), { recursive: true });
    await appendFile(logFile(buildId), text.endsWith("\n") ? text : `${text}\n`);
  };

  const event = async (buildId: number, kind: BuildEventKind, message: string) => {
    await appendEvent(db, buildId, kind, truncate(message, 2000));
    await log(buildId, `[${kind}] ${message}`);
  };

  const projectOfBuild = async (buildId: number) => {
    const build = await getBuild(db, buildId);
    return { build, project: await findProject(db, build.projectId) };
  };

  // Heartbeats while `work` runs and reports Temporal cancellation through the signal.
  const withHeartbeat = async <T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const context = Context.current();
    const timer = setInterval(() => context.heartbeat(), HEARTBEAT_MS);
    try {
      return await work(context.cancellationSignal);
    } finally {
      clearInterval(timer);
    }
  };

  // Runs a command in its own process group so cancellation also stops what it spawned.
  const run = (
    command: string,
    args: readonly string[],
    options: { readonly cwd: string; readonly env?: NodeJS.ProcessEnv; readonly buildId?: number }
  ): Promise<{ code: number; output: string }> =>
    withHeartbeat(
      (signal) =>
        new Promise((resolve, reject) => {
          const child = spawn(command, args, {
            cwd: options.cwd,
            env: options.env ?? process.env,
            detached: true,
            stdio: ["ignore", "pipe", "pipe"],
          });
          let output = "";
          const collect = (chunk: Buffer) => {
            output = (output + chunk.toString()).slice(-OUTPUT_TAIL);
            if (options.buildId !== undefined) void log(options.buildId, chunk.toString());
          };
          child.stdout.on("data", collect);
          child.stderr.on("data", collect);
          const kill = () => child.pid && process.kill(-child.pid, "SIGTERM");
          signal.addEventListener("abort", kill, { once: true });
          child.on("error", reject);
          child.on("close", (code) => {
            signal.removeEventListener("abort", kill);
            if (signal.aborted) reject(new Error(`${command} canceled`));
            else resolve({ code: code ?? 1, output });
          });
        })
    );

  const mustRun = async (
    project: Project,
    command: string,
    args: readonly string[],
    cwd: string,
    buildId?: number
  ) => {
    const result = await run(command, args, {
      cwd,
      buildId,
      env: projectEnv(project, config.dataDir),
    });
    if (result.code !== 0) {
      throw new Error(
        `${command} ${args.join(" ")} failed (exit ${result.code}): ${result.output.slice(-2000)}`
      );
    }
  };

  const agentEnv = (project: Project): Record<string, string> =>
    Object.fromEntries(
      Object.entries({
        ...projectEnv(project, config.dataDir),
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      }).filter((entry): entry is [string, string] => entry[1] !== undefined)
    );

  // Shared by spec and build runs. settingSources keeps the owner's user-level settings, hooks, and
  // plugins out; claudeMdExcludes keeps out the user CLAUDE.md, which loads regardless of sources.
  const agentOptions = (cwd: string, env: Record<string, string>): Options => ({
    cwd,
    env,
    model: config.agentModel,
    pathToClaudeCodeExecutable: config.claudeBin,
    settingSources: ["project"],
    settings: {
      claudeMdExcludes: [join(homedir(), ".claude", "**")],
      attribution: { commit: "", pr: "" },
    },
    permissionMode: "dontAsk",
  });

  return {
    async generateSpec(projectId: number): Promise<void> {
      const project = await findProject(db, projectId);
      await mkdir(config.dataDir, { recursive: true });
      try {
        const spec = await withHeartbeat(async (signal) => {
          const abortController = new AbortController();
          signal.addEventListener("abort", () => abortController.abort(), { once: true });
          for await (const message of query({
            prompt: SPEC_PROMPT(project.features),
            options: {
              ...agentOptions(config.dataDir, agentEnv(project)),
              settingSources: [],
              tools: [],
              maxTurns: 1,
              persistSession: false,
              abortController,
            },
          })) {
            if (message.type !== "result") continue;
            await recordUsage(db, usageRows(message, projectId, null));
            if (message.subtype !== "success" || message.is_error) {
              throw new Error(`Spec generation failed: ${message.subtype}`);
            }
            return message.result.replace(/^```(?:markdown)?\n|\n```\s*$/g, "").trim();
          }
          throw new Error("Claude ended without a result");
        });
        await transition(db, projectId, ["spec_generating"], { status: "spec_ready", spec });
      } catch (error) {
        await transition(db, projectId, ["spec_generating"], { status: "draft" });
        throw error;
      }
    },

    async prepareWorkspace(buildId: number): Promise<void> {
      const { project } = await projectOfBuild(buildId);
      const workspace = workspaceOf(project);
      if (await stat(join(workspace, ".git")).catch(() => undefined)) {
        await event(buildId, "step", "Reusing the project workspace");
        return;
      }
      await event(buildId, "step", "Copying the template into a fresh workspace");
      // ponytail: a local git directory per project; a repository on self-hosted Forgejo in production
      await mkdir(join(config.dataDir, "projects"), { recursive: true });
      const staging = await mkdtemp(join(config.dataDir, "projects", `.${project.slug}-`));
      try {
        await mustRun(
          project,
          "git",
          ["clone", "--depth", "1", config.template, staging],
          config.dataDir,
          buildId
        );
        await rm(join(staging, ".git"), { recursive: true, force: true });
        await mustRun(project, "git", ["init", "-q", "-b", "main"], staging);
        await mustRun(project, "git", ["add", "-A"], staging);
        await mustRun(
          project,
          "git",
          ["commit", "-q", "-m", "start from the schmeide template"],
          staging
        );
        await rename(staging, workspace);
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
      await event(buildId, "step", "Workspace ready");
    },

    // Returns the session id so a later fix-up run can resume the same conversation.
    async runAgent(input: {
      buildId: number;
      resume?: string;
      feedback?: string;
    }): Promise<string> {
      const { build, project } = await projectOfBuild(input.buildId);
      const prompt =
        input.feedback !== undefined
          ? checksFeedbackPrompt(input.feedback)
          : buildPrompt(build.kind, project.spec ?? "", build.request);
      await event(
        input.buildId,
        "step",
        input.feedback !== undefined ? "Agent is fixing failed checks" : "Agent is building the app"
      );
      return withHeartbeat(async (signal) => {
        const abortController = new AbortController();
        signal.addEventListener("abort", () => abortController.abort(), { once: true });
        // ponytail: the agent runs on the host in the workspace; a sandbox pod per job in production
        for await (const message of query({
          prompt,
          options: {
            ...agentOptions(workspaceOf(project), agentEnv(project)),
            tools: AGENT_TOOLS,
            allowedTools: AGENT_ALLOWED_TOOLS,
            resume: input.resume,
            abortController,
          },
        })) {
          await log(input.buildId, JSON.stringify(message));
          if (message.type === "system" && message.subtype === "init") {
            await event(input.buildId, "agent", `Agent started (${message.model})`);
          } else if (message.type === "assistant") {
            for (const block of message.message.content) {
              const line =
                block.type === "text"
                  ? block.text.trim() && truncate(block.text)
                  : block.type === "tool_use"
                    ? describeToolUse(block.name, block.input as Record<string, unknown>)
                    : undefined;
              if (line) await event(input.buildId, "agent", line);
            }
          } else if (message.type === "result") {
            await recordUsage(db, usageRows(message, project.id, input.buildId));
            for (const denial of message.permission_denials) {
              await event(
                input.buildId,
                "agent",
                `Denied ${denial.tool_name}: ${JSON.stringify(denial.tool_input)}`
              );
            }
            const summary = `Agent finished: ${message.subtype}, ${message.num_turns} turns, $${message.total_cost_usd.toFixed(2)}`;
            await event(input.buildId, message.is_error ? "error" : "agent", summary);
            if (message.subtype !== "success" || message.is_error) {
              throw ApplicationFailure.nonRetryable(summary);
            }
            return message.session_id;
          }
        }
        throw ApplicationFailure.nonRetryable("Claude ended without a result");
      });
    },

    // ponytail: checks run on the host via the project Makefile; a Kubernetes Job in production
    async runChecks(buildId: number): Promise<{ ok: boolean; output: string }> {
      const { project } = await projectOfBuild(buildId);
      for (const target of ["check", "test", "build"]) {
        await event(buildId, "check", `Running make ${target}`);
        const result = await run(config.makeBin, [target], {
          cwd: workspaceOf(project),
          env: projectEnv(project, config.dataDir),
          buildId,
        });
        if (result.code !== 0) {
          await event(buildId, "check", `make ${target} failed (exit ${result.code})`);
          return { ok: false, output: `$ make ${target}\n${result.output}` };
        }
        await event(buildId, "check", `make ${target} passed`);
      }
      return { ok: true, output: "" };
    },

    // ponytail: `make up` with Docker Compose on this machine; an AKS namespace per tenant plus object storage and CDN in production
    async deploy(buildId: number): Promise<void> {
      const { project } = await projectOfBuild(buildId);
      await event(buildId, "deploy", "Starting the app (make up)");
      const result = await run(config.makeBin, ["up"], {
        cwd: workspaceOf(project),
        env: projectEnv(project, config.dataDir),
        buildId,
      });
      if (result.code !== 0) {
        throw ApplicationFailure.nonRetryable(
          `make up failed (exit ${result.code}):\n${result.output.slice(-4000)}`
        );
      }
      const url = `http://localhost:${project.webPort}`;
      await event(buildId, "deploy", `Waiting for ${url} to answer`);
      await withHeartbeat(async (signal) => {
        const deadline = Date.now() + 180_000;
        for (;;) {
          const statuses = await Promise.all(
            [`${url}/`, `${url}/api/healthz`].map((target) =>
              fetch(target, { signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) })
                .then((response) => response.status)
                .catch(() => 0)
            )
          );
          if (statuses.every((status) => status === 200)) return;
          if (signal.aborted) throw new Error("deploy canceled");
          if (Date.now() > deadline) {
            throw ApplicationFailure.nonRetryable(
              `${url} did not answer 200 within 3 minutes (got ${statuses.join(", ")})`
            );
          }
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      });
      await db
        .update(projects)
        .set({ previewUrl: url, status: "live" })
        .where(eq(projects.id, project.id));
      await event(buildId, "deploy", `Live at ${url}`);
    },

    async finishBuild(buildId: number, error?: string): Promise<void> {
      const build = await finishBuildRow(db, buildId, error);
      if (error) {
        await event(buildId, "error", error);
        await db.update(projects).set({ status: "failed" }).where(eq(projects.id, build.projectId));
      } else {
        await event(buildId, "step", "Build passed");
      }
    },

    async stopDeployment(projectId: number): Promise<void> {
      const project = await findProject(db, projectId);
      const workspace = workspaceOf(project);
      if (await stat(workspace).catch(() => undefined)) {
        const result = await run(config.makeBin, ["down"], {
          cwd: workspace,
          env: projectEnv(project, config.dataDir),
        });
        if (result.code !== 0)
          throw new Error(`make down failed (exit ${result.code}): ${result.output.slice(-2000)}`);
      }
      await db
        .update(projects)
        .set({ status: "stopped", previewUrl: null })
        .where(eq(projects.id, projectId));
    },
  };
};

export type Activities = ReturnType<typeof createActivities>;
