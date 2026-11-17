import { describe, expect, it } from "vitest";
import { createKube, KubeError } from "../client.ts";

type Call = { readonly method: string; readonly url: URL; readonly init: RequestInit };

// Answers each call with the next response and keeps what was asked.
const fakeApi = (...responses: readonly Response[]) => {
  const calls: Call[] = [];
  const queue = [...responses];
  const fetchFn: typeof fetch = async (input, init = {}) => {
    calls.push({ method: init.method ?? "GET", url: new URL(String(input)), init });
    const next = queue.shift();
    if (!next) throw new Error("no response queued");
    return next;
  };
  const kube = createKube({
    server: "https://10.0.0.1:443",
    namespace: "schmeide-builds",
    token: async () => "projected-token",
    fetch: fetchFn,
  });
  return { kube, calls };
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("createKube", () => {
  it("creates a Job in the builds namespace with the service account token", async () => {
    const { kube, calls } = fakeApi(json({ metadata: { name: "agent-1-0", uid: "u1" } }, 201));

    const job = await kube.createJob({ metadata: { name: "agent-1-0" } });

    expect(job.metadata.uid).toBe("u1");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url.pathname).toBe("/apis/batch/v1/namespaces/schmeide-builds/jobs");
    expect(new Headers(calls[0].init.headers).get("authorization")).toBe("Bearer projected-token");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ metadata: { name: "agent-1-0" } });
  });

  it("answers undefined for a Job that does not exist, and throws on other errors", async () => {
    const { kube } = fakeApi(json({ reason: "NotFound" }, 404), json({ reason: "Forbidden" }, 403));

    expect(await kube.getJob("agent-1-0")).toBeUndefined();
    await expect(kube.getJob("agent-1-0")).rejects.toMatchObject({ status: 403 });
  });

  it("tells an existing name apart from other failures", async () => {
    const { kube } = fakeApi(json({ reason: "AlreadyExists" }, 409));

    const error = await kube.createJob({}).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(KubeError);
    expect((error as KubeError).status).toBe(409);
  });

  it("deletes a Job with the propagation policy, and a missing one is already gone", async () => {
    const { kube, calls } = fakeApi(json({}), json({}, 404));

    await kube.deleteJob("agent-1-0", "Foreground");
    await kube.deleteJob("agent-1-0", "Foreground");

    expect(calls[0].method).toBe("DELETE");
    expect(calls[0].url.pathname).toBe("/apis/batch/v1/namespaces/schmeide-builds/jobs/agent-1-0");
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({
      propagationPolicy: "Foreground",
    });
  });

  it("lists Jobs and pods by label", async () => {
    const { kube, calls } = fakeApi(
      json({ items: [{ metadata: { name: "agent-1-0" } }] }),
      json({ items: [] })
    );

    expect(await kube.listJobs("schmeide.app/build=1")).toHaveLength(1);
    expect(await kube.listPods("job-name=agent-1-0")).toEqual([]);
    expect(calls[0].url.searchParams.get("labelSelector")).toBe("schmeide.app/build=1");
    expect(calls[1].url.pathname).toBe("/api/v1/namespaces/schmeide-builds/pods");
  });

  it("creates and deletes Secrets by name", async () => {
    const { kube, calls } = fakeApi(json({}, 201), json({}), json({}, 404), json({}, 404));

    await kube.createSecret({ metadata: { name: "agent-1-0" } });
    expect(await kube.secretExists("agent-1-0")).toBe(true);
    expect(await kube.secretExists("agent-1-0")).toBe(false);
    await kube.deleteSecret("agent-1-0");

    expect(calls.map((call) => `${call.method} ${call.url.pathname}`)).toEqual([
      "POST /api/v1/namespaces/schmeide-builds/secrets",
      "GET /api/v1/namespaces/schmeide-builds/secrets/agent-1-0",
      "GET /api/v1/namespaces/schmeide-builds/secrets/agent-1-0",
      "DELETE /api/v1/namespaces/schmeide-builds/secrets/agent-1-0",
    ]);
  });

  it("follows a container's log line by line with each line's time", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        // Lines split across chunks, as a stream delivers them.
        controller.enqueue(encoder.encode("2026-11-17T10:00:00.1Z first\n2026-11-17T10:00:0"));
        controller.enqueue(encoder.encode('1.2Z {"type":"result"}\n2026-11-17T10:00:02.3Z last'));
        controller.close();
      },
    });
    const { kube, calls } = fakeApi(new Response(body));

    const lines = [];
    for await (const line of kube.logLines("agent-1-0-abcde", "agent", {
      sinceTime: "2026-11-17T09:00:00Z",
    }))
      lines.push(line);

    expect(lines).toEqual([
      { time: "2026-11-17T10:00:00.1Z", text: "first" },
      { time: "2026-11-17T10:00:01.2Z", text: '{"type":"result"}' },
      { time: "2026-11-17T10:00:02.3Z", text: "last" },
    ]);
    expect(calls[0].url.pathname).toBe(
      "/api/v1/namespaces/schmeide-builds/pods/agent-1-0-abcde/log"
    );
    expect(Object.fromEntries(calls[0].url.searchParams)).toEqual({
      container: "agent",
      follow: "true",
      timestamps: "true",
      sinceTime: "2026-11-17T09:00:00Z",
    });
  });

  it("asks the API server whether the worker may do something", async () => {
    const { kube, calls } = fakeApi(json({ status: { allowed: true } }, 201));

    expect(await kube.canI("create", "batch", "jobs")).toBe(true);
    expect(calls[0].url.pathname).toBe("/apis/authorization.k8s.io/v1/selfsubjectaccessreviews");
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({
      spec: {
        resourceAttributes: {
          namespace: "schmeide-builds",
          verb: "create",
          group: "batch",
          resource: "jobs",
        },
      },
    });
  });
});
