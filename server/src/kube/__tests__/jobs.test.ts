import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  buildSelector,
  CHECK_TARGETS,
  checksMarker,
  parseChecksMarker,
  parseRunName,
  runJob,
  runName,
  runSecret,
  type RunJob,
} from "../jobs.ts";

const agent: RunJob = {
  kind: "agent",
  buildId: 12,
  round: 0,
  tenantId: 3,
  projectId: 7,
  image: "schmeide.azurecr.io/schmeide-app:abc",
  postgresImage: "schmeide.azurecr.io/mirror/postgres:18-alpine",
  repo: "ssh://git@forgejo-ssh.forgejo.svc.cluster.local/t3/notes.git",
  knownHosts: false,
  env: { SCHMEIDE_MODEL: "opus" },
};

type Container = {
  name: string;
  command: string[];
  env: { name: string; value?: string; valueFrom?: unknown }[];
  securityContext: Record<string, unknown>;
  restartPolicy?: string;
};
type PodSpec = {
  automountServiceAccountToken: boolean;
  enableServiceLinks: boolean;
  restartPolicy: string;
  securityContext: Record<string, unknown>;
  containers: Container[];
  initContainers: Container[];
  volumes: { name: string; secret?: { secretName: string } }[];
};
type JobShape = {
  metadata: { name: string; labels: Record<string, string> };
  spec: {
    backoffLimit: number;
    activeDeadlineSeconds: number;
    ttlSecondsAfterFinished: number;
    template: { metadata: { labels: Record<string, string> }; spec: PodSpec };
  };
};

const envOf = (container: Container) =>
  Object.fromEntries(container.env.map((entry) => [entry.name, entry.value ?? entry.valueFrom]));

describe("run names", () => {
  it("names a run by its kind, build, and round, and reads the name back", () => {
    expect(runName("agent", 12, 0)).toBe("agent-12-0");
    expect(runName("checks", 12, 3)).toBe("checks-12-3");
    expect(parseRunName("checks-12-3")).toEqual({ kind: "checks", buildId: 12, round: 3 });
    expect(parseRunName("something-else")).toBeUndefined();
    expect(buildSelector(12)).toBe("schmeide.app/build=12");
  });
});

describe("runJob", () => {
  it("runs the agent as a restricted pod with no token, a deadline, and the builds model key", () => {
    const job = runJob(agent) as JobShape;
    const pod = job.spec.template.spec;
    const [container] = pod.containers;

    expect(job.metadata.name).toBe("agent-12-0");
    expect(job.metadata.labels).toEqual({
      "schmeide.app/tenant": "3",
      "schmeide.app/project": "7",
      "schmeide.app/build": "12",
      "schmeide.app/run": "agent",
    });
    expect(job.spec.template.metadata.labels).toEqual(job.metadata.labels);
    expect(job.spec).toMatchObject({
      backoffLimit: 0,
      activeDeadlineSeconds: 5400,
      ttlSecondsAfterFinished: 3600,
    });
    expect(pod).toMatchObject({
      restartPolicy: "Never",
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      securityContext: {
        runAsNonRoot: true,
        runAsUser: 1000,
        fsGroup: 1000,
        seccompProfile: { type: "RuntimeDefault" },
      },
    });
    for (const each of [...pod.containers, ...pod.initContainers])
      expect(each.securityContext).toMatchObject({
        allowPrivilegeEscalation: false,
        readOnlyRootFilesystem: true,
        capabilities: { drop: ["ALL"] },
      });
    expect(container.command.join(" ")).toContain("node /app/server/src/sandbox/agent.ts");
    expect(envOf(container)).toMatchObject({
      ANTHROPIC_API_KEY: { secretKeyRef: { name: "anthropic-builds", key: "key" } },
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      TEST_DATABASE_URL: "postgres://postgres:postgres@localhost:5432/app",
      SCHMEIDE_REPO: agent.repo,
      SCHMEIDE_MODEL: "opus",
    });
    expect(pod.volumes).toContainEqual(
      expect.objectContaining({ secret: expect.objectContaining({ secretName: "agent-12-0" }) })
    );
  });

  it("starts a Postgres sidecar that stops with the run", () => {
    const [postgres] = (runJob(agent) as JobShape).spec.template.spec.initContainers;

    expect(postgres).toMatchObject({
      name: "postgres",
      image: agent.postgresImage,
      restartPolicy: "Always",
    });
  });

  it("gives the checks no model key and a shorter deadline, and clones the exact commit", () => {
    const job = runJob({
      ...agent,
      kind: "checks",
      round: 1,
      env: { SCHMEIDE_COMMIT: "a".repeat(40) },
    }) as JobShape;
    const [container] = job.spec.template.spec.containers;

    expect(job.metadata.name).toBe("checks-12-1");
    expect(job.spec.activeDeadlineSeconds).toBe(1800);
    expect(envOf(container).ANTHROPIC_API_KEY).toBeUndefined();
    expect(envOf(container).SCHMEIDE_COMMIT).toBe("a".repeat(40));
    const script = container.command.join(" ");
    expect(script).toContain('git checkout -q --detach "$SCHMEIDE_COMMIT"');
    for (const { target } of CHECK_TARGETS) expect(script).toContain(checksMarker("start", target));
    // The phone check runs after make build, on what it built (#219).
    expect(CHECK_TARGETS.map(({ target }) => target)).toEqual(["check", "test", "build", "phones"]);
  });

  it("checks Forgejo's host key when it is known, and trusts the first one otherwise", () => {
    const commandOf = (knownHosts: boolean) =>
      envOf((runJob({ ...agent, knownHosts }) as JobShape).spec.template.spec.containers[0])
        .GIT_SSH_COMMAND;

    expect(commandOf(true)).toContain("StrictHostKeyChecking=yes");
    expect(commandOf(false)).toContain("StrictHostKeyChecking=accept-new");
  });

  it("hands sh scripts it can parse", () => {
    for (const kind of ["agent", "checks"] as const) {
      const [, flag, script] = (runJob({ ...agent, kind }) as JobShape).spec.template.spec
        .containers[0].command;
      expect(() => execFileSync("sh", ["-n", flag, script])).not.toThrow();
    }
  });
});

describe("runSecret", () => {
  it("is owned by its Job so it goes when the Job does", () => {
    const secret = runSecret(agent, { name: "agent-12-0", uid: "u1" }, { prompt: "build it" });

    expect(secret).toMatchObject({
      metadata: {
        name: "agent-12-0",
        labels: { "schmeide.app/build": "12" },
        ownerReferences: [{ apiVersion: "batch/v1", kind: "Job", name: "agent-12-0", uid: "u1" }],
      },
      stringData: { prompt: "build it" },
    });
  });
});

describe("checks markers", () => {
  it("reads back the lines the checks script prints around each target", () => {
    expect(parseChecksMarker(checksMarker("start", "test"))).toEqual({
      step: "start",
      target: "test",
    });
    expect(parseChecksMarker(checksMarker("passed", "check"))).toEqual({
      step: "passed",
      target: "check",
    });
    expect(parseChecksMarker("::schmeide:: failed build 2")).toEqual({
      step: "failed",
      target: "build",
      code: 2,
    });
    expect(parseChecksMarker("::schmeide:: failed phones 3")).toEqual({
      step: "failed",
      target: "phones",
      code: 3,
    });
    expect(parseChecksMarker("npm ERR! ::schmeide:: start check")).toBeUndefined();
    expect(parseChecksMarker("::schmeide:: start rm")).toBeUndefined();
  });
});
