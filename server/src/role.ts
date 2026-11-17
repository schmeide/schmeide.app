import { createServer, type Server } from "node:http";

// SCHMEIDE_ROLE: one image, two Deployments (docs/stage2.md, "The API, the worker, and queues").
// `api` is Fastify and tRPC, `worker` the Temporal worker, `all` both in one process (make serve).
export type RolePlan = { readonly serveApi: boolean; readonly runWorker: boolean };

export const parseRole = (value: string | undefined): RolePlan => {
  const role = value ?? "all";
  if (role !== "all" && role !== "api" && role !== "worker") {
    throw new Error(`SCHMEIDE_ROLE is "${role}"; set it to all (the default), api, or worker.`);
  }
  return { serveApi: role !== "worker", runWorker: role !== "api" };
};

// SCHMEIDE_BUILDS: `on` builds for everyone, `off` (Stage 1 on AKS) builds and hosts nothing, and
// `admins` (Stage 2's rollout, docs/stage2.md) is `on` for platform admins and `off` for the rest.
export type Builds = "on" | "off" | "admins";

export const parseBuilds = (value: string | undefined): Builds => {
  const builds = value ?? "on";
  if (builds !== "on" && builds !== "off" && builds !== "admins") {
    throw new Error(`SCHMEIDE_BUILDS is "${builds}"; set it to on (the default), off, or admins.`);
  }
  return builds;
};

// The worker's only HTTP surface, for Kubernetes probes.
export const createHealthServer = (isLive: () => boolean): Server =>
  createServer((request, response) => {
    const status = request.url !== "/healthz" ? 404 : isLive() ? 200 : 503;
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: status === 200 }));
  });
