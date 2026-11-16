// `make e2e` / `make e2e/fake`: drives the to-do fixture from features to a live app against a
// running server, then deletes the project (deployment, volumes, workspace, rows) unless KEEP=1.
// Exits non-zero on failure.
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createTRPCClient, httpLink } from "@trpc/client";
import superjson from "superjson";
import type { AppRouter } from "../src/router.ts";

const base = process.env.SCHMEIDE_URL ?? `http://localhost:${process.env.PORT ?? 3100}`;
const keep = process.env.KEEP === "1";
const timeoutMs = Number(process.env.E2E_TIMEOUT_MIN ?? 60) * 60_000;
const features = readFileSync(new URL("./todo-features.txt", import.meta.url), "utf8").trim();

const api = createTRPCClient<AppRouter>({
  links: [httpLink({ url: `${base}/api/trpc`, transformer: superjson })],
});
const started = Date.now();
const elapsed = () => `${Math.round((Date.now() - started) / 1000)}s`;
const log = (message: string) => console.log(`[${elapsed()}] ${message}`);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const checkDeadline = () => {
  if (Date.now() - started > timeoutMs) throw new Error(`timed out after ${elapsed()}`);
};

const run = async (projectId: number) => {
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
  let afterId = 0;
  for (;;) {
    checkDeadline();
    for (const event of await api.builds.events.query({ buildId: build.id, afterId })) {
      log(`${event.kind.padEnd(6)} ${event.message}`);
      afterId = event.id;
    }
    const { project } = await api.projects.get.query({ id: projectId });
    if (project.status === "live" || project.status === "failed") break;
    await sleep(3000);
  }

  const { project, latestBuild, usage } = await api.projects.get.query({ id: projectId });
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
  return project.previewUrl;
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
  log(`deleted project ${projectId} (deployment, volumes, workspace, rows)`);
};

const health = await fetch(`${base}/api/healthz`).catch(() => undefined);
if (!health?.ok) {
  console.error(`No server at ${base}. Start it with \`make serve\` (or \`make serve/server\`).`);
  process.exit(1);
}

const created = await api.projects.create.mutate({
  name: `e2e ${new Date().toISOString().slice(0, 16)} ${randomBytes(2).toString("hex")}`,
});
log(`created project ${created.id} (${created.slug}, port ${created.webPort})`);
try {
  const url = await run(created.id);
  console.log(`e2e passed in ${elapsed()}: ${url}`);
  if (keep) {
    console.log(
      `KEEP=1: left running at ${url}. Remove it with:\n` +
        `  curl -s -H content-type:application/json http://localhost:3100/api/trpc/projects.delete -d '{"json":{"id":${created.id}}}'\n` +
        "  (needs `make serve` or `make serve/server` running)"
    );
  }
} catch (error) {
  console.error(`e2e FAILED after ${elapsed()}: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
} finally {
  if (!keep) await cleanUp(created.id);
}
