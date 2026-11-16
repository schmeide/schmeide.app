// `make e2e` / `make e2e/fake`: drives the to-do fixture from features to a live app against a
// running server, then deletes the project (deployment, volumes, workspace, rows) unless KEEP=1.
// It signs in as an approved account it makes for the run and removes afterwards. Exits non-zero on failure. E2E_CONCURRENT=1 (set by `make e2e/fake`) builds two projects at once
// and queues a change on the first while its build runs; the second then gets a page title and icon,
// checked on the deployed app.
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createTRPCClient, httpLink } from "@trpc/client";
import { eq } from "drizzle-orm";
import superjson from "superjson";
import { createDb } from "../src/db/client.ts";
import { tenants, users } from "../src/db/schema.ts";
import type { AppRouter } from "../src/router.ts";
import { approveEmail, removeApproval } from "../src/services/access.ts";

const base = process.env.SCHMEIDE_URL ?? `http://localhost:${process.env.PORT ?? 3100}`;
const keep = process.env.KEEP === "1";
const concurrent = process.env.E2E_CONCURRENT === "1";
const timeoutMs = Number(process.env.E2E_TIMEOUT_MIN ?? 60) * 60_000;
const features = readFileSync(new URL("./todo-features.txt", import.meta.url), "utf8").trim();

// The run signs in as an approved account it makes for itself (below) and sends its cookie.
let cookie = "";
const api = createTRPCClient<AppRouter>({
  links: [
    httpLink({ url: `${base}/api/trpc`, transformer: superjson, headers: () => ({ cookie }) }),
  ],
});
const db = createDb(
  process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5440/schmeide"
);
// Sign-in checks that a request comes from the app's own address.
const origin = process.env.SCHMEIDE_PUBLIC_URL ?? "http://localhost:5173";
const account = {
  email: `e2e-${randomBytes(4).toString("hex")}@schmeide.test`,
  password: randomBytes(18).toString("base64url"),
};
const started = Date.now();
const elapsed = () => `${Math.round((Date.now() - started) / 1000)}s`;
const logAs = (projectId: number) => (message: string) =>
  console.log(`[${elapsed()}]${concurrent ? ` #${projectId}` : ""} ${message}`);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const checkDeadline = () => {
  if (Date.now() - started > timeoutMs) throw new Error(`timed out after ${elapsed()}`);
};

// The last status seen per project; two "building" at once proves builds run side by side.
const statuses = new Map<number, string>();
let overlapped = false;
const see = (projectId: number, status: string) => {
  statuses.set(projectId, status);
  if (statuses.size > 1 && [...statuses.values()].every((seen) => seen === "building"))
    overlapped = true;
};

// A 1x1 PNG.
const ICON =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const TITLE = "E2E <title> & icon";

// Polls until the project is live with no queued builds and its latest build is `buildId`.
const waitForBuild = async (projectId: number, buildId: number, afterId = 0) => {
  const log = logAs(projectId);
  for (;;) {
    checkDeadline();
    const { project, latestBuild, queued } = await api.projects.get.query({ id: projectId });
    see(projectId, project.status);
    for (const event of await api.builds.events.query({
      buildId: latestBuild?.id ?? buildId,
      afterId,
    })) {
      log(`${event.kind.padEnd(6)} build ${event.buildId} ${event.message}`);
      afterId = event.id;
    }
    if (project.status === "failed") return afterId;
    if (project.status === "live" && queued.length === 0 && latestBuild?.id === buildId)
      return afterId;
    await sleep(3000);
  }
};

const checkSite = async (projectId: number, url: string) => {
  const log = logAs(projectId);
  await api.projects.setSite.mutate({ id: projectId, title: TITLE, icon: ICON });
  const { latestBuild } = await api.projects.get.query({ id: projectId });
  if (latestBuild?.kind !== "site") throw new Error("saving the title and icon started no build");
  log(`page title and icon saved; build ${latestBuild.id} applies them`);
  await waitForBuild(projectId, latestBuild.id);
  const page = await (await fetch(`${url}/`)).text();
  if (!page.includes("<title>E2E &lt;title&gt; &amp; icon</title>"))
    throw new Error(`the page title was not applied: ${/<title>.*<\/title>/.exec(page)?.[0]}`);
  const icon = Buffer.from(await (await fetch(`${url}/site-icon.png`)).arrayBuffer());
  if (!icon.equals(Buffer.from(ICON, "base64"))) throw new Error("the icon was not served");
  log(`GET ${url}/ has the page title; ${url}/site-icon.png is the icon`);
};

const run = async (projectId: number, queueChange: boolean) => {
  const log = logAs(projectId);
  await api.projects.setFeatures.mutate({ id: projectId, features });
  await api.projects.generateSpec.mutate({ id: projectId });
  for (;;) {
    checkDeadline();
    const { project } = await api.projects.get.query({ id: projectId });
    if (project.status === "spec_ready") {
      log(`spec ready:\n${project.spec}\n`);
      break;
    }
    if (project.status !== "spec_generating")
      throw new Error(`spec generation ended in ${project.status}`);
    await sleep(2000);
  }

  const { build } = await api.projects.approveSpec.mutate({ id: projectId });
  log(`approved; build ${build.id} started`);
  let lastBuildId = build.id;
  if (queueChange) {
    const change = await api.projects.requestChange.mutate({
      id: projectId,
      request: "Retitle the page again",
    });
    if (change.build.status !== "queued")
      throw new Error(`change was ${change.build.status}, not queued`);
    log(`change ${change.build.id} queued behind build ${build.id}`);
    lastBuildId = change.build.id;
  }
  // Event ids grow across builds, so one afterId follows each build in turn.
  await waitForBuild(projectId, lastBuildId);

  const { project, latestBuild, usage } = await api.projects.get.query({ id: projectId });
  see(projectId, project.status);
  log(
    `status ${project.status}; tokens in ${usage.inputTokens}, out ${usage.outputTokens}, ` +
      `cache read ${usage.cacheReadTokens}, cache write ${usage.cacheCreationTokens}; ` +
      `cost $${usage.costUsd.toFixed(2)}`
  );
  if (project.status !== "live" || !project.previewUrl) {
    throw new Error(latestBuild?.error ?? "build failed");
  }
  for (const path of ["/", "/api/healthz"]) {
    const response = await fetch(`${project.previewUrl}${path}`);
    log(`GET ${project.previewUrl}${path} -> ${response.status}`);
    if (response.status !== 200) throw new Error(`${path} returned ${response.status}`);
  }
  if (concurrent && !queueChange) await checkSite(projectId, project.previewUrl);
  return project.previewUrl;
};

// Cancels a build still running (after a failure or timeout), then deletes everything.
const cleanUp = async (projectId: number) => {
  const log = logAs(projectId);
  for (let tries = 0; tries < 60; tries++) {
    const { project } = await api.projects.get.query({ id: projectId });
    if (project.status !== "building" && project.status !== "spec_generating") break;
    if (project.status === "building" && tries === 0)
      await api.projects.stop.mutate({ id: projectId });
    await sleep(2000);
  }
  await api.projects.delete.mutate({ id: projectId });
  log(`deleted project ${projectId} (deployment, volumes, workspace, rows)`);
};

const health = await fetch(`${base}/api/healthz`).catch(() => undefined);
if (!health?.ok) {
  console.error(`No server at ${base}. Start it with \`make serve\` (or \`make serve/server\`).`);
  process.exit(1);
}

// Approves the run's account, sets its password through its invite link, and signs in.
const signIn = async () => {
  const { token } = await approveEmail(db, account.email);
  await api.invites.accept.mutate({ token, name: "E2E run", password: account.password });
  const response = await fetch(`${base}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify(account),
  });
  if (!response.ok) throw new Error(`sign-in as ${account.email} answered ${response.status}`);
  cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
};

// Takes the run's account, and the business made for it, away again.
const signOutForGood = async () => {
  const { businesses } = await api.session.get.query();
  await removeApproval(db, account.email);
  await db.delete(users).where(eq(users.email, account.email));
  for (const { id } of businesses) await db.delete(tenants).where(eq(tenants.id, id));
};

await signIn();

// Creates a project, drives it to live, and cleans up. Resolves to whether it passed.
const runProject = async (queueChange: boolean): Promise<boolean> => {
  const created = await api.projects.create.mutate({
    name: `e2e ${new Date().toISOString().slice(0, 16)} ${randomBytes(2).toString("hex")}`,
  });
  const log = logAs(created.id);
  log(`created project ${created.id} (${created.slug}, port ${created.webPort})`);
  try {
    const url = await run(created.id, queueChange);
    log(`passed: ${url}`);
    if (keep) {
      console.log(
        `KEEP=1: left running at ${url}. To remove it, sign in at ${origin} as ${account.email} ` +
          `with the password ${account.password}, open the project's settings, and delete it. ` +
          `Then run \`make access/remove EMAIL=${account.email}\`.`
      );
    }
    return true;
  } catch (error) {
    log(`FAILED: ${error instanceof Error ? error.message : error}`);
    return false;
  } finally {
    if (!keep) await cleanUp(created.id);
  }
};

const results = await Promise.all(
  concurrent ? [runProject(true), runProject(false)] : [runProject(false)]
);
if (concurrent && !overlapped) {
  console.error("e2e FAILED: the two projects never built at the same time");
  results.push(false);
}
if (!keep) await signOutForGood().catch((error: unknown) => console.error("cleanup:", error));
await db.$client.end();
if (results.every(Boolean)) {
  console.log(`e2e passed in ${elapsed()}`);
} else {
  console.error(`e2e FAILED after ${elapsed()}`);
  process.exitCode = 1;
}
