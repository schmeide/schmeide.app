// What a hosted project takes up, read from the container runtime and the disk when an admin
// asks, and never stored (stored history is #83's). Nothing here goes through a shell: every
// command is a program and an array of arguments.
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

// Every app runs as two copies. Production is the one its own customers use; staging is the one
// every build deploys to and the designer shows. Each has its own address, Compose project, and
// database volume (Compose names it `<Compose project>_db-data`).
export const COPIES = ["staging", "production"] as const;
export type Copy = (typeof COPIES)[number];

// A slug as slugify makes it. Never `_`, which only staging's Compose name holds, and never a path.
const SLUG = /^[a-z0-9][a-z0-9-]*$/;

// Every name a copy goes by, from this one place. Production keeps the names every app had before
// staging existed, so an app already live keeps its containers and its database. Staging runs from
// the builder's workspace, the project's git repository; production from its own checkout of it,
// at one commit. A staging name ends in `_staging`, which no production name can, so nothing done
// to staging can name production's Compose project, volume, or folder.
export const copyOf = (
  dataDir: string,
  slug: string,
  copy: Copy
): { readonly composeProject: string; readonly dir: string } => {
  if (!SLUG.test(slug)) throw new Error(`Not a project slug: ${JSON.stringify(slug)}`);
  return copy === "production"
    ? { composeProject: `schmeide-${slug}`, dir: join(dataDir, "production", slug) }
    : { composeProject: `schmeide-${slug}_staging`, dir: join(dataDir, "projects", slug) };
};

// Staging's web port is production's plus this. The projects table keeps every web port below
// FIRST_WEB_PORT + STAGING_PORT_OFFSET (18100), so the two ranges never meet.
export const STAGING_PORT_OFFSET = 10_000;
export const webPortOf = (project: { readonly webPort: number }, copy: Copy): number =>
  copy === "production" ? project.webPort : project.webPort + STAGING_PORT_OFFSET;

export type RuntimeFigures = {
  readonly containers: number;
  readonly memoryBytes: number;
  // As docker stats reports it: 100 is one CPU core, summed over the project's containers.
  readonly cpuPercent: number;
};

// The seam tests replace. Both stop when `signal` aborts.
export type ResourceReader = {
  // The running containers of every Compose project, by project name, in one read.
  readonly runtime: (signal: AbortSignal) => Promise<ReadonlyMap<string, RuntimeFigures>>;
  readonly workspaceBytes: (slug: string, signal: AbortSignal) => Promise<number>;
};

// Null is a figure that could not be read in time.
export type ProjectResources = {
  readonly id: number;
  readonly containers: number | null;
  readonly memoryBytes: number | null;
  readonly cpuPercent: number | null;
  readonly workspaceBytes: number | null;
};

// docker stats takes a second or two by itself.
export const RESOURCE_TIMEOUT_MS = 5000;

const NOT_RUNNING: RuntimeFigures = { containers: 0, memoryBytes: 0, cpuPercent: 0 };

// The work's answer, or null when it fails or outlasts `ms`; the work is told to stop then.
const bounded = async <T>(ms: number, work: (signal: AbortSignal) => Promise<T>) => {
  const signal = AbortSignal.timeout(ms);
  const late = new Promise<never>((_, reject) =>
    signal.addEventListener("abort", () => reject(signal.reason), { once: true })
  );
  return Promise.race([work(signal), late]).catch(() => null);
};

// One runtime read for all the projects, and one disk read each, all at once.
export const readResources = async (
  reader: ResourceReader,
  projects: readonly { readonly id: number; readonly slug: string }[],
  timeoutMs = RESOURCE_TIMEOUT_MS
): Promise<readonly ProjectResources[]> => {
  const [runtime, sizes] = await Promise.all([
    bounded(timeoutMs, reader.runtime),
    Promise.all(
      projects.map(({ slug }) =>
        bounded(timeoutMs, (signal) => reader.workspaceBytes(slug, signal))
      )
    ),
  ]);
  return projects.map(({ id, slug }, index) => {
    // Both copies, counted together.
    const figures =
      runtime &&
      COPIES.map(
        (copy) => runtime.get(copyOf("", slug, copy).composeProject) ?? NOT_RUNNING
      ).reduce((sum, one) => ({
        containers: sum.containers + one.containers,
        memoryBytes: sum.memoryBytes + one.memoryBytes,
        cpuPercent: sum.cpuPercent + one.cpuPercent,
      }));
    return {
      id,
      containers: figures?.containers ?? null,
      memoryBytes: figures?.memoryBytes ?? null,
      cpuPercent: figures?.cpuPercent ?? null,
      workspaceBytes: sizes[index],
    };
  });
};

const UNITS: Readonly<Record<string, number>> = {
  B: 1,
  KiB: 1024,
  MiB: 1024 ** 2,
  GiB: 1024 ** 3,
  TiB: 1024 ** 4,
  kB: 1000,
  KB: 1000,
  MB: 1000 ** 2,
  GB: 1000 ** 3,
  TB: 1000 ** 4,
};

// "1.5MiB" as docker prints it, in bytes.
export const bytesOf = (text: string): number => {
  const match = /^([\d.]+)\s*([a-zA-Z]+)$/.exec(text.trim());
  const unit = match && UNITS[match[2]];
  if (!match || !unit) throw new Error(`Cannot read a size from "${text}"`);
  return Math.round(Number(match[1]) * unit);
};

const percentOf = (text: string): number => {
  const value = Number(text.trim().replace(/%$/, ""));
  if (!text.trim().endsWith("%") || Number.isNaN(value))
    throw new Error(`Cannot read a percentage from "${text}"`);
  return value;
};

const linesOf = (output: string) =>
  output
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => line.split("\t"));

// `ps`: a container id and its Compose project per line. `stats`: a container id, its CPU, and
// its memory ("10MiB / 7.6GiB") per line. Answers the figures summed per Compose project.
export const figuresByProject = (
  ps: string,
  stats: string
): ReadonlyMap<string, RuntimeFigures> => {
  const usage = new Map(
    linesOf(stats).map(([id, cpu, memory]) => [
      id,
      { cpuPercent: percentOf(cpu ?? ""), memoryBytes: bytesOf((memory ?? "").split("/")[0]) },
    ])
  );
  const byProject = new Map<string, RuntimeFigures>();
  for (const [id, project] of linesOf(ps)) {
    const own = usage.get(id) ?? { cpuPercent: 0, memoryBytes: 0 };
    const sum = byProject.get(project) ?? NOT_RUNNING;
    byProject.set(project, {
      containers: sum.containers + 1,
      memoryBytes: sum.memoryBytes + own.memoryBytes,
      cpuPercent: sum.cpuPercent + own.cpuPercent,
    });
  }
  return byProject;
};

const COMPOSE_LABEL = "com.docker.compose.project";

// The real reader: `docker ps` and `docker stats` on this host, and `du` on the workspace.
export const createResourceReader = (dataDir: string, docker = "docker"): ResourceReader => ({
  runtime: async (signal) => {
    const ps = await run(
      docker,
      [
        "ps",
        "--filter",
        `label=${COMPOSE_LABEL}`,
        "--format",
        `{{.ID}}\t{{.Label "${COMPOSE_LABEL}"}}`,
      ],
      { signal }
    );
    const ids = linesOf(ps.stdout).map(([id]) => id);
    if (ids.length === 0) return new Map();
    const stats = await run(
      docker,
      ["stats", "--no-stream", "--format", "{{.Container}}\t{{.CPUPerc}}\t{{.MemUsage}}", ...ids],
      { signal }
    );
    return figuresByProject(ps.stdout, stats.stdout);
  },
  // Both copies' folders together: the workspace and the app's checkout.
  workspaceBytes: async (slug, signal) => {
    const sizes = await Promise.all(
      COPIES.map((copy) => copyOf(dataDir, slug, copy).dir).map(async (dir) => {
        // A project that has never been built has neither yet.
        if (!(await stat(dir).catch(() => undefined))) return 0;
        const { stdout } = await run("du", ["-sk", dir], { signal });
        const kib = Number.parseInt(stdout, 10);
        if (Number.isNaN(kib)) throw new Error(`Cannot read du's answer for ${dir}`);
        return kib * 1024;
      })
    );
    return sizes.reduce((sum, bytes) => sum + bytes, 0);
  },
});
