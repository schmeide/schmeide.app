// The activities in Kubernetes mode (SCHMEIDE_RUNNER=kubernetes), with Forgejo standing in as
// bare git repositories on disk and the Kubernetes API as a map of Jobs whose pods have exited.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockActivityEnvironment } from "@temporalio/testing";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { createDb } from "../../db/client.ts";
import { buildFiles, builds, files, projects, usage } from "../../db/schema.ts";
import type { Cluster, Job, Kube, LogLine, Pod } from "../../kube/client.ts";
import { KubeError } from "../../kube/client.ts";
import { appendEvent, listEvents } from "../../services/builds.ts";
import type { Forgejo } from "../../services/forgejo.ts";
import type { AppDatabases } from "../../services/appDatabases.ts";
import { createProject, transition } from "../../services/projects.ts";
import {
  ATTACHMENTS_REFUSED,
  GIT_CONFIG,
  POD_NOTE,
  createActivities,
  gitConfigFile,
  sweepLeftoverRuns,
  PLATFORM_FILES,
  type Config,
  type Hosting,
  type KubeRunner,
} from "../activities.ts";
import { DEMO_TENANT_ID } from "../../__tests__/testAuth.ts";

const db = createDb(process.env.DATABASE_URL ?? "");
afterAll(() => db.$client.end());
const deps = { db, workflows: {} as never, taskQueue: "test" };

type Script = { readonly lines: readonly (string | LogLine)[]; readonly exit: number };

const fakeKube = (scripts: Readonly<Record<string, Script>>) => {
  const jobs = new Map<string, object>();
  const secrets = new Map<string, Record<string, string>>();
  const deleted: string[] = [];
  const kube = {
    namespace: "schmeide-builds",
    createJob: async (job: object) => {
      const { metadata } = job as Job;
      if (jobs.has(metadata.name)) throw new KubeError(409, "exists");
      jobs.set(metadata.name, job);
      return { metadata: { ...metadata, uid: `uid-${metadata.name}` } };
    },
    getJob: async (name: string) => (jobs.get(name) as Job | undefined) ?? undefined,
    listJobs: async (selector: string) =>
      [...jobs.values()].filter((job) => {
        const [key, value] = selector.split("=");
        const label = (job as Job).metadata.labels?.[key];
        return value === undefined ? label !== undefined : label === value;
      }) as Job[],
    deleteJob: async (name: string) => {
      deleted.push(name);
      jobs.delete(name);
    },
    createSecret: async (secret: object) => {
      const { metadata, stringData } = secret as Job & { stringData: Record<string, string> };
      secrets.set(metadata.name, stringData);
    },
    secretExists: async (name: string) => secrets.has(name),
    deleteSecret: async (name: string) => {
      secrets.delete(name);
    },
    listPods: async (selector: string): Promise<readonly Pod[]> => {
      const name = selector.replace("job-name=", "");
      const container = name.split("-")[0];
      return [
        {
          metadata: { name: `${name}-pod` },
          status: {
            containerStatuses: [
              { name: container, state: { terminated: { exitCode: scripts[name]?.exit ?? 0 } } },
            ],
          },
        },
      ];
    },
    logLines: async function* (pod: string) {
      for (const line of scripts[pod.replace(/-pod$/, "")]?.lines ?? [])
        yield typeof line === "string" ? { time: new Date().toISOString(), text: line } : line;
    },
    canI: async () => true,
  } satisfies Kube;
  return { kube, jobs, secrets, deleted };
};

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    env: { ...process.env, GIT_CONFIG_GLOBAL: join(cwd, "..", "gitconfig") },
  })
    .toString()
    .trim();

// Forgejo as bare repositories under `root`, with its deploy keys and protected branches noted.
const fakeForgejo = (root: string) => {
  const bare = (org: string, repo: string) => join(root, "forgejo", org, `${repo}.git`);
  const keys: { title: string; key: string; readOnly: boolean }[] = [];
  const protectedMain: string[] = [];
  const deletedRepos: string[] = [];
  const forgejo = {
    whoami: async () => "schmeide-platform",
    ensureRepo: async (org: string, repo: string) => {
      if (existsSync(bare(org, repo))) return;
      mkdirSync(bare(org, repo), { recursive: true });
      git(bare(org, repo), "init", "-q", "--bare");
    },
    branchCommit: async (org: string, repo: string, branch: string) => {
      if (!existsSync(bare(org, repo))) return undefined;
      try {
        return git(bare(org, repo), "rev-parse", "--verify", "-q", `refs/heads/${branch}`);
      } catch {
        return undefined;
      }
    },
    protectMain: async (org: string, repo: string) => {
      protectedMain.push(`${org}/${repo}`);
    },
    addDeployKey: async (
      _org: string,
      _repo: string,
      title: string,
      key: string,
      readOnly: boolean
    ) => {
      keys.push({ title, key, readOnly });
    },
    deleteDeployKeys: async (_org: string, _repo: string, pick: (title: string) => boolean) => {
      for (const key of keys.filter(({ title }) => pick(title))) keys.splice(keys.indexOf(key), 1);
    },
    deleteRepo: async (org: string, repo: string) => {
      deletedRepos.push(`${org}/${repo}`);
    },
    remote: (org: string, repo: string) => ({ url: bare(org, repo), env: {} }),
    sshRemote: (org: string, repo: string) => `ssh://forgejo/${org}/${repo}.git`,
  } satisfies Forgejo;
  return { forgejo, bare, keys, protectedMain, deletedRepos };
};

// The tenant namespaces as a map of applied objects by path, every Deployment rolled out at once;
// ACR as a record of each build's context; Postgres as a map of databases to passwords.
const fakeHosting = (root: string) => {
  const objects = new Map<string, Record<string, unknown>>();
  const removed: string[] = [];
  const scaled: [string, number][] = [];
  const builds: { files: Record<string, string>; yaml: string }[] = [];
  const databases = new Map<string, string>();
  const dropped: string[] = [];
  const deletedImages: string[] = [];
  const cluster = {
    apply: async (path: string, object: object) => {
      const applied = object as { kind: string; spec?: { replicas?: number } };
      const replicas = applied.spec?.replicas ?? 0;
      objects.set(path, {
        ...applied,
        ...(applied.kind === "Deployment" && {
          status: {
            observedGeneration: 1,
            replicas,
            updatedReplicas: replicas,
            availableReplicas: replicas,
          },
        }),
      });
    },
    get: async <T>(path: string) => {
      const object = objects.get(path) as
        { kind: string; stringData?: Record<string, string> } | undefined;
      if (object?.kind !== "Secret") return object as T | undefined;
      return {
        data: Object.fromEntries(
          Object.entries(object.stringData ?? {}).map(([key, value]) => [
            key,
            Buffer.from(value).toString("base64"),
          ])
        ),
      } as T;
    },
    scale: async (path: string, replicas: number) => {
      scaled.push([path, replicas]);
    },
    remove: async (path: string) => {
      removed.push(path);
      objects.delete(path);
    },
  } satisfies Cluster;
  const hosting: Hosting = {
    cluster,
    acr: {
      build: async (archive: string, yaml: string) => {
        const dir = mkdtempSync(join(root, "context-"));
        execFileSync("tar", ["-xzf", archive, "-C", dir]);
        builds.push({
          yaml,
          files: Object.fromEntries(
            [...PLATFORM_FILES, "app.ts"].map((file) => [
              file,
              existsSync(join(dir, file)) ? readFileSync(join(dir, file), "utf8") : "",
            ])
          ),
        });
      },
      deleteImages: async (tenantId: number, slug: string) => {
        deletedImages.push(`t${tenantId}/${slug}`);
      },
      armToken: async () => "arm",
    },
    databases: {
      ensure: async (name: string, password: string) => {
        databases.set(name, password);
      },
      drop: async (name: string) => {
        dropped.push(name);
        databases.delete(name);
      },
      rights: async () => ({ createDb: true, createRole: true }),
    } satisfies AppDatabases,
    domain: "apps.example",
    registry: "registry.example",
    databaseHost: "db.example",
  };
  return { hosting, objects, removed, scaled, builds, databases, dropped, deletedImages };
};

const setup = (scripts: Readonly<Record<string, Script>> = {}) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "schmeide-kube-")));
  writeFileSync(join(root, "gitconfig"), GIT_CONFIG);
  const dataDir = join(root, "data");
  mkdirSync(join(dataDir, "bin"), { recursive: true });
  writeFileSync(gitConfigFile(dataDir), GIT_CONFIG);
  const template = join(root, "template");
  mkdirSync(join(template, "frontend"), { recursive: true });
  writeFileSync(join(template, "AGENTS.md"), "# rules\n");
  mkdirSync(join(template, "backend"), { recursive: true });
  for (const file of PLATFORM_FILES) writeFileSync(join(template, file), `template ${file}\n`);
  writeFileSync(
    join(template, "frontend", "index.html"),
    "<html>\n  <head>\n    <title>Notes</title>\n  </head>\n</html>\n"
  );
  git(template, "init", "-q");
  git(template, "add", "-A");
  git(template, "commit", "-q", "-m", "template");
  const kube = fakeKube(scripts);
  const forgejo = fakeForgejo(root);
  const hosting = fakeHosting(root);
  const runner: KubeRunner = {
    kube: kube.kube,
    forgejo: forgejo.forgejo,
    image: "schmeide.azurecr.io/schmeide-app:abc",
    postgresImage: "postgres",
    pollMs: 1,
    hosting: hosting.hosting,
  };
  const config: Config = {
    dataDir,
    template,
    agentModels: { fallback: "opus", byKind: {} },
    claudeBin: undefined,
    makeBin: "make",
    builderPlugin: join(root, "builder-plugin"),
    runner,
    // Every app answers.
    fetch: async () => new Response("ok"),
  };
  return { config, runner, kube, forgejo, hosting, root };
};

const newBuild = async () => {
  const project = await createProject(db, { name: `k ${randomUUID()}`, tenantId: DEMO_TENANT_ID });
  await transition(db, project.id, ["draft"], { status: "building", spec: "## Features\n- notes" });
  const [build] = await db
    .insert(builds)
    .values({ projectId: project.id, kind: "initial", request: "spec", status: "running" })
    .returning();
  return { project, build };
};

const messages = (buildId: number) =>
  listEvents(db, buildId, 0).then((events) => events.map((event) => event.message));

const agentLines = (pushed: string): readonly string[] => [
  "Cloning into '/work/app'...",
  JSON.stringify({ type: "system", subtype: "init", model: "claude-test" }),
  JSON.stringify({
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "Writing the to-do service." },
        { type: "tool_use", id: "1", name: "Edit", input: { file_path: "/work/app/todos.ts" } },
      ],
    },
  }),
  JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 1000,
    num_turns: 2,
    total_cost_usd: 0.25,
    session_id: "pod-session",
    result: "",
    permission_denials: [],
    modelUsage: {
      "claude-test": {
        inputTokens: 1,
        outputTokens: 2,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        costUSD: 0.25,
      },
    },
  }),
  JSON.stringify({ type: "schmeide", pushed }),
];

describe("kubernetes mode", () => {
  it("starts the project's repository from the template on staging and main, with main protected", async () => {
    const { config, forgejo } = setup();
    const { project, build } = await newBuild();
    const activities = createActivities(deps, config);
    const env = new MockActivityEnvironment();

    await env.run(activities.prepareWorkspace, build.id);
    await env.run(activities.prepareWorkspace, build.id);

    const repo = forgejo.bare(`t${project.tenantId}`, project.slug);
    expect(git(repo, "rev-parse", "staging")).toBe(git(repo, "rev-parse", "main"));
    expect(git(repo, "log", "--format=%s", "staging")).toBe("start from the schmeide template");
    expect(forgejo.protectedMain).toEqual([`t${project.tenantId}/${project.slug}`]);
    expect(await messages(build.id)).toEqual([
      "Copying the template into a new repository",
      "Repository ready",
      "Reusing the project's repository",
    ]);
  });

  it("runs the agent as a Job with a fresh deploy key, reads its messages, and removes it all", async () => {
    const { build } = await newBuild();
    const name = `agent-${build.id}-0`;
    const scripted = setup({ [name]: { lines: agentLines("a".repeat(40)), exit: 0 } });
    const activities = createActivities(deps, scripted.config);
    const env = new MockActivityEnvironment();
    // What the run's Secret holds, and whether its key was on the repository by then.
    const keysSeen: boolean[] = [];
    const secretsSeen: Record<string, string>[] = [];
    const createSecret = scripted.kube.kube.createSecret;
    scripted.kube.kube.createSecret = async (secret) => {
      keysSeen.push(scripted.forgejo.keys.some((key) => key.title === name && !key.readOnly));
      secretsSeen.push((secret as { stringData: Record<string, string> }).stringData);
      return createSecret(secret);
    };

    const session = await env.run(activities.runAgent, { buildId: build.id, round: 0 });

    expect(session).toBe("pod-session");
    expect(keysSeen).toEqual([true]);
    expect(secretsSeen[0].prompt).toContain("## Features\n- notes");
    expect(secretsSeen[0].prompt).toContain(POD_NOTE);
    expect(secretsSeen[0]["ssh-key"]).toContain("PRIVATE KEY");
    expect(scripted.kube.deleted).toEqual([name]);
    expect(scripted.kube.secrets.size).toBe(0);
    expect(scripted.forgejo.keys).toEqual([]);
    expect(await messages(build.id)).toEqual(
      expect.arrayContaining([
        "Agent started (claude-test)",
        "Writing the to-do service.",
        "Editing todos.ts",
        "Agent finished: success, 2 turns, $0.25",
        `Pushed ${"a".repeat(12)} to staging`,
      ])
    );
    expect(await db.select().from(usage).where(eq(usage.buildId, build.id))).toEqual([
      expect.objectContaining({ runKind: "initial", model: "claude-test" }),
    ]);
  });

  it("follows the agent a dead worker started, from where that worker's heartbeat says it got", async () => {
    const { build } = await newBuild();
    const name = `agent-${build.id}-0`;
    // One burst: every line has the same time, as the kubelet may stamp them.
    const at = new Date().toISOString();
    const { config, kube, forgejo } = setup({
      [name]: { lines: agentLines("b".repeat(40)).map((text) => ({ time: at, text })), exit: 0 },
    });
    kube.jobs.set(name, { metadata: { name } });
    kube.secrets.set(name, {});
    // The dead worker handled the clone line and the init message, and said so in its heartbeat.
    await appendEvent(db, build.id, "agent", "Agent started (claude-test)");
    const activities = createActivities(deps, config);
    const env = new MockActivityEnvironment({
      attempt: 2,
      heartbeatDetails: { time: at, count: 2 },
    });
    const beats: unknown[] = [];
    env.on("heartbeat", (details: unknown) => beats.push(details));

    const session = await env.run(activities.runAgent, { buildId: build.id, round: 0 });

    expect(session).toBe("pod-session");
    expect(forgejo.keys).toEqual([]);
    const seen = await messages(build.id);
    expect(seen).toContain("Following the agent that was already running");
    expect(seen.filter((message) => message === "Agent started (claude-test)")).toHaveLength(1);
    expect(seen).toContain("Writing the to-do service.");
    expect(seen).toContain("Agent finished: success, 2 turns, $0.25");
    expect(beats).toContainEqual({ time: at, count: 5 });
  });

  it("records an agent run's usage once when a dead worker's heartbeat lagged behind its result", async () => {
    const { build } = await newBuild();
    const name = `agent-${build.id}-0`;
    const at = new Date().toISOString();
    const { config, kube } = setup({
      [name]: { lines: agentLines("c".repeat(40)).map((text) => ({ time: at, text })), exit: 0 },
    });
    const activities = createActivities(deps, config);
    await new MockActivityEnvironment().run(activities.runAgent, { buildId: build.id, round: 0 });
    // The Job again, as a worker that died after recording the result but before its heartbeat
    // carried that would find it.
    kube.jobs.set(name, { metadata: { name } });
    kube.secrets.set(name, {});

    await new MockActivityEnvironment({
      attempt: 2,
      heartbeatDetails: { time: at, count: 2 },
    }).run(activities.runAgent, { buildId: build.id, round: 0 });

    expect(await db.select().from(usage).where(eq(usage.buildId, build.id))).toHaveLength(1);
  });

  it("does not need the session in a pod, where nothing resumes it", async () => {
    const { build } = await newBuild();
    const name = `agent-${build.id}-0`;
    const at = new Date().toISOString();
    const { config, kube } = setup({
      [name]: { lines: agentLines("d".repeat(40)).map((text) => ({ time: at, text })), exit: 0 },
    });
    kube.jobs.set(name, { metadata: { name } });
    kube.secrets.set(name, {});
    const activities = createActivities(deps, config);

    // Everything, the result included, was handled before the restart.
    const session = await new MockActivityEnvironment({
      attempt: 2,
      heartbeatDetails: { time: at, count: 5 },
    }).run(activities.runAgent, { buildId: build.id, round: 0 });

    expect(session).toBe("");
  });

  it("decides adopted checks from the whole log, without repeating their events", async () => {
    const { build } = await newBuild();
    const name = `checks-${build.id}-0`;
    const at = new Date().toISOString();
    const { config, kube } = setup({
      [name]: {
        lines: [
          "::schmeide:: start check",
          "::schmeide:: passed check",
          "::schmeide:: start test",
          "FAIL todos.test.ts",
          "::schmeide:: failed test 2",
        ].map((text) => ({ time: at, text })),
        exit: 0,
      },
    });
    const activities = createActivities(deps, config);
    await new MockActivityEnvironment().run(activities.prepareWorkspace, build.id);
    kube.jobs.set(name, { metadata: { name } });
    kube.secrets.set(name, {});

    const result = await new MockActivityEnvironment({
      attempt: 2,
      heartbeatDetails: { time: at, count: 5 },
    }).run(activities.runChecks, build.id, 0);

    expect(result).toEqual({ ok: false, output: "$ make test\nFAIL todos.test.ts\n" });
    expect(await messages(build.id)).not.toContain("make test failed (exit 2)");
  });

  it("fails the run when the agent's pod fails, and still removes its Job", async () => {
    const { build } = await newBuild();
    const name = `agent-${build.id}-0`;
    const { config, kube } = setup({
      [name]: { lines: ["fatal: could not read from remote repository"], exit: 128 },
    });
    const activities = createActivities(deps, config);

    await expect(
      new MockActivityEnvironment().run(activities.runAgent, { buildId: build.id, round: 0 })
    ).rejects.toThrow(/exit 128.*could not read from remote/s);
    expect(kube.deleted).toEqual([name]);
  });

  it("refuses files attached to the change, before starting anything", async () => {
    const { config, kube } = setup();
    const { project, build } = await newBuild();
    const [file] = await db
      .insert(files)
      .values({
        projectId: project.id,
        type: "png",
        owner: "mine",
        purpose: "in_app",
        displayName: "logo",
        originalName: "logo.png",
        size: 1,
      })
      .returning();
    await db.insert(buildFiles).values({ buildId: build.id, fileId: file.id });
    const activities = createActivities(deps, config);

    await expect(
      new MockActivityEnvironment().run(activities.runAgent, { buildId: build.id, round: 0 })
    ).rejects.toThrow(ATTACHMENTS_REFUSED);
    expect(kube.jobs.size).toBe(0);
  });

  it("checks the commit on staging in a Job with a read-only key, and reports the first failure", async () => {
    const { build } = await newBuild();
    const passing = `checks-${build.id}-0`;
    const failing = `checks-${build.id}-1`;
    const { config, kube, forgejo } = setup({
      [passing]: {
        lines: [
          "::schmeide:: start check",
          "::schmeide:: passed check",
          "::schmeide:: start test",
          "::schmeide:: passed test",
          "::schmeide:: start build",
          "::schmeide:: passed build",
        ],
        exit: 0,
      },
      [failing]: {
        lines: [
          "::schmeide:: start check",
          "::schmeide:: passed check",
          "::schmeide:: start test",
          "FAIL todos.test.ts",
          "::schmeide:: failed test 2",
        ],
        exit: 0,
      },
    });
    const activities = createActivities(deps, config);
    const env = new MockActivityEnvironment();
    await env.run(activities.prepareWorkspace, build.id);
    const readOnly: boolean[] = [];
    const createSecret = kube.kube.createSecret;
    kube.kube.createSecret = async (secret) => {
      readOnly.push(...forgejo.keys.map((key) => key.readOnly));
      return createSecret(secret);
    };

    const ok = await env.run(activities.runChecks, build.id, 0);
    const failed = (await env.run(activities.runChecks, build.id, 1)) as {
      ok: boolean;
      output: string;
    };

    expect(ok).toEqual({ ok: true, output: "" });
    expect(failed).toEqual({ ok: false, output: "$ make test\nFAIL todos.test.ts\n" });
    expect(readOnly).toEqual([true, true]);
    expect(kube.deleted).toEqual([passing, failing]);
    expect(await messages(build.id)).toEqual(
      expect.arrayContaining(["make check passed", "make test failed (exit 2)"])
    );
  });

  it("writes the page title on a clone of staging and pushes it", async () => {
    const { config, forgejo } = setup();
    const { project, build } = await newBuild();
    await db.update(projects).set({ pageTitle: "Tom's" }).where(eq(projects.id, project.id));
    const activities = createActivities(deps, config);
    const env = new MockActivityEnvironment();
    await env.run(activities.prepareWorkspace, build.id);

    await env.run(activities.applySite, build.id);

    const repo = forgejo.bare(`t${project.tenantId}`, project.slug);
    expect(git(repo, "log", "-1", "--format=%s", "staging")).toBe("set the page title and icon");
    expect(git(repo, "show", "staging:frontend/index.html")).toContain("<title>Tom&#39;s</title>");
    expect(git(repo, "log", "-1", "--format=%s", "main")).toBe("start from the schmeide template");
  });

  // The builder's commit on staging: an app file, and a platform-owned file it should not touch.
  const builderCommit = (root: string, repo: string) => {
    const clone = join(root, `clone-${randomUUID()}`);
    git(root, "clone", "-q", "--branch", "staging", repo, clone);
    writeFileSync(join(clone, "app.ts"), `export {}; // ${randomUUID()}\n`);
    writeFileSync(join(clone, "frontend", "Dockerfile"), "FROM evil\n");
    git(clone, "add", "-A");
    git(clone, "commit", "-q", "-m", "build the app");
    git(clone, "push", "-q", "origin", "HEAD:refs/heads/staging");
    return git(clone, "rev-parse", "HEAD");
  };

  it("deploys a first build to both copies on the apps domain from the template's Dockerfiles", async () => {
    const { config, forgejo, hosting, root } = setup();
    const { project, build } = await newBuild();
    const activities = createActivities(deps, config);
    const env = new MockActivityEnvironment();
    await env.run(activities.prepareWorkspace, build.id);
    const repo = forgejo.bare(`t${project.tenantId}`, project.slug);
    const commit = builderCommit(root, repo);

    await env.run(activities.deploy, build.id);

    expect(hosting.builds).toHaveLength(1);
    expect(hosting.builds[0].files).toMatchObject({
      "app.ts": expect.stringMatching(/^export \{\};/),
      "frontend/Dockerfile": "template frontend/Dockerfile\n",
      ".dockerignore": "template .dockerignore\n",
    });
    expect(hosting.builds[0].yaml).toContain(
      `apps/t${project.tenantId}/${project.slug}/web:${commit}`
    );
    // The reset is only in the build's context: the repository keeps the builder's file.
    expect(git(repo, "show", "staging:frontend/Dockerfile")).toBe("FROM evil");
    expect(git(repo, "rev-parse", "main")).toBe(commit);

    const [row] = await db.select().from(projects).where(eq(projects.id, project.id));
    expect(row.host).toMatch(
      new RegExp(`^${project.slug.slice(0, 47).replace(/-+$/, "")}-[a-z0-9]{6}$`)
    );
    expect(row).toMatchObject({
      status: "live",
      stagingCommit: commit,
      productionCommit: commit,
      stagingUrl: `https://${row.host}--staging.apps.example`,
      previewUrl: `https://${row.host}.apps.example`,
    });
    const ns = `/api/v1/namespaces/tenant-${project.tenantId}`;
    expect(hosting.objects.has(ns)).toBe(true);
    const deployment = hosting.objects.get(
      `/apis/apps/v1/namespaces/tenant-${project.tenantId}/deployments/app-${project.id}`
    ) as { spec: { template: { spec: { containers: { image: string }[] } } } };
    expect(deployment.spec.template.spec.containers[0].image).toBe(
      `registry.example/apps/t${project.tenantId}/${project.slug}/web:${commit}`
    );
    const password = hosting.databases.get(`app_${project.id}_staging`);
    expect(password).toMatch(/^[0-9a-f]{48}$/);
    expect(hosting.objects.get(`${ns}/secrets/app-${project.id}-staging`)).toMatchObject({
      stringData: {
        DATABASE_URL: `postgres://app_${project.id}_staging:${password}@db.example:5432/app_${project.id}_staging?sslmode=require`,
      },
    });

    // A later build keeps the host and each copy's password, and leaves production alone.
    await db.update(builds).set({ release: "promoted" }).where(eq(builds.id, build.id));
    const next = builderCommit(root, repo);
    await env.run(activities.deploy, build.id);
    const [after] = await db.select().from(projects).where(eq(projects.id, project.id));
    expect(after).toMatchObject({ host: row.host, stagingCommit: next, productionCommit: commit });
    expect(hosting.databases.get(`app_${project.id}_staging`)).toBe(password);
  });

  it("discards staging back to production's commit with an empty database", async () => {
    const { config, forgejo, hosting, root } = setup();
    const { project, build } = await newBuild();
    const activities = createActivities(deps, config);
    const env = new MockActivityEnvironment();
    await env.run(activities.prepareWorkspace, build.id);
    const repo = forgejo.bare(`t${project.tenantId}`, project.slug);
    const live = builderCommit(root, repo);
    await env.run(activities.deploy, build.id);
    await db.update(builds).set({ release: "promoted" }).where(eq(builds.id, build.id));
    builderCommit(root, repo);
    await env.run(activities.deploy, build.id);
    const [discard] = await db
      .insert(builds)
      .values({
        projectId: project.id,
        kind: "discard",
        request: "",
        status: "running",
        commit: live,
      })
      .returning();

    await env.run(activities.release, discard.id);

    expect(git(repo, "rev-parse", "staging")).toBe(live);
    expect(hosting.scaled).toContainEqual([
      `/apis/apps/v1/namespaces/tenant-${project.tenantId}/deployments/app-${project.id}-staging`,
      0,
    ]);
    expect(hosting.dropped).toEqual([`app_${project.id}_staging`]);
    expect(hosting.databases.has(`app_${project.id}_staging`)).toBe(true);
    const [row] = await db.select().from(projects).where(eq(projects.id, project.id));
    expect(row.stagingCommit).toBe(live);
  });

  it("stops both copies by scaling them to zero", async () => {
    const { config, hosting } = setup();
    const { project } = await newBuild();
    const activities = createActivities(deps, config);

    await new MockActivityEnvironment().run(activities.stopDeployment, project.id);

    expect(hosting.scaled.map(([path, replicas]) => [path.split("/").pop(), replicas])).toEqual([
      [`app-${project.id}-staging`, 0],
      [`app-${project.id}`, 0],
    ]);
    const [row] = await db.select().from(projects).where(eq(projects.id, project.id));
    expect(row).toMatchObject({ status: "stopped", previewUrl: null, stagingUrl: null });
  });

  it("removes every Job, Secret, and deploy key of a build when it finishes", async () => {
    const { config, kube, forgejo } = setup();
    const { project, build } = await newBuild();
    const other = await newBuild();
    for (const [id, name] of [
      [build.id, `agent-${build.id}-0`],
      [build.id, `checks-${build.id}-0`],
      [other.build.id, `agent-${other.build.id}-0`],
    ] as const) {
      kube.jobs.set(name, { metadata: { name, labels: { "schmeide.app/build": String(id) } } });
      kube.secrets.set(name, {});
      await forgejo.forgejo.addDeployKey(`t${project.tenantId}`, project.slug, name, "k", false);
    }
    const activities = createActivities(deps, config);

    await new MockActivityEnvironment().run(activities.finishBuild, build.id, "Build canceled");

    expect([...kube.jobs.keys()]).toEqual([`agent-${other.build.id}-0`]);
    expect([...kube.secrets.keys()]).toEqual([`agent-${other.build.id}-0`]);
    expect(forgejo.keys.map((key) => key.title)).toEqual([`agent-${other.build.id}-0`]);
  });

  it("sweeps at startup the Jobs of builds that are no longer running", async () => {
    const { runner, kube, forgejo } = setup();
    const running = await newBuild();
    const ended = await newBuild();
    await db.update(builds).set({ status: "failed" }).where(eq(builds.id, ended.build.id));
    for (const { project, build } of [running, ended]) {
      const name = `agent-${build.id}-0`;
      kube.jobs.set(name, {
        metadata: {
          name,
          labels: {
            "schmeide.app/build": String(build.id),
            "schmeide.app/project": String(project.id),
          },
        },
      });
      await forgejo.forgejo.addDeployKey(`t${project.tenantId}`, project.slug, name, "k", false);
    }

    const swept = await sweepLeftoverRuns(db, runner);

    expect(swept).toBeGreaterThanOrEqual(1);
    expect(kube.jobs.has(`agent-${running.build.id}-0`)).toBe(true);
    expect(kube.jobs.has(`agent-${ended.build.id}-0`)).toBe(false);
    expect(forgejo.keys.map((key) => key.title)).toEqual([`agent-${running.build.id}-0`]);
  });

  it("sweeps the deploy keys of a build that ended without its Job, and keeps running builds' keys", async () => {
    const { runner, forgejo } = setup();
    const running = await newBuild();
    const ended = await newBuild();
    // Its worker died, failOrphanedBuilds ended it, and the Job's TTL took the Job.
    await db
      .update(builds)
      .set({ status: "failed", finishedAt: new Date() })
      .where(eq(builds.id, ended.build.id));
    for (const { project, build } of [running, ended])
      await forgejo.forgejo.addDeployKey(
        `t${project.tenantId}`,
        project.slug,
        `checks-${build.id}-1`,
        "k",
        true
      );

    await sweepLeftoverRuns(db, runner);

    expect(forgejo.keys.map((key) => key.title)).toEqual([`checks-${running.build.id}-1`]);
  });

  it("deletes the project's repository, images, databases, and objects with the project", async () => {
    const { config, forgejo, hosting } = setup();
    const { project } = await newBuild();
    await db.delete(builds).where(eq(builds.projectId, project.id));
    const activities = createActivities(deps, config);

    await new MockActivityEnvironment().run(activities.removeProject, project.id);

    expect(forgejo.deletedRepos).toEqual([`t${project.tenantId}/${project.slug}`]);
    expect(hosting.deletedImages).toEqual([`t${project.tenantId}/${project.slug}`]);
    expect(hosting.dropped).toEqual([`app_${project.id}_staging`, `app_${project.id}`]);
    expect(hosting.removed.map((path) => path.split("/").slice(-2).join("/"))).toEqual(
      expect.arrayContaining([
        `deployments/app-${project.id}`,
        `services/app-${project.id}`,
        `ingresses/app-${project.id}-staging`,
        `secrets/app-${project.id}-staging`,
      ])
    );
  });
});
