// What a built app installs (#270): a production package with a known high or critical hole that
// has a fix, or a license a business may not be able to use, fails the round. Reads the app's
// lock files and `npm audit`; packages the template already ships are the template's to fix.

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { listReport } from "./buildChecks.ts";

// The folders of the template that hold an npm project each.
export const APP_DIRS = ["frontend", "backend"] as const;

// Licenses an app may ship, as SPDX ids. Anything else, or none at all, fails the round.
export const ALLOWED_LICENSES: readonly string[] = [
  "MIT",
  "MIT-0",
  "ISC",
  "0BSD",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "Apache-2.0",
  "BlueOak-1.0.0",
  "CC0-1.0",
  "Unlicense",
  "Zlib",
  "Python-2.0",
  "CC-BY-4.0",
];

export type Dependency = {
  readonly dir: string;
  readonly name: string;
  readonly version: string;
  readonly license: string | null;
};

type LockEntry = { version?: string; license?: unknown; dev?: boolean; link?: boolean };

// The production packages of a package-lock.json (lockfileVersion 2 or 3), one per name and version.
export const dependenciesOf = (dir: string, lockText: string): readonly Dependency[] => {
  const { packages = {} } = JSON.parse(lockText) as { packages?: Record<string, LockEntry> };
  const found = new Map<string, Dependency>();
  for (const [path, entry] of Object.entries(packages)) {
    const name = path.split("node_modules/").at(-1);
    if (!path.includes("node_modules/") || !name || entry.dev || entry.link || !entry.version)
      continue;
    const license = typeof entry.license === "string" ? entry.license : null;
    found.set(`${name}@${entry.version}`, { dir, name, version: entry.version, license });
  }
  return [...found.values()];
};

// An SPDX expression is allowed when one of its OR choices is made only of allowed licenses.
export const licenseAllowed = (license: string | null | undefined): boolean =>
  !!license &&
  license
    .replace(/[()]/g, "")
    .split(/\s+OR\s+/i)
    .some((choice) =>
      choice.split(/\s+AND\s+/i).every((id) => ALLOWED_LICENSES.includes(id.trim()))
    );

// `npm audit --json` for the production packages of the project in `cwd`; its stdout.
export type Audit = (cwd: string) => Promise<string>;

export const npmAudit: Audit = async (cwd) => {
  try {
    const { stdout } = await promisify(execFile)(
      "npm",
      ["audit", "--omit=dev", "--package-lock-only", "--json"],
      { cwd, maxBuffer: 64 << 20 }
    );
    return stdout;
  } catch (cause) {
    // npm audit exits non-zero when it finds anything; its JSON is still on stdout.
    const stdout = (cause as { stdout?: unknown }).stdout;
    if (typeof stdout === "string" && stdout.trim().startsWith("{")) return stdout;
    throw cause;
  }
};

type Finding = {
  readonly name?: string;
  readonly severity?: string;
  readonly fixAvailable?: boolean | { readonly name: string; readonly version: string };
};

const fixOf = (finding: Finding): string | undefined => {
  const fix = finding.fixAvailable;
  if (!fix) return undefined;
  return fix === true ? "run npm audit fix" : `update ${fix.name} to ${fix.version}`;
};

const git = async (cwd: string, ...args: string[]): Promise<string> =>
  (await promisify(execFile)("git", args, { cwd, maxBuffer: 64 << 20 })).stdout;

// The names the template's lock file lists in `dir`: its first commit's.
const templatePackages = async (workspace: string, dir: string): Promise<ReadonlySet<string>> => {
  try {
    const root = (await git(workspace, "rev-list", "--max-parents=0", "HEAD")).split("\n")[0];
    const text = await git(workspace, "show", `${root}:${dir}/package-lock.json`);
    return new Set(dependenciesOf(dir, text).map(({ name }) => name));
  } catch {
    return new Set();
  }
};

const lockOf = (workspace: string, dir: string) =>
  readFile(join(workspace, dir, "package-lock.json"), "utf8").catch(() => undefined);

// Every production package of the app, from its lock files.
export const appDependencies = async (workspace: string): Promise<readonly Dependency[]> =>
  (
    await Promise.all(
      APP_DIRS.map(async (dir) => {
        const text = await lockOf(workspace, dir);
        return text === undefined ? [] : dependenciesOf(dir, text);
      })
    )
  ).flat();

export const packageProblems = async (
  workspace: string,
  audit: Audit = npmAudit
): Promise<readonly string[]> => {
  const found: string[] = [];
  for (const dir of APP_DIRS) {
    const text = await lockOf(workspace, dir);
    if (text === undefined) continue;
    const template = await templatePackages(workspace, dir);
    // ponytail: a template package's finding is only skipped here; opening work on the template
    // for it (#206) is left to do.
    const { vulnerabilities = {} } = JSON.parse(await audit(join(workspace, dir))) as {
      vulnerabilities?: Record<string, Finding>;
    };
    for (const [name, finding] of Object.entries(vulnerabilities)) {
      const fix = fixOf(finding);
      if (template.has(name) || !fix || !/^(?:high|critical)$/.test(finding.severity ?? ""))
        continue;
      found.push(`${dir}: ${name} has a known ${finding.severity} security hole; ${fix}.`);
    }
    for (const { name, version, license } of dependenciesOf(dir, text)) {
      if (template.has(name) || licenseAllowed(license)) continue;
      found.push(
        license
          ? `${dir}: ${name}@${version} is licensed ${license}, which an app may not ship. Use a package under ${ALLOWED_LICENSES.slice(0, 4).join(", ")}, or a similar license.`
          : `${dir}: ${name}@${version} states no license, so an app may not ship it. Use a package with a license such as MIT.`
      );
    }
  }
  return found;
};

export const CHECKING_PACKAGES = "Checking the app's packages for security holes and licenses";
export const PACKAGES_OK = "The app's packages have no fixable security hole and allowed licenses";
export const packagesNotOk = (count: number): string =>
  `The app's packages have a security hole or a license it cannot ship (${count} ${count === 1 ? "problem" : "problems"})`;

export const packagesReport = (problems: readonly string[]): string =>
  listReport("Schmeide's check of the app's packages found:", problems);
