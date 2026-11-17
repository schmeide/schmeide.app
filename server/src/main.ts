// The one process: Fastify + tRPC API and the Temporal worker. With cli/access.ts, the only place
// that reads the environment.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { Client, Connection } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";
import { describeRouting, routingFromEnv } from "./agentModel.ts";
import { buildApp } from "./app.ts";
import { createDb } from "./db/client.ts";
import { authConfigFromEnv, createAuth, enabledProviders } from "./services/auth.ts";
import { claudeEnv } from "./services/claudeEnv.ts";
import { createFileReader } from "./services/fileReader.ts";
import { createLocalFileStore } from "./services/fileStore.ts";
import { createInterviewer } from "./services/interviewer.ts";
import { failOrphanedBuilds } from "./services/projects.ts";
import { createResourceReader } from "./services/resources.ts";
import { createSiteFetcher } from "./services/siteFetcher.ts";
import { createWebsiteReader } from "./services/websiteReader.ts";
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
// The model calls get only claudeEnv, so check the login with exactly that. `claude auth status`
// is local, exits 1 when logged out, and counts ANTHROPIC_API_KEY (or Foundry settings) as a login.
if (!env.SCHMEIDE_AGENT_CMD) {
  try {
    execFileSync(claudeBin, ["auth", "status"], { env: claudeEnv(env), stdio: "ignore" });
  } catch {
    console.error(
      "claude has no login or API key. Set ANTHROPIC_API_KEY (or CLAUDE_CODE_USE_FOUNDRY and its ANTHROPIC_FOUNDRY_* settings), or run `claude` and log in (/login)."
    );
    process.exit(1);
  }
}

// SCHMEIDE_BUILDS=off (Stage 1 on AKS): people plan apps and get proposals, but nothing builds,
// deploys, or is hosted, so neither GNU make nor Docker is needed.
const builds = env.SCHMEIDE_BUILDS ?? "on";
if (builds !== "on" && builds !== "off") {
  console.error(`SCHMEIDE_BUILDS is "${builds}"; set it to on (the default) or off.`);
  process.exit(1);
}
const buildsOff = builds === "off";

const makeBin = [onPath("gmake"), onPath("make")].find((bin) => bin && isGnuMake4(bin));
if (!makeBin && !buildsOff) {
  console.error(
    "GNU make 4 or newer is required (Apple's make is 3.81). Install it: brew install make, or set SCHMEIDE_BUILDS=off to run without building apps."
  );
  process.exit(1);
}

const dataDir = env.SCHMEIDE_DATA_DIR ?? join(homedir(), ".schmeide");
// Project runs and the agent's own Bash calls find GNU make as `make` through this directory.
mkdirSync(shimDir(dataDir), { recursive: true });
rmSync(join(shimDir(dataDir), "make"), { force: true });
if (makeBin) symlinkSync(makeBin, join(shimDir(dataDir), "make"));
writeFileSync(gitConfigFile(dataDir), GIT_CONFIG);

const config = {
  dataDir,
  // Never run with builds off, the only case it can be missing.
  makeBin: makeBin ?? "make",
  template: env.SCHMEIDE_TEMPLATE ?? "https://github.com/schmeide/template.git",
  agentModels: routingFromEnv(env),
  interviewModel: env.SCHMEIDE_INTERVIEW_MODEL ?? "sonnet",
  websiteModel: env.SCHMEIDE_WEBSITE_MODEL ?? "sonnet",
  agentCmd: env.SCHMEIDE_AGENT_CMD,
  claudeBin,
} as const;

const authConfig = (() => {
  try {
    return authConfigFromEnv(env);
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
})();

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
const deps = { db, workflows: client.workflow, taskQueue, buildsOff } as const;

const worker = await Worker.create({
  connection: await NativeConnection.connect({ address: temporalAddress }),
  taskQueue,
  workflowsPath: new URL("./temporal/workflows.ts", import.meta.url).pathname,
  activities: createActivities(deps, config),
});

await failOrphanedBuilds(deps);
const interviewer = createInterviewer({ ...config, model: config.interviewModel });
const reader = createFileReader({ ...config, model: config.interviewModel });
const files = createLocalFileStore(config.dataDir);
const websiteReader = createWebsiteReader({ ...config, model: config.websiteModel });
const siteFetcher = createSiteFetcher();
const providers = enabledProviders(authConfig);
const app = buildApp(
  {
    ...deps,
    interviewer,
    siteFetcher,
    reader,
    files,
    websiteReader,
    resources: createResourceReader(config.dataDir),
    auth: createAuth(db, authConfig),
    providers,
  },
  { logger: true, allowOrigin: authConfig.publicUrl }
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    worker.shutdown();
    void app.close();
  });
}

console.log(
  `Sign-in at ${authConfig.publicUrl} with password${providers.map((name) => `, ${name}`).join("")}. Approve a person with \`make access/approve EMAIL=...\`.`
);
console.log(
  buildsOff
    ? "Builds are off (SCHMEIDE_BUILDS=off): nothing is built, deployed, or hosted, and no docker command runs."
    : "Builds are on: apps build with GNU make and Docker on this host."
);
console.log(
  `Data dir ${config.dataDir}, template ${config.template}, agent models: ${describeRouting(config.agentModels)}, interview model ${config.interviewModel}, website model ${config.websiteModel}`
);
// Loopback unless told otherwise: a hosted server sits behind a proxy that ends https.
await app.listen({ host: env.SCHMEIDE_HOST ?? "127.0.0.1", port });
await worker.run();
await connection.close();
