// `make e2e`: drives one tiny project from features to a live app against a running server.
// Spends real Claude usage. Exits non-zero on failure.
import { createTRPCClient, httpLink } from "@trpc/client";
import superjson from "superjson";
import type { AppRouter } from "../src/router.ts";

const base = process.env.SCHMEIDE_URL ?? `http://localhost:${process.env.PORT ?? 3100}`;
const api = createTRPCClient<AppRouter>({
  links: [httpLink({ url: `${base}/api/trpc`, transformer: superjson })],
});
const started = Date.now();
const elapsed = () => `${Math.round((Date.now() - started) / 1000)}s`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const fail = (message: string): never => {
  console.error(`e2e FAILED after ${elapsed()}: ${message}`);
  process.exit(1);
};

await fetch(`${base}/api/healthz`).catch(() =>
  fail(`no server at ${base}; start it with \`make serve\` (or \`make serve/server\`)`)
);

const created = await api.projects.create.mutate({
  name: `e2e todos ${new Date().toISOString().slice(0, 16)}`,
});
console.log(
  `[${elapsed()}] created project ${created.id} (${created.slug}, port ${created.webPort})`
);
await api.projects.setFeatures.mutate({
  id: created.id,
  features: "a list of to-dos\nmark a to-do done",
});
await api.projects.generateSpec.mutate({ id: created.id });

for (;;) {
  const { project } = await api.projects.get.query({ id: created.id });
  if (project.status === "spec_ready") {
    console.log(`[${elapsed()}] spec ready:\n${project.spec}\n`);
    break;
  }
  if (project.status !== "spec_generating") fail(`spec generation ended in ${project.status}`);
  await sleep(2000);
}

const { build } = await api.projects.approveSpec.mutate({ id: created.id });
console.log(`[${elapsed()}] approved; build ${build.id} started`);

let afterId = 0;
for (;;) {
  for (const event of await api.builds.events.query({ buildId: build.id, afterId })) {
    console.log(`[${elapsed()}] ${event.kind.padEnd(6)} ${event.message}`);
    afterId = event.id;
  }
  const { project } = await api.projects.get.query({ id: created.id });
  if (project.status === "live" || project.status === "failed") break;
  await sleep(3000);
}

const { project, latestBuild, usage } = await api.projects.get.query({ id: created.id });
console.log(
  `\nstatus ${project.status} after ${elapsed()}; tokens in ${usage.inputTokens}, out ${usage.outputTokens}, ` +
    `cache read ${usage.cacheReadTokens}, cache write ${usage.cacheCreationTokens}; cost $${usage.costUsd.toFixed(2)}`
);
if (project.status !== "live" || !project.previewUrl) fail(latestBuild?.error ?? "build failed");

for (const path of ["/", "/api/healthz"]) {
  const response = await fetch(`${project.previewUrl}${path}`);
  console.log(`GET ${project.previewUrl}${path} -> ${response.status}`);
  if (response.status !== 200) fail(`${path} returned ${response.status}`);
}
console.log(`e2e passed in ${elapsed()}: ${project.previewUrl}`);
