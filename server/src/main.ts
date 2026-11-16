// The one process: Fastify + tRPC API and the Temporal worker. The only place that reads the environment.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { Client, Connection } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";
import { describeRouting, routingFromEnv } from "./agentModel.ts";
import { buildApp } from "./app.ts";
import { createDb } from "./db/client.ts";
import { createInterviewer } from "./services/interviewer.ts";
import { failOrphanedBuilds } from "./services/projects.ts";
import { createActivities, GIT_CONFIG, gitConfigFile, shimDir } from "./temporal/activities.ts";

const env = process.env;
const databaseUrl = env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5440/schmeide";
const temporalAddress = env.TEMPORAL_ADDRESS ?? "localhost:7233";
const port = Number(env.PORT ?? 3100);
const taskQueue = env.SCHMEIDE_TASK_QUEUE ?? "schmeide";
const onPath = (name: string) =>
  (env.PATH ?? "")
    .split(delimiter)
    .map((dir) => join(dir, name))
    .find((path) => existsSync(path));
const isGnuMake4 = (bin: string) =>
  Number(/GNU Make (\d+)/.exec(execFileSync(bin, ["--version"]).toString())?.[1] ?? 0) >= 4;

const claudeBin = env.SCHMEIDE_CLAUDE_BIN ?? onPath("claude");
if (!claudeBin) {
  console.error(
    "claude is not on PATH. Install Claude Code and log in (`claude`), or set SCHMEIDE_CLAUDE_BIN."
  );
  process.exit(1);
}

const makeBin = [onPath("gmake"), onPath("make")].find((bin) => bin && isGnuMake4(bin));
if (!makeBin) {
  console.error(
    "GNU make 4 or newer is required (Apple's make is 3.81). Install it: brew install make"
  );
  process.exit(1);
}

const dataDir = env.SCHMEIDE_DATA_DIR ?? join(homedir(), ".schmeide");
// Project runs and the agent's own Bash calls find GNU make as `make` through this directory.
mkdirSync(shimDir(dataDir), { recursive: true });
rmSync(join(shimDir(dataDir), "make"), { force: true });
symlinkSync(makeBin, join(shimDir(dataDir), "make"));
writeFileSync(gitConfigFile(dataDir), GIT_CONFIG);

const config = {
  dataDir,
  makeBin,
  template: env.SCHMEIDE_TEMPLATE ?? "https://github.com/schmeide/template.git",
  agentModels: routingFromEnv(env),
  interviewModel: env.SCHMEIDE_INTERVIEW_MODEL ?? "sonnet",
  agentCmd: env.SCHMEIDE_AGENT_CMD,
  claudeBin,
} as const;

const db = createDb(databaseUrl);
const connection = await Connection.connect({ address: temporalAddress }).catch(
  (error: unknown) => {
    console.error(
      `Cannot reach Temporal at ${temporalAddress}: run \`make infra/up\` first.`,
      error
    );
    process.exit(1);
  }
);
const client = new Client({ connection });
const deps = { db, workflows: client.workflow, taskQueue } as const;

const worker = await Worker.create({
  connection: await NativeConnection.connect({ address: temporalAddress }),
  taskQueue,
  workflowsPath: new URL("./temporal/workflows.ts", import.meta.url).pathname,
  activities: createActivities(deps, config),
});

await failOrphanedBuilds(deps);
const interviewer = createInterviewer({ ...config, model: config.interviewModel });
const app = buildApp({ ...deps, interviewer }, true);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    worker.shutdown();
    void app.close();
  });
}

console.log(
  `Data dir ${config.dataDir}, template ${config.template}, agent models: ${describeRouting(config.agentModels)}, interview model ${config.interviewModel}`
);
await app.listen({ host: "127.0.0.1", port });
await worker.run();
await connection.close();
