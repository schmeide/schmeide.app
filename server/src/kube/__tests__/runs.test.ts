import { describe, expect, it } from "vitest";
import { KubeError, type Job, type Kube, type LogLine, type Pod } from "../client.ts";
import type { RunJob } from "../jobs.ts";
import { deleteRun, followRun, startRun, sweepRuns, type Position } from "../runs.ts";

const run: RunJob = {
  kind: "agent",
  buildId: 12,
  round: 0,
  tenantId: 3,
  projectId: 7,
  image: "image",
  postgresImage: "postgres",
  repo: "ssh://forgejo/t3/notes.git",
  knownHosts: false,
  env: {},
};

type State = {
  jobs: Map<string, Job>;
  secrets: Set<string>;
  // The pod each call to listPods sees, in turn; the last one stays.
  pods: Pod[][];
  // The log each follow sees, in turn; an Error breaks the stream there.
  logs: (LogLine | Error)[][];
  sinceTimes: (string | undefined)[];
  deleted: string[];
};

// An API server in memory, just enough for the runs.
const fakeKube = (overrides: Partial<State> = {}) => {
  const state: State = {
    jobs: new Map(),
    secrets: new Set(),
    pods: [],
    logs: [],
    sinceTimes: [],
    deleted: [],
    ...overrides,
  };
  const kube = {
    namespace: "schmeide-builds",
    createJob: async (job: object) => {
      const { metadata } = job as Job;
      if (state.jobs.has(metadata.name)) throw new KubeError(409, "exists");
      const created = { metadata: { ...metadata, uid: `uid-${metadata.name}` } };
      state.jobs.set(metadata.name, created);
      return created;
    },
    getJob: async (name: string) => state.jobs.get(name),
    listJobs: async () => [...state.jobs.values()],
    deleteJob: async (name: string, policy: string) => {
      state.deleted.push(`${name} ${policy}`);
      state.jobs.delete(name);
    },
    createSecret: async (secret: object) => {
      state.secrets.add((secret as Job).metadata.name);
    },
    secretExists: async (name: string) => state.secrets.has(name),
    deleteSecret: async (name: string) => {
      state.secrets.delete(name);
    },
    listPods: async () => (state.pods.length > 1 ? state.pods.shift() : state.pods[0]) ?? [],
    logLines: async function* (_pod: string, _container: string, options = {}) {
      state.sinceTimes.push((options as { sinceTime?: string }).sinceTime);
      for (const line of state.logs.shift() ?? []) {
        if (line instanceof Error) throw line;
        yield line;
      }
    },
    canI: async () => true,
  } satisfies Kube;
  return { kube, state };
};

const pod = (state: Pod["status"] extends infer S ? S : never): Pod => ({
  metadata: { name: "agent-12-0-x" },
  status: state,
});
const running = pod({ containerStatuses: [{ name: "agent", state: { running: {} } }] });
const exited = (exitCode: number) =>
  pod({ containerStatuses: [{ name: "agent", state: { terminated: { exitCode } } }] });

describe("startRun", () => {
  it("creates the Job, then its Secret, owned by it", async () => {
    const { kube, state } = fakeKube();

    const started = await startRun(kube, run, async () => ({ prompt: "build" }));

    expect(started).toBe("created");
    expect([...state.jobs.keys()]).toEqual(["agent-12-0"]);
    expect(state.secrets).toEqual(new Set(["agent-12-0"]));
  });

  it("adopts a Job of the same name instead of starting a second agent", async () => {
    const { kube, state } = fakeKube();
    await startRun(kube, run, async () => ({ prompt: "build" }));
    const asked: string[] = [];

    const started = await startRun(kube, run, async () => {
      asked.push("secret data");
      return {};
    });

    expect(started).toBe("adopted");
    expect(asked).toEqual([]);
    expect(state.jobs.size).toBe(1);
  });

  it("starts again when a worker died between creating the Job and its Secret", async () => {
    const { kube, state } = fakeKube();
    state.jobs.set("agent-12-0", { metadata: { name: "agent-12-0", uid: "old" } });

    const started = await startRun(kube, run, async () => ({ prompt: "build" }));

    expect(started).toBe("created");
    expect(state.deleted).toEqual(["agent-12-0 Foreground"]);
    expect(state.secrets.has("agent-12-0")).toBe(true);
  });
});

describe("followRun", () => {
  const follow = (kube: Kube, resumeAt?: Position) => {
    const lines: string[] = [];
    const replayed: string[] = [];
    const positions: Position[] = [];
    const waiting: string[] = [];
    const exit = followRun(kube, "agent-12-0", "agent", {
      signal: new AbortController().signal,
      resumeAt,
      pollMs: 1,
      onLine: async (text, again) => {
        (again ? replayed : lines).push(text);
      },
      onPosition: (position) => {
        positions.push(position);
      },
      onWaiting: async (why) => {
        waiting.push(why);
      },
    });
    return { exit, lines, replayed, positions, waiting };
  };

  it("waits for the pod, follows its log, and answers its exit code", async () => {
    const { kube } = fakeKube({
      pods: [
        [],
        [
          pod({
            containerStatuses: [{ name: "agent", state: { waiting: { reason: "Pulling" } } }],
          }),
        ],
        [running],
        [exited(0)],
      ],
      logs: [[{ time: "2026-11-17T10:00:00.1Z", text: "hello" }]],
    });
    kube.getJob = async () => ({ metadata: { name: "agent-12-0" } });

    const { exit, lines, waiting } = follow(kube);

    expect(await exit).toBe(0);
    expect(lines).toEqual(["hello"]);
    expect(waiting).toEqual(["the cluster has not started it yet"]);
  });

  it("picks the log up after the last line it saw when the stream drops", async () => {
    const { kube, state } = fakeKube({
      pods: [[running], [running], [exited(3)]],
      logs: [
        [
          { time: "2026-11-17T10:00:01.2Z", text: "one" },
          { time: "2026-11-17T10:00:01.25Z", text: "two" },
        ],
        // The API server repeats from the whole second; lines already seen are skipped.
        [
          { time: "2026-11-17T10:00:01.2Z", text: "one" },
          { time: "2026-11-17T10:00:01.25Z", text: "two" },
          { time: "2026-11-17T10:00:02Z", text: "three" },
        ],
      ],
    });
    kube.getJob = async () => ({ metadata: { name: "agent-12-0" } });

    const { exit, lines } = follow(kube);

    expect(await exit).toBe(3);
    expect(lines).toEqual(["one", "two", "three"]);
    expect(state.sinceTimes).toEqual([undefined, "2026-11-17T10:00:01.25Z"]);
  });

  it("reconnects when the stream fails, as fetch does after five quiet minutes", async () => {
    const { kube, state } = fakeKube({
      pods: [[running], [running], [exited(0)]],
      logs: [
        [{ time: "2026-11-17T10:00:01Z", text: "one" }, new TypeError("terminated")],
        [
          { time: "2026-11-17T10:00:01Z", text: "one" },
          { time: "2026-11-17T10:06:00Z", text: "two" },
        ],
      ],
    });
    kube.getJob = async () => ({ metadata: { name: "agent-12-0" } });

    const { exit, lines } = follow(kube);

    expect(await exit).toBe(0);
    expect(lines).toEqual(["one", "two"]);
    expect(state.sinceTimes).toEqual([undefined, "2026-11-17T10:00:01Z"]);
  });

  it("hands lines a dead follower already handled back as replayed, from the start of the log", async () => {
    const at = "2026-11-17T10:00:01Z";
    const { kube, state } = fakeKube({
      pods: [[running], [exited(0)]],
      logs: [
        [
          { time: "2026-11-17T10:00:00Z", text: "zero" },
          { time: at, text: "one" },
          { time: at, text: "two" },
          { time: "2026-11-17T10:00:02Z", text: "three" },
        ],
      ],
    });
    kube.getJob = async () => ({ metadata: { name: "agent-12-0" } });

    const { exit, lines, replayed, positions } = follow(kube, { time: at, count: 1 });

    expect(await exit).toBe(0);
    expect(replayed).toEqual(["zero", "one"]);
    expect(lines).toEqual(["two", "three"]);
    expect(state.sinceTimes).toEqual([undefined]);
    expect(positions.at(-1)).toEqual({ time: "2026-11-17T10:00:02Z", count: 1 });
  });

  it("keeps lines that share a time, and skips only those already seen", async () => {
    const at = "2026-11-17T10:00:01Z";
    const { kube } = fakeKube({
      pods: [[running], [running], [exited(0)]],
      logs: [
        [
          { time: at, text: "one" },
          { time: at, text: "two" },
        ],
        [
          { time: at, text: "one" },
          { time: at, text: "two" },
          { time: at, text: "three" },
        ],
      ],
    });
    kube.getJob = async () => ({ metadata: { name: "agent-12-0" } });

    const { exit, lines } = follow(kube);

    expect(await exit).toBe(0);
    expect(lines).toEqual(["one", "two", "three"]);
  });

  it("fails when the Job fails before its pod ever ran", async () => {
    const { kube } = fakeKube({ pods: [[]] });
    kube.getJob = async () => ({
      metadata: { name: "agent-12-0" },
      status: {
        conditions: [
          {
            type: "Failed",
            status: "True",
            reason: "DeadlineExceeded",
            message: "Job was active longer than specified deadline",
          },
        ],
      },
    });

    await expect(follow(kube).exit).rejects.toThrow(/DeadlineExceeded/);
  });

  it("fails when the Job is gone", async () => {
    const { kube } = fakeKube();

    await expect(follow(kube).exit).rejects.toThrow(/agent-12-0 is gone/);
  });
});

describe("deleteRun", () => {
  it("deletes the Job and its Secret and waits until the Job is gone", async () => {
    const { kube, state } = fakeKube();
    await startRun(kube, run, async () => ({}));

    await deleteRun(kube, "agent-12-0");

    expect(state.jobs.size).toBe(0);
    expect(state.secrets.size).toBe(0);
    expect(state.deleted).toEqual(["agent-12-0 Foreground"]);
  });
});

describe("deleteRun when the Job will not go", () => {
  it("throws, so a retry backs off instead of adopting a Job that is terminating", async () => {
    const { kube } = fakeKube();
    kube.getJob = async () => ({ metadata: { name: "agent-12-0" } });

    await expect(deleteRun(kube, "agent-12-0", 0)).rejects.toThrow(/agent-12-0 is still there/);
  });
});

describe("sweepRuns", () => {
  it("deletes the runs of builds that are not running, and answers them", async () => {
    const { kube, state } = fakeKube();
    await startRun(kube, run, async () => ({}));
    await startRun(kube, { ...run, buildId: 13 }, async () => ({}));

    const swept = await sweepRuns(kube, (buildId) => buildId === 13);

    expect(swept.map((job) => job.metadata.name)).toEqual(["agent-12-0"]);
    expect([...state.jobs.keys()]).toEqual(["agent-13-0"]);
  });
});
