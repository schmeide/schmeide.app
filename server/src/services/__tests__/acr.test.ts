import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAcr, runRequest, taskYaml, tokenRequest, TASKS_API_VERSION } from "../acr.ts";

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
  it("builds the frontend, then pushes both images tagged with the commit", () => {
    const yaml = taskYaml(3, "notes", commit);
    expect(yaml).toContain("npm run build -w frontend");
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
});
