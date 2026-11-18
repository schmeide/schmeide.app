import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { dependenciesOf, licenseAllowed, packageProblems, type Audit } from "../packageChecks.ts";

type Entry = { version: string; license?: string; dev?: boolean };

// A package-lock.json (lockfileVersion 3) holding `packages`.
const lock = (packages: Readonly<Record<string, Entry>>) =>
  JSON.stringify({
    name: "app",
    lockfileVersion: 3,
    packages: {
      "": { name: "app", version: "0.0.0" },
      ...Object.fromEntries(
        Object.entries(packages).map(([name, entry]) => [`node_modules/${name}`, entry])
      ),
    },
  });

const write = (dir: string, files: Readonly<Record<string, string>>) => {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
};

const git = (dir: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.invalid", ...args], {
    cwd: dir,
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });

// A one-commit repository standing in for the template, with `files` written on top.
const workspace = (template: Readonly<Record<string, string>>, files = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "package-checks-"));
  write(dir, { "README.md": "app\n", ...template });
  git(dir, "init", "-q");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "template");
  write(dir, files);
  return dir;
};

const TEMPLATE = {
  "frontend/package-lock.json": lock({ react: { version: "19.0.0", license: "MIT" } }),
  "backend/package-lock.json": lock({ fastify: { version: "5.0.0", license: "MIT" } }),
};

// What `npm audit --json` answers, by folder; a folder it is not given has no findings.
const fakeAudit =
  (byDir: Readonly<Record<string, unknown>>): Audit =>
  async (cwd) =>
    JSON.stringify({ vulnerabilities: byDir[cwd.split("/").at(-1) ?? ""] ?? {} });

const noFindings = fakeAudit({});

describe("packageProblems", () => {
  it("fails a known-vulnerable package with a fix, naming it and the fixed version", async () => {
    const dir = workspace(TEMPLATE, {
      "backend/package-lock.json": lock({
        fastify: { version: "5.0.0", license: "MIT" },
        lodash: { version: "4.17.20", license: "MIT" },
      }),
    });
    const audit = fakeAudit({
      backend: {
        lodash: {
          name: "lodash",
          severity: "critical",
          fixAvailable: { name: "lodash", version: "4.17.21", isSemVerMajor: false },
        },
      },
    });

    const problems = await packageProblems(dir, audit);

    expect(problems).toEqual([expect.stringMatching(/^backend: lodash .*critical.*4\.17\.21/)]);
  });

  it("leaves low findings and ones with no fix alone", async () => {
    const dir = workspace(TEMPLATE, {
      "backend/package-lock.json": lock({
        fastify: { version: "5.0.0", license: "MIT" },
        a: { version: "1.0.0", license: "MIT" },
        b: { version: "1.0.0", license: "MIT" },
      }),
    });
    const audit = fakeAudit({
      backend: {
        a: { name: "a", severity: "moderate", fixAvailable: true },
        b: { name: "b", severity: "high", fixAvailable: false },
      },
    });

    expect(await packageProblems(dir, audit)).toEqual([]);
  });

  it("fails a package whose license is not on the allow list, naming it", async () => {
    const dir = workspace(TEMPLATE, {
      "frontend/package-lock.json": lock({
        react: { version: "19.0.0", license: "MIT" },
        "copyleft-thing": { version: "2.0.0", license: "GPL-3.0" },
        "unstated-thing": { version: "1.0.0" },
        "dev-only": { version: "1.0.0", license: "GPL-3.0", dev: true },
      }),
    });

    const problems = await packageProblems(dir, noFindings);

    expect(problems).toEqual([
      expect.stringMatching(/^frontend: copyleft-thing@2\.0\.0 .*GPL-3\.0/),
      expect.stringMatching(/^frontend: unstated-thing@1\.0\.0 .*no license/),
    ]);
  });

  it("exempts packages the template ships", async () => {
    const dir = workspace({
      ...TEMPLATE,
      "frontend/package-lock.json": lock({
        react: { version: "19.0.0", license: "MIT" },
        "template-gpl": { version: "1.0.0", license: "GPL-2.0" },
      }),
    });
    const audit = fakeAudit({
      frontend: { react: { name: "react", severity: "high", fixAvailable: true } },
    });

    expect(await packageProblems(dir, audit)).toEqual([]);
  });

  it("checks nothing where there is no lock file", async () => {
    const dir = workspace({});
    expect(await packageProblems(dir, noFindings)).toEqual([]);
  });
});

describe("licenseAllowed", () => {
  it("reads SPDX expressions", () => {
    expect(licenseAllowed("MIT")).toBe(true);
    expect(licenseAllowed("(MIT OR GPL-3.0)")).toBe(true);
    expect(licenseAllowed("(MIT AND GPL-3.0)")).toBe(false);
    expect(licenseAllowed("Apache-2.0 AND BSD-3-Clause")).toBe(true);
    expect(licenseAllowed("AGPL-3.0-only")).toBe(false);
    expect(licenseAllowed(undefined)).toBe(false);
  });
});

describe("dependenciesOf", () => {
  it("lists the production packages of a lock file with their licenses", () => {
    const text = lock({
      react: { version: "19.0.0", license: "MIT" },
      "@scope/thing": { version: "1.0.0" },
      vitest: { version: "3.0.0", license: "MIT", dev: true },
    });

    expect(dependenciesOf("frontend", text)).toEqual([
      { dir: "frontend", name: "react", version: "19.0.0", license: "MIT" },
      { dir: "frontend", name: "@scope/thing", version: "1.0.0", license: null },
    ]);
  });
});
