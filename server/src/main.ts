// The server: Fastify + tRPC API and the Temporal worker, one process or two by SCHMEIDE_ROLE
// (role.ts). With cli/access.ts, the only place that reads the environment.
import { photograph } from "./services/pictures.ts";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { Client, Connection } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";
import { describeRouting, routingFromEnv } from "./agentModel.ts";
import { buildApp } from "./app.ts";
import { createDb } from "./db/client.ts";
import {
  authConfigFromEnv,
  createAuth,
  enabledProviders,
  isLocal,
  type AuthConfig,
} from "./services/auth.ts";
import { claudeEnv } from "./services/claudeEnv.ts";
import {
  createFileScanner,
  recordUploadRefusal,
  scanStoredFiles,
  type FileScanner,
} from "./services/fileScan.ts";
import { createFileReader } from "./services/fileReader.ts";
import { createLocalFileStore } from "./services/fileStore.ts";
import { createInterviewer, createReadBackWriter } from "./services/interviewer.ts";
import { failOrphanedBuilds } from "./services/projects.ts";
import { createResourceReader } from "./services/resources.ts";
import { sweepExpired } from "./services/retention.ts";
import { createSiteFetcher } from "./services/siteFetcher.ts";
import { createSummaries } from "./services/summaries.ts";
import { createSummarizer } from "./services/summarizer.ts";
import { createWebsiteReader } from "./services/websiteReader.ts";
import { createHealthServer, parseBuilds, parseRole } from "./role.ts";
import { checkRunner, parseRunner, refuseDesignTeam, runnerFromEnv } from "./runner.ts";
import {
  BUILDER_PLUGIN,
  createActivities,
  GIT_CONFIG,
  gitConfigFile,
  shimDir,
  sweepLeftoverRuns,
} from "./temporal/activities.ts";

const env = process.env;
const databaseUrl = env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5440/schmeide";
const temporalAddress = env.TEMPORAL_ADDRESS ?? "localhost:7233";
const port = Number(env.PORT ?? 3100);
const taskQueue = env.SCHMEIDE_TASK_QUEUE ?? "schmeide";
const role = (() => {
  try {
    return parseRole(env.SCHMEIDE_ROLE);
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
})();
// Only the worker builds, so only it reads the Kubernetes settings (runner.ts).
const runner = (() => {
  try {
    refuseDesignTeam(env);
    return parseRunner(env.SCHMEIDE_RUNNER) === "kubernetes" && role.runWorker
      ? runnerFromEnv(env)
      : undefined;
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
})();
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
// deploys, or is hosted, so neither GNU make nor Docker is needed. `admins` needs what `on` does.
const builds = (() => {
  try {
    return parseBuilds(env.SCHMEIDE_BUILDS);
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
})();
const buildsOff = builds === "off";

const makeBin = [onPath("gmake"), onPath("make")].find((bin) => bin && isGnuMake4(bin));
// Only the worker builds.
if (!makeBin && !buildsOff && role.runWorker) {
  console.error(
    "GNU make 4 or newer is required (Apple's make is 3.81). Install it: brew install make, or set SCHMEIDE_BUILDS=off to run without building apps."
  );
  process.exit(1);
}

const dataDir = env.SCHMEIDE_DATA_DIR ?? join(homedir(), ".schmeide");
// The API's model calls run in the data dir.
mkdirSync(dataDir, { recursive: true });
// Only the worker's activities use these, and an API sharing the disk must not race it for them.
if (role.runWorker) {
  // Project runs and the agent's own Bash calls find GNU make as `make` through this directory.
  mkdirSync(shimDir(dataDir), { recursive: true });
  rmSync(join(shimDir(dataDir), "make"), { force: true });
  if (makeBin) symlinkSync(makeBin, join(shimDir(dataDir), "make"));
  writeFileSync(gitConfigFile(dataDir), GIT_CONFIG);
}

const config = {
  dataDir,
  // Never run with builds off, the only case it can be missing.
  makeBin: makeBin ?? "make",
  template: env.SCHMEIDE_TEMPLATE ?? "https://github.com/schmeide/template.git",
  agentModels: routingFromEnv(env),
  interviewModel: env.SCHMEIDE_INTERVIEW_MODEL ?? "sonnet",
  websiteModel: env.SCHMEIDE_WEBSITE_MODEL ?? "sonnet",
  // Writes the running summary of each build: small and fast, since it runs beside every build.
  summaryModel: env.SCHMEIDE_SUMMARY_MODEL ?? "haiku",
  agentCmd: env.SCHMEIDE_AGENT_CMD,
  claudeBin,
  builderPlugin: BUILDER_PLUGIN,
  // ponytail: off until the design team is measured on the to-do fixture (#159, #83).
  designTeam: env.SCHMEIDE_DESIGN_TEAM === "1",
} as const;

// The worker needs none of the sign-in settings or secrets.
const authConfig = role.serveApi
  ? (() => {
      try {
        return authConfigFromEnv(env);
      } catch (error) {
        console.error((error as Error).message);
        process.exit(1);
      }
    })()
  : undefined;

const scannerAddress = env.SCHMEIDE_CLAMAV_ADDRESS?.trim() || undefined;
if (authConfig && !isLocal(authConfig.publicUrl) && !scannerAddress) {
  console.error(
    "SCHMEIDE_CLAMAV_ADDRESS must be set when SCHMEIDE_PUBLIC_URL is not localhost, so an upload is scanned before it is stored. Point it at ClamAV in the cluster, for example clamav.clamav.svc.cluster.local:3310."
  );
  process.exit(1);
}
const scanner: FileScanner = (() => {
  try {
    return createFileScanner(scannerAddress);
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

const startWorker = async () => {
  const problems = runner ? await checkRunner(runner) : [];
  if (problems.length > 0) {
    console.error(`SCHMEIDE_RUNNER=kubernetes cannot build yet:\n- ${problems.join("\n- ")}`);
    process.exit(1);
  }
  const worker = await Worker.create({
    connection: await NativeConnection.connect({ address: temporalAddress }),
    taskQueue,
    workflowsPath: new URL("./temporal/workflows.ts", import.meta.url).pathname,
    activities: createActivities(
      deps,
      { ...config, runner, photograph },
      undefined,
      undefined,
      createSummaries(db, createSummarizer({ ...config, model: config.summaryModel }))
    ),
  });
  await failOrphanedBuilds(deps);
  if (runner) console.log(`Swept ${await sweepLeftoverRuns(db, runner)} leftover build Jobs.`);
  // On the worker, which keeps the build logs: at start and each day after (services/retention.ts).
  const sweep = () =>
    sweepExpired(db, config.dataDir).then(
      (removed) => console.log(`Retention sweep removed ${JSON.stringify(removed)}.`),
      (error: unknown) => console.error("Retention sweep failed:", error)
    );
  void sweep();
  setInterval(() => void sweep(), 86_400_000).unref();
  return worker;
};

const startApi = (authConfig: AuthConfig) => {
  const providers = enabledProviders(authConfig);
  const fileStore = createLocalFileStore(config.dataDir);
  const app = buildApp(
    {
      ...deps,
      interviewer: createInterviewer({ ...config, model: config.interviewModel }),
      readBackWriter: createReadBackWriter({ ...config, model: config.interviewModel }),
      siteFetcher: createSiteFetcher(),
      reader: createFileReader({ ...config, model: config.interviewModel }),
      files: fileStore,
      websiteReader: createWebsiteReader({ ...config, model: config.websiteModel }),
      resources: createResourceReader(config.dataDir),
      dataDir: config.dataDir,
      auth: createAuth(db, authConfig),
      providers,
      designTeam: config.designTeam,
      buildsAdminsOnly: builds === "admins",
    },
    {
      logger: true,
      allowOrigin: authConfig.publicUrl,
      scanner,
      recordUploadRefusal: (refusal) => recordUploadRefusal(config.dataDir, refusal),
    }
  );
  console.log(
    `Sign-in at ${authConfig.publicUrl} with password${providers.map((name) => `, ${name}`).join("")}. Approve a person with \`make access/approve EMAIL=...\`.`
  );
  return { app, fileStore };
};

const worker = role.runWorker ? await startWorker() : undefined;
const started = authConfig ? startApi(authConfig) : undefined;
const app = started?.app;
if (started) {
  const outcome = await scanStoredFiles({
    db,
    files: started.fileStore,
    dataDir: config.dataDir,
    scanner,
    stamp: scannerAddress ?? "passing",
  }).catch((error: unknown) => {
    console.error("Stored files were not scanned. The next start will try again.", error);
    return undefined;
  });
  if (outcome) console.log(`Stored file scan: ${outcome.status}, removed ${outcome.removed}.`);
  console.log(
    scannerAddress
      ? `Upload scan: ClamAV at ${scannerAddress}.`
      : "Upload scan: passing every file (set SCHMEIDE_CLAMAV_ADDRESS to scan with ClamAV)."
  );
}
// A worker on its own answers only /healthz on PORT, for its probes.
const health = app ? undefined : createHealthServer(() => worker?.getState() === "RUNNING");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    worker?.shutdown();
    health?.close();
    void app?.close().then(() => (worker ? undefined : connection.close()));
  });
}

console.log(
  `Role ${env.SCHMEIDE_ROLE ?? "all"}: ${[app && "API", worker && "Temporal worker"].filter(Boolean).join(" and ")}.`
);
console.log(
  buildsOff
    ? "Builds are off (SCHMEIDE_BUILDS=off): nothing is built, deployed, or hosted, and no docker command runs."
    : `Builds are on${builds === "admins" ? " for admins only (SCHMEIDE_BUILDS=admins)" : ""}: apps build with GNU make and Docker on this host.`
);
console.log(
  `Data dir ${config.dataDir}, template ${config.template}, agent models: ${describeRouting(config.agentModels)}, interview model ${config.interviewModel}, website model ${config.websiteModel}, summary model ${config.summaryModel}, design team ${config.designTeam ? "on" : "off (SCHMEIDE_DESIGN_TEAM=1 turns it on)"}`
);
if (runner)
  console.log(
    `Runner kubernetes: the agent and the checks run as Jobs in ${runner.kube.namespace} from ${runner.image}; code lives on Forgejo.`
  );
// Loopback unless told otherwise: a hosted server sits behind a proxy that ends https.
const host = env.SCHMEIDE_HOST ?? "127.0.0.1";
await app?.listen({ host, port });
health?.listen(port, host);
if (worker) {
  await worker.run();
  await connection.close();
}
