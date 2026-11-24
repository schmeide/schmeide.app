// The Jobs that run a build's agent, its checks, and its journeys in the builds namespace
// (docs/stage2.md, "Agent runs: a Job per run" and "Checks: a Job per round"). Pure: what to
// create, never how.

export const BUILDS_NAMESPACE = "schmeide-builds";
// The builds model key, projected into the builds namespace only.
export const ANTHROPIC_SECRET = { name: "anthropic-builds", key: "key" } as const;
export const POSTGRES_IMAGE = "schmeide.azurecr.io/mirror/postgres:18-alpine";

// `journeys` runs the journeys kept from earlier versions against staging, `new-journeys` the ones
// just written from what the tester did, before they are kept (#372).
export type RunKind = "agent" | "checks" | "journeys" | "new-journeys";

// A Job's name says what it runs, so a restarted worker finds the one it was following.
export const runName = (kind: RunKind, buildId: number, round: number): string =>
  `${kind}-${buildId}-${round}`;
export const parseRunName = (
  name: string
): { readonly kind: RunKind; readonly buildId: number; readonly round: number } | undefined => {
  const match = /^(agent|checks|journeys|new-journeys)-(\d+)-(\d+)$/.exec(name);
  return match
    ? { kind: match[1] as RunKind, buildId: Number(match[2]), round: Number(match[3]) }
    : undefined;
};

export const LABELS = {
  tenant: "schmeide.app/tenant",
  project: "schmeide.app/project",
  build: "schmeide.app/build",
  run: "schmeide.app/run",
} as const;
export const buildSelector = (buildId: number) => `${LABELS.build}=${buildId}`;
// Every run of every build.
export const RUNS_SELECTOR = LABELS.build;

// Matches workflows.ts: runAgent's startToCloseTimeout is 90 minutes, runChecks' 30. The journeys
// run inside checkAcceptance's 90, twice at most, beside the testers.
const DEADLINE_SECONDS: Readonly<Record<RunKind, number>> = {
  agent: 5400,
  checks: 1800,
  journeys: 1200,
  "new-journeys": 1200,
};
// The runs that need a database of their own: the journeys use staging's.
const WITH_DATABASE: ReadonlySet<RunKind> = new Set(["agent", "checks"]);
// What a dead worker leaves behind goes an hour after it finished.
const TTL_SECONDS = 3600;

const UID = 1000;
// The pod's own Postgres, as `make test` gets from Compose on a laptop.
export const TEST_DATABASE_URL = "postgres://postgres:postgres@localhost:5432/app";
const HOME = "/home/build";
// Where a pod clones the project; the agent works here.
export const WORK_DIR = "/work/app";
const RUN_SECRET_DIR = "/run/schmeide";

export type RunJob = {
  readonly kind: RunKind;
  readonly buildId: number;
  readonly round: number;
  readonly tenantId: number;
  readonly projectId: number;
  // The server's own image: it holds the agent's entry point and the tools the checks need.
  readonly image: string;
  readonly postgresImage: string;
  // The project's repository over SSH, reached with the run's deploy key.
  readonly repo: string;
  // Whether the run's Secret holds Forgejo's host key.
  readonly knownHosts: boolean;
  // Plain values for the run, such as the model or the commit to check. Never a secret.
  readonly env: Readonly<Record<string, string>>;
};

const labelsOf = (run: RunJob): Record<string, string> => ({
  [LABELS.tenant]: String(run.tenantId),
  [LABELS.project]: String(run.projectId),
  [LABELS.build]: String(run.buildId),
  [LABELS.run]: run.kind,
});

// What the checks run and how their events name them. `make test` in the template starts its
// database with Compose, which a pod has not got, so the checks run the target behind it against
// the pod's own database until the template uses TEST_DATABASE_URL (docs/stage2.md, "The template
// contract").
export const CHECK_TARGETS = [
  // BASE: the build's base commit, for the template's check/migrations (schmeide/template#25).
  {
    target: "check",
    command: 'make check ${SCHMEIDE_MIGRATIONS_BASE:+BASE="$SCHMEIDE_MIGRATIONS_BASE"}',
  },
  { target: "test", command: 'make test/run DATABASE_URL="$TEST_DATABASE_URL"' },
  { target: "build", command: "make build" },
  // Schmeide's check of what make build left in frontend/dist, as runChecks does on the host.
  { target: "phones", command: "node /app/server/src/sandbox/phones.ts" },
  // Schmeide's check for committed secrets and calls to other services, as on the host.
  { target: "files", command: "node /app/server/src/sandbox/files.ts" },
  // Schmeide's check of the app's packages for security holes and licenses, as on the host.
  { target: "packages", command: "node /app/server/src/sandbox/packages.ts" },
  // Schmeide's check that the build left journeys/ as the tester wrote it, as on the host.
  { target: "journeys", command: "node /app/server/src/sandbox/journeys.ts" },
] as const;
export type CheckTarget = (typeof CHECK_TARGETS)[number]["target"];

const MARKER = "::schmeide::";
type MarkerStep = "start" | "passed" | "failed";
export const checksMarker = (step: MarkerStep, target: CheckTarget, code?: number): string =>
  [MARKER, step, target, ...(code === undefined ? [] : [code])].join(" ");
export const parseChecksMarker = (
  line: string
):
  | { readonly step: MarkerStep; readonly target: CheckTarget; readonly code?: number }
  | undefined => {
  const match =
    /^::schmeide:: (start|passed|failed) (check|test|build|phones|files|packages|journeys)(?: (\d+))?$/.exec(
      line
    );
  if (!match) return undefined;
  const marked = { step: match[1] as MarkerStep, target: match[2] as CheckTarget };
  return match[3] === undefined ? marked : { ...marked, code: Number(match[3]) };
};

// Clones the project's staging branch with the run's deploy key, copied where ssh accepts it.
const PREPARE = [
  "set -eu",
  `install -D -m 600 ${RUN_SECRET_DIR}/ssh-key ${HOME}/.ssh/id`,
  `if [ -s ${RUN_SECRET_DIR}/known_hosts ]; then cp ${RUN_SECRET_DIR}/known_hosts ${HOME}/.ssh/known_hosts; fi`,
  "git config --global user.name Schmeide",
  "git config --global user.email agent@schmeide.invalid",
  "git config --global init.defaultBranch main",
  `git clone -q --branch staging "$SCHMEIDE_REPO" ${WORK_DIR}`,
  `cd ${WORK_DIR}`,
];

// A failed target is the project's failure, not the run's: the script still exits 0, and only a
// clone that fails or a pod that dies counts as the run failing.
const CHECKS_SCRIPT = [
  ...PREPARE,
  'git checkout -q --detach "$SCHMEIDE_COMMIT"',
  "set +e",
  ...CHECK_TARGETS.map(({ target, command }) =>
    [
      `echo '${checksMarker("start", target)}'`,
      `${command} 2>&1`,
      `code=$?`,
      `if [ "$code" -ne 0 ]; then echo "${MARKER} failed ${target} $code"; exit 0; fi`,
      `echo '${checksMarker("passed", target)}'`,
    ].join("\n")
  ),
].join("\n");

const AGENT_SCRIPT = [...PREPARE, "exec node /app/server/src/sandbox/agent.ts"].join("\n");

// The journeys of one run, by file name, that passed: the last line sandbox/runJourneys.ts prints
// once `make journeys` has exited. Only names a journey can have are read back.
const JOURNEYS_PASSED = `${MARKER} journeys passed`;
export const journeysMarker = (passed: readonly string[]): string =>
  [JOURNEYS_PASSED, ...passed].join(" ");
export const parseJourneysMarker = (line: string): readonly string[] | undefined => {
  if (line !== JOURNEYS_PASSED && !line.startsWith(`${JOURNEYS_PASSED} `)) return undefined;
  const files = line.slice(JOURNEYS_PASSED.length).split(" ").filter(Boolean);
  return files.every((file) => /^F\d+\.\d+\.spec\.ts$/.test(file)) ? files : undefined;
};

// The image's Chromium (#355) is at PLAYWRIGHT_BROWSERS_PATH, which the read-only root filesystem
// keeps Playwright from writing its lock and links in. The template's `make journeys` installs the
// browser its lockfile pins, so it is shown each browser the image has from a folder it may write
// in: the same version is found there, and another one is downloaded beside it.
const BROWSERS = `${HOME}/browsers`;
const JOURNEYS_SCRIPT = [
  ...PREPARE,
  'git checkout -q --detach "$SCHMEIDE_COMMIT"',
  `mkdir -p ${BROWSERS}`,
  `for each in "\${PLAYWRIGHT_BROWSERS_PATH:-/nonexistent}"/*; do if [ -e "$each" ]; then ln -s "$each" ${BROWSERS}/; fi; done`,
  `export PLAYWRIGHT_BROWSERS_PATH=${BROWSERS}`,
  "exec node /app/server/src/sandbox/runJourneys.ts",
].join("\n");

const SCRIPTS: Readonly<Record<RunKind, string>> = {
  agent: AGENT_SCRIPT,
  checks: CHECKS_SCRIPT,
  journeys: JOURNEYS_SCRIPT,
  "new-journeys": JOURNEYS_SCRIPT,
};

export const restricted = {
  allowPrivilegeEscalation: false,
  readOnlyRootFilesystem: true,
  capabilities: { drop: ["ALL"] },
};

const emptyDir = (name: string, medium?: "Memory") => ({
  name,
  emptyDir: medium ? { medium, sizeLimit: "1Gi" } : {},
});

export const runJob = (run: RunJob): object => {
  const name = runName(run.kind, run.buildId, run.round);
  const labels = labelsOf(run);
  const database = WITH_DATABASE.has(run.kind);
  const env = {
    HOME,
    TMPDIR: "/tmp",
    ...(database && { TEST_DATABASE_URL }),
    SCHMEIDE_REPO: run.repo,
    // ponytail: without a configured host key the first one seen is trusted; set
    // SCHMEIDE_FORGEJO_KNOWN_HOSTS to pin it.
    GIT_SSH_COMMAND: `ssh -i ${HOME}/.ssh/id -o IdentitiesOnly=yes -o UserKnownHostsFile=${HOME}/.ssh/known_hosts -o StrictHostKeyChecking=${run.knownHosts ? "yes" : "accept-new"}`,
    ...(run.kind === "agent" && {
      // The CLI calls nothing but the model.
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    }),
    ...run.env,
  };
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: { name, namespace: BUILDS_NAMESPACE, labels },
    spec: {
      backoffLimit: 0,
      activeDeadlineSeconds: DEADLINE_SECONDS[run.kind],
      ttlSecondsAfterFinished: TTL_SECONDS,
      template: {
        metadata: { labels },
        spec: {
          restartPolicy: "Never",
          automountServiceAccountToken: false,
          enableServiceLinks: false,
          securityContext: {
            runAsNonRoot: true,
            runAsUser: UID,
            runAsGroup: UID,
            fsGroup: UID,
            seccompProfile: { type: "RuntimeDefault" },
          },
          initContainers: database
            ? [
                {
                  // A native sidecar: it starts first and stops when the run's container exits.
                  name: "postgres",
                  image: run.postgresImage,
                  restartPolicy: "Always",
                  // The image's own postgres user (alpine's uid 70), which its entrypoint expects.
                  securityContext: { ...restricted, runAsUser: 70, runAsGroup: 70 },
                  env: [
                    { name: "POSTGRES_PASSWORD", value: "postgres" },
                    { name: "POSTGRES_DB", value: "app" },
                    { name: "PGDATA", value: "/var/lib/postgresql/data" },
                  ],
                  startupProbe: {
                    exec: { command: ["pg_isready", "-h", "127.0.0.1", "-U", "postgres"] },
                    periodSeconds: 2,
                    failureThreshold: 60,
                  },
                  resources: {
                    requests: { cpu: "100m", memory: "256Mi" },
                    limits: { memory: "512Mi" },
                  },
                  volumeMounts: [
                    { name: "pgdata", mountPath: "/var/lib/postgresql" },
                    { name: "pgrun", mountPath: "/var/run/postgresql" },
                    { name: "pgtmp", mountPath: "/tmp" },
                  ],
                },
              ]
            : [],
          containers: [
            {
              name: run.kind,
              image: run.image,
              command: ["sh", "-c", SCRIPTS[run.kind]],
              env: [
                ...Object.entries(env).map(([key, value]) => ({ name: key, value })),
                ...(run.kind === "agent"
                  ? [
                      {
                        name: "ANTHROPIC_API_KEY",
                        valueFrom: { secretKeyRef: { ...ANTHROPIC_SECRET } },
                      },
                    ]
                  : []),
              ],
              resources: {
                requests: { cpu: "1", memory: "2Gi", "ephemeral-storage": "4Gi" },
                limits: { cpu: "2", memory: "4Gi", "ephemeral-storage": "10Gi" },
              },
              securityContext: restricted,
              volumeMounts: [
                { name: "home", mountPath: HOME },
                { name: "work", mountPath: "/work" },
                { name: "tmp", mountPath: "/tmp" },
                { name: "run", mountPath: RUN_SECRET_DIR, readOnly: true },
              ],
            },
          ],
          volumes: [
            emptyDir("home"),
            emptyDir("work"),
            emptyDir("tmp"),
            ...(database
              ? [emptyDir("pgdata", "Memory"), emptyDir("pgrun"), emptyDir("pgtmp")]
              : []),
            // Readable by the run's group (fsGroup), not world.
            { name: "run", secret: { secretName: name, defaultMode: 0o440 } },
          ],
        },
      },
    },
  };
};

// The run's prompt and deploy key. Owned by its Job, so deleting the Job, or its TTL, takes it too.
export const runSecret = (
  run: RunJob,
  owner: { readonly name: string; readonly uid: string },
  data: Readonly<Record<string, string>>
): object => ({
  apiVersion: "v1",
  kind: "Secret",
  type: "Opaque",
  metadata: {
    name: owner.name,
    namespace: BUILDS_NAMESPACE,
    labels: labelsOf(run),
    ownerReferences: [{ apiVersion: "batch/v1", kind: "Job", name: owner.name, uid: owner.uid }],
  },
  stringData: data,
});
