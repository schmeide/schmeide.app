import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  contextTarFlags,
  createAcr,
  runRequest,
  taskYaml,
  tokenRequest,
  TASKS_API_VERSION,
} from "../acr.ts";

const dir = mkdtempSync(join(tmpdir(), "acr-"));
const tokenFile = join(dir, "token");
writeFileSync(tokenFile, "federated-jwt\n");
const archive = join(dir, "context.tar.gz");
writeFileSync(archive, "tar bytes");

const identity = {
  clientId: "worker-client",
  tenantId: "entra-tenant",
  federatedTokenFile: tokenFile,
  authorityHost: "https://login.microsoftonline.com/",
};
const commit = "c".repeat(40);
const registry =
  "https://management.azure.com/subscriptions/sub/resourceGroups/rg/providers/Microsoft.ContainerRegistry/registries/schmeide";

type Call = { url: string; method: string; body?: string; headers: Record<string, string> };

// Answers each call from `routes` by the first key its URL contains, and records it.
const fakeFetch = (routes: Readonly<Record<string, (call: Call) => Response>>) => {
  const calls: Call[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const call = {
      url: String(input),
      method: init?.method ?? "GET",
      body:
        init?.body instanceof URLSearchParams
          ? init.body.toString()
          : typeof init?.body === "string"
            ? init.body
            : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
    };
    calls.push(call);
    const route = Object.keys(routes).find((key) => call.url.includes(key));
    if (!route) throw new Error(`unexpected ${call.method} ${call.url}`);
    return routes[route](call);
  };
  return { calls, fetch: fetch as typeof globalThis.fetch };
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const token = () => json({ access_token: "arm-token", expires_in: 3600 });

const acrWith = (fetch: typeof globalThis.fetch) =>
  createAcr({
    identity,
    subscriptionId: "sub",
    resourceGroup: "rg",
    name: "schmeide",
    loginServer: "schmeide.azurecr.io",
    fetch,
    pollMs: 1,
  });

describe("tokenRequest", () => {
  it("exchanges the federated token for one scope at the tenant's authority", () => {
    const { url, body } = tokenRequest(identity, "jwt", "https://management.azure.com/.default");
    expect(url).toBe("https://login.microsoftonline.com/entra-tenant/oauth2/v2.0/token");
    expect(Object.fromEntries(body)).toEqual({
      grant_type: "client_credentials",
      client_id: "worker-client",
      client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      client_assertion: "jwt",
      scope: "https://management.azure.com/.default",
    });
  });
});

describe("taskYaml and runRequest", () => {
  it("only builds and pushes both images tagged with the commit", () => {
    const yaml = taskYaml(3, "notes", commit);
    // A cmd step runs next to the run's registry token and Docker socket (#214); a build does not.
    expect(yaml).not.toContain("cmd:");
    expect(yaml).toContain(
      `- build: -t {{.Run.Registry}}/apps/t3/notes/web:${commit} -f frontend/Dockerfile .`
    );
    expect(yaml).toContain(
      `- build: -t {{.Run.Registry}}/apps/t3/notes/api:${commit} -f backend/Dockerfile .`
    );
    expect(yaml).toContain(
      `  - push:\n    - {{.Run.Registry}}/apps/t3/notes/web:${commit}\n    - {{.Run.Registry}}/apps/t3/notes/api:${commit}`
    );
  });

  it("runs as the caller on the uploaded context", () => {
    const request = runRequest("source/123.tar.gz", "version: v1.1.0\n");
    expect(request).toMatchObject({
      type: "EncodedTaskRunRequest",
      sourceLocation: "source/123.tar.gz",
      credentials: { sourceRegistry: { identity: "[caller]" } },
      platform: { os: "Linux" },
    });
    expect(Buffer.from(request.encodedTaskContent, "base64").toString()).toBe("version: v1.1.0\n");
  });

  it("stops the run well under the deploy activity's 60 minute budget", () => {
    // 35 minutes left covers the clone, two rollouts, and two health checks.
    expect(runRequest("source/123.tar.gz", "version: v1.1.0\n").timeout).toBe(25 * 60);
  });
});

describe("createAcr", () => {
  it("uploads the context, schedules the run, and follows it until it succeeds", async () => {
    const statuses = ["Queued", "Running", "Succeeded"];
    const { calls, fetch } = fakeFetch({
      "login.microsoftonline.com": token,
      listBuildSourceUploadUrl: () =>
        json({ uploadUrl: "https://blob.example/upload?sas", relativePath: "source/1.tar.gz" }),
      "blob.example/upload": () => new Response(null, { status: 201 }),
      scheduleRun: () => json({ properties: { runId: "ca1" } }),
      "runs/ca1": () => json({ properties: { status: statuses.shift() } }),
    });
    const queued: string[] = [];

    await acrWith(fetch).build(archive, "version: v1.1.0\n", {
      onQueued: (id) => queued.push(id),
    });

    expect(queued).toEqual(["ca1"]);
    expect(calls.filter((call) => call.url.includes("login.")).length).toBe(1);
    const upload = calls.find((call) => call.url.startsWith("https://blob.example"));
    expect(upload?.method).toBe("PUT");
    expect(upload?.headers["x-ms-blob-type"]).toBe("BlockBlob");
    const schedule = calls.find((call) => call.url.includes("scheduleRun"));
    expect(schedule?.url).toBe(`${registry}/scheduleRun?api-version=${TASKS_API_VERSION}`);
    expect(schedule?.headers.authorization).toBe("Bearer arm-token");
    expect(JSON.parse(schedule?.body ?? "{}")).toMatchObject({ sourceLocation: "source/1.tar.gz" });
  });

  it("fails with the end of the run's log and where to read it", async () => {
    const { fetch } = fakeFetch({
      "login.microsoftonline.com": token,
      listBuildSourceUploadUrl: () =>
        json({ uploadUrl: "https://blob.example/upload", relativePath: "source/1.tar.gz" }),
      "blob.example/upload": () => new Response(null, { status: 201 }),
      scheduleRun: () => json({ properties: { runId: "ca2" } }),
      "runs/ca2/listLogSasUrl": () => json({ logLink: "https://blob.example/log?sas" }),
      "runs/ca2": () => json({ properties: { status: "Failed" } }),
      "blob.example/log": () => new Response("npm ERR! vite failed"),
    });

    await expect(acrWith(fetch).build(archive, "")).rejects.toThrow(
      /ACR run ca2\) ended Failed\.\nnpm ERR! vite failed\nFull log: https:\/\/blob.example\/log\?sas/
    );
  });

  it("says who could not sign in", async () => {
    const { fetch } = fakeFetch({
      "login.microsoftonline.com": () =>
        new Response("AADSTS70021: no federated credential", { status: 400 }),
    });
    await expect(acrWith(fetch).armToken()).rejects.toThrow(
      /worker-client answered 400: AADSTS70021/
    );
  });

  it("deletes both of an app's repositories with registry tokens", async () => {
    const { calls, fetch } = fakeFetch({
      "login.microsoftonline.com": token,
      "/oauth2/exchange": () => json({ refresh_token: "refresh" }),
      "/oauth2/token": (call) =>
        json({ access_token: new URLSearchParams(call.body).get("scope") }),
      "/acr/v1/apps/t3/notes/web": () => new Response(null, { status: 202 }),
      "/acr/v1/apps/t3/notes/api": () => new Response(null, { status: 404 }),
    });

    await acrWith(fetch).deleteImages(3, "notes");

    const deletes = calls.filter((call) => call.method === "DELETE");
    expect(deletes.map((call) => [call.url, call.headers.authorization])).toEqual([
      [
        "https://schmeide.azurecr.io/acr/v1/apps/t3/notes/web",
        "Bearer repository:apps/t3/notes/web:delete",
      ],
      [
        "https://schmeide.azurecr.io/acr/v1/apps/t3/notes/api",
        "Bearer repository:apps/t3/notes/api:delete",
      ],
    ]);
  });

  const images = { repos: ["apps/t3/notes/web", "apps/t3/notes/api"], tag: "abc" };
  const tag = (repo: string, status: number) =>
    [
      `/acr/v1/${repo}/_tags/abc`,
      () => (status === 200 ? json({}) : new Response(null, { status })),
    ] as const;

  it("cancels the run when the deploy is aborted and does not start another", async () => {
    const controller = new AbortController();
    const { calls, fetch } = fakeFetch({
      "login.microsoftonline.com": token,
      listBuildSourceUploadUrl: () =>
        json({ uploadUrl: "https://blob.example/upload", relativePath: "source/1.tar.gz" }),
      "blob.example/upload": () => new Response(null, { status: 201 }),
      scheduleRun: () => json({ properties: { runId: "ca1" } }),
      "runs/ca1/cancel": () => new Response(null, { status: 200 }),
      "runs/ca1": () => {
        controller.abort();
        return json({ properties: { status: "Running" } });
      },
    });

    await expect(
      acrWith(fetch).build(archive, "version: v1.1.0\n", { signal: controller.signal })
    ).rejects.toThrow();

    expect(calls.filter((call) => call.url.includes("scheduleRun"))).toHaveLength(1);
    const cancel = calls.find((call) => call.url.includes("/runs/ca1/cancel"));
    expect(cancel?.method).toBe("POST");
    expect(cancel?.url).toBe(`${registry}/runs/ca1/cancel?api-version=${TASKS_API_VERSION}`);
    expect(cancel?.headers.authorization).toBe("Bearer arm-token");
  });

  it("follows a run from an earlier attempt and does not start another", async () => {
    const statuses = ["Running", "Succeeded"];
    const { calls, fetch } = fakeFetch({
      "login.microsoftonline.com": token,
      "runs/ca9": () => json({ properties: { status: statuses.shift() } }),
    });

    await acrWith(fetch).build(archive, "version: v1.1.0\n", { runId: "ca9" });

    expect(calls.some((call) => call.url.includes("scheduleRun"))).toBe(false);
    expect(calls.some((call) => call.url.includes("listBuildSourceUploadUrl"))).toBe(false);
    expect(calls.filter((call) => call.url.includes("/runs/ca9"))).toHaveLength(2);
  });

  it("cancels a followed run when the deploy is aborted", async () => {
    const controller = new AbortController();
    const { calls, fetch } = fakeFetch({
      "login.microsoftonline.com": token,
      "runs/ca9/cancel": () => new Response(null, { status: 200 }),
      "runs/ca9": () => {
        controller.abort();
        return json({ properties: { status: "Running" } });
      },
    });

    await expect(
      acrWith(fetch).build(archive, "", { runId: "ca9", signal: controller.signal })
    ).rejects.toThrow();

    expect(calls.some((call) => call.url.includes("scheduleRun"))).toBe(false);
    expect(
      calls.filter((call) => call.method === "POST" && call.url.includes("/cancel"))
    ).toHaveLength(1);
  });

  it("skips the run when both commit tags already exist", async () => {
    const { calls, fetch } = fakeFetch({
      "login.microsoftonline.com": token,
      "/oauth2/exchange": () => json({ refresh_token: "refresh" }),
      "/oauth2/token": (call) =>
        json({ access_token: new URLSearchParams(call.body).get("scope") }),
      ...Object.fromEntries([tag("apps/t3/notes/web", 200), tag("apps/t3/notes/api", 200)]),
    });
    const skipped: string[] = [];

    await acrWith(fetch).build(archive, "version: v1.1.0\n", {
      images,
      onSkipped: () => skipped.push("skipped"),
    });

    expect(skipped).toEqual(["skipped"]);
    expect(calls.some((call) => call.url.includes("scheduleRun"))).toBe(false);
    expect(calls.some((call) => call.url.includes("listBuildSourceUploadUrl"))).toBe(false);
    expect(
      calls
        .filter((call) => call.url.includes("/oauth2/token"))
        .map((call) => new URLSearchParams(call.body).get("scope"))
    ).toEqual([
      "repository:apps/t3/notes/web:metadata_read",
      "repository:apps/t3/notes/api:metadata_read",
    ]);
  });

  it("starts a run when one commit tag is missing", async () => {
    const { calls, fetch } = fakeFetch({
      "login.microsoftonline.com": token,
      "/oauth2/exchange": () => json({ refresh_token: "refresh" }),
      "/oauth2/token": () => json({ access_token: "pull" }),
      ...Object.fromEntries([tag("apps/t3/notes/web", 200), tag("apps/t3/notes/api", 404)]),
      listBuildSourceUploadUrl: () =>
        json({ uploadUrl: "https://blob.example/upload", relativePath: "source/1.tar.gz" }),
      "blob.example/upload": () => new Response(null, { status: 201 }),
      scheduleRun: () => json({ properties: { runId: "ca3" } }),
      "runs/ca3": () => json({ properties: { status: "Succeeded" } }),
    });

    await acrWith(fetch).build(archive, "version: v1.1.0\n", { images });

    expect(calls.filter((call) => call.url.includes("scheduleRun"))).toHaveLength(1);
  });
});

describe("contextTarFlags", () => {
  it("writes GNU tar's own format without extended attributes, which ACR cannot read", () => {
    expect(contextTarFlags("tar (GNU tar) 1.35\nCopyright (C) 2023")).toEqual([
      "--format=gnu",
      "--no-xattrs",
      "--no-acls",
      "--no-selinux",
      "--exclude=.git",
    ]);
  });

  it("keeps bsdtar's default format and leaves out macOS metadata", () => {
    expect(contextTarFlags("bsdtar 3.5.3 - libarchive 3.7.4")).toEqual([
      "--no-xattrs",
      "--no-mac-metadata",
      "--exclude=.git",
    ]);
  });
});
