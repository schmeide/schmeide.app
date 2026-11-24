// `make eval/features`: builds every test app (src/eval/apps/) against a running server, as
// `make e2e` drives the to-do fixture, and reports for each the share of its acceptance checks that
// work, the fix rounds used, the time and the cost (src/eval/features.ts). Each build is given the
// app's own checks in place of the writer's: they are saved for the spec before it is approved, and
// `planAcceptance` keeps checks written for the same spec. The run's account and projects are
// deleted afterwards unless KEEP=1.
//
// It writes run.json, verdicts.json (a sample of the tester's verdicts for a person to mark) and
// report.md to --out. `make eval/features/report RUN=<dir>` reads them back with the marks.
// Real builds cost real model usage: see docs/feature-eval.md.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { createTRPCClient, httpLink } from "@trpc/client";
import { eq } from "drizzle-orm";
import superjson from "superjson";
import { createDb } from "../src/db/client.ts";
import { buildAcceptance, projectAcceptance, tenants, users } from "../src/db/schema.ts";
import { planOf, readApps, type TestApp } from "../src/eval/apps.ts";
import {
  fixRoundsOf,
  marksSchema,
  reportOf,
  runFileSchema,
  sampleForMarking,
  type AppRun,
  type RunFile,
} from "../src/eval/features.ts";
import type { AppRouter } from "../src/router.ts";
import { approveEmail, removeApproval } from "../src/services/access.ts";
import { liveChecks, specHash } from "../src/services/acceptance.ts";

const apps = readApps();
const USAGE = `Usage: node e2e/features.ts [--app <id>] [--out <dir>] [--sample <n>]
       node e2e/features.ts --report <dir>

Builds the test apps (${apps.map((app) => app.id).join(", ")}) against the server at SCHMEIDE_URL
(default http://localhost:$PORT, PORT 3100) and writes run.json, verdicts.json and report.md to --out.
--report prints the report of an earlier run, with the verdicts marked in its verdicts.json.`;

const { values } = parseArgs({
  options: {
    app: { type: "string" },
    out: { type: "string" },
    sample: { type: "string", default: "10" },
    report: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});
if (values.help) {
  console.log(USAGE);
  process.exit(0);
}

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));
const writeJson = (path: string, value: unknown) =>
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

// Prints the report of the run in `dir` and writes it to report.md beside it.
const report = (dir: string) => {
  const { runs } = runFileSchema.parse(readJson(join(dir, "run.json")));
  const marks = marksSchema.parse(readJson(join(dir, "verdicts.json")));
  const text = reportOf(runs, marks);
  writeFileSync(join(dir, "report.md"), text);
  console.log(text);
};

if (values.report) {
  report(values.report);
  process.exit(0);
}

const chosen = values.app ? apps.filter((app) => app.id === values.app) : apps;
const sampleSize = Number(values.sample);
if (chosen.length === 0 || !Number.isInteger(sampleSize) || sampleSize < 0) {
  console.error(`Unknown --app or --sample.\n\n${USAGE}`);
  process.exit(2);
}

const base = process.env.SCHMEIDE_URL ?? `http://localhost:${process.env.PORT ?? 3100}`;
const keep = process.env.KEEP === "1";
const timeoutMs = Number(process.env.EVAL_TIMEOUT_MIN ?? 60) * 60_000;
const startedAt = new Date().toISOString();
const out =
  values.out ??
  join(
    process.env.SCHMEIDE_DATA_DIR ?? join(homedir(), ".schmeide"),
    "feature-evals",
    startedAt.replace(/[:.]/g, "-")
  );

let cookie = "";
const api = createTRPCClient<AppRouter>({
  links: [httpLink({ url: `${base}/trpc`, transformer: superjson, headers: () => ({ cookie }) })],
});
const db = createDb(
  process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5440/schmeide"
);
const origin = process.env.SCHMEIDE_PUBLIC_URL ?? "http://localhost:5173";
const account = {
  email: `eval-${randomBytes(4).toString("hex")}@schmeide.test`,
  password: randomBytes(18).toString("base64url"),
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const logAs = (app: TestApp) => (message: string) => console.log(`[${app.id}] ${message}`);

const health = await fetch(`${base}/healthz`).catch(() => undefined);
if (!health?.ok) {
  console.error(`No server at ${base}. Start it with \`make serve\` (or \`make serve/server\`).`);
  process.exit(1);
}

// As in e2e/run.ts: an approved account of the run's own, signed in through its invite link.
const signIn = async () => {
  const { token } = await approveEmail(db, account.email);
  await api.invites.accept.mutate({ token, name: "Feature eval", password: account.password });
  const response = await fetch(`${base}/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify(account),
  });
  if (!response.ok) throw new Error(`sign-in as ${account.email} answered ${response.status}`);
  cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  // A new account is in no business until it starts one.
  await api.setup.createBusiness.mutate({ yourName: "Feature eval", country: "NZ" });
};

const signOutForGood = async () => {
  const { businesses } = await api.session.get.query();
  await removeApproval(db, account.email);
  await db.delete(users).where(eq(users.email, account.email));
  for (const { id } of businesses) await db.delete(tenants).where(eq(tenants.id, id));
};

// Cancels a build still running (after a failure or timeout), then deletes everything.
const cleanUp = async (projectId: number) => {
  for (let tries = 0; tries < 60; tries++) {
    const { project } = await api.projects.get.query({ id: projectId });
    if (project.status !== "building" && project.status !== "spec_generating") break;
    if (project.status === "building" && tries === 0)
      await api.projects.stop.mutate({ id: projectId });
    await sleep(2000);
  }
  await api.projects.delete.mutate({ id: projectId });
};

// Builds one test app from its request to a finished first build, and records what came of it.
const runApp = async (app: TestApp): Promise<AppRun> => {
  const log = logAs(app);
  const plan = planOf(app);
  const started = Date.now();
  const checkDeadline = () => {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out after ${timeoutMs / 60_000}m`);
  };
  const recorded = (fields: Partial<AppRun>): AppRun => ({
    app: app.id,
    name: app.name,
    checks: liveChecks(plan).length,
    outcome: "failed",
    error: null,
    results: [],
    fixRounds: 0,
    seconds: (Date.now() - started) / 1000,
    costUsd: 0,
    ...fields,
  });
  const created = await api.projects.create.mutate({
    name: `eval ${app.id} ${startedAt.slice(0, 16)} ${randomBytes(2).toString("hex")}`,
  });
  const { id } = created;
  log(`created project ${id} (${created.slug})`);
  try {
    await api.projects.setFeatures.mutate({ id, features: app.request });
    await api.projects.generateSpec.mutate({ id });
    let spec = "";
    for (;;) {
      checkDeadline();
      const { project } = await api.projects.get.query({ id });
      if (project.status === "spec_ready") {
        spec = project.spec ?? "";
        break;
      }
      if (project.status !== "spec_generating")
        throw new Error(`spec generation ended in ${project.status}`);
      await sleep(2000);
    }
    const values = { specHash: specHash(spec), plan };
    await db
      .insert(projectAcceptance)
      .values({ projectId: id, ...values })
      .onConflictDoUpdate({ target: projectAcceptance.projectId, set: values });
    const { build } = await api.projects.approveSpec.mutate({ id });
    log(
      `spec ready and its ${values.plan.features.length} features' checks saved; build ${build.id} started`
    );
    let afterId = 0;
    for (;;) {
      checkDeadline();
      const { project, latestBuild } = await api.projects.get.query({ id });
      for (const event of await api.builds.events.query({ buildId: build.id, afterId })) {
        log(`${event.kind.padEnd(6)} ${event.message}`);
        afterId = event.id;
      }
      if (
        project.status === "failed" ||
        (project.status === "live" && latestBuild?.id === build.id)
      )
        break;
      await sleep(3000);
    }
    const rows = await db
      .select()
      .from(buildAcceptance)
      .where(eq(buildAcceptance.buildId, build.id));
    const { project, latestBuild, usage } = await api.projects.get.query({ id });
    return recorded({
      outcome: project.status === "live" ? "live" : "failed",
      error: project.status === "live" ? null : (latestBuild?.error ?? "build failed"),
      results: rows
        .map(({ checkId, feature, verdict, saw }) => ({ id: checkId, feature, verdict, saw }))
        .sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true })),
      fixRounds: fixRoundsOf(rows),
      costUsd: usage.costUsd,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`FAILED: ${message}`);
    const { usage } = await api.projects.get.query({ id }).catch(() => ({ usage: { costUsd: 0 } }));
    return recorded({ error: message, costUsd: usage.costUsd });
  } finally {
    if (keep)
      log(
        `KEEP=1: project ${id} left in place; sign in as ${account.email} with ${account.password}`
      );
    else await cleanUp(id).catch((error: unknown) => log(`cleanup: ${String(error)}`));
  }
};

mkdirSync(out, { recursive: true });
await signIn();
const runs: AppRun[] = [];
// One app at a time, so each build's time and cost are its own.
for (const app of chosen) {
  runs.push(await runApp(app));
  writeJson(join(out, "run.json"), { startedAt, runs } satisfies RunFile);
}
const plans = new Map(chosen.map((app) => [app.id, planOf(app)]));
writeJson(join(out, "verdicts.json"), sampleForMarking(runs, plans, sampleSize, startedAt));
if (!keep) await signOutForGood().catch((error: unknown) => console.error("cleanup:", error));
await db.$client.end();
console.log("");
report(out);
console.log(
  `Written to ${out}. Mark each verdict in verdicts.json, then: make eval/features/report RUN=${out}`
);
