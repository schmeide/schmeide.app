// The phone check as the checks pod runs it, after make build (SCHMEIDE_RUNNER=kubernetes, #219).
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = join(import.meta.dirname, "..", "phones.ts");

const checkPhones = (html: string, css?: string) => {
  const cwd = mkdtempSync(join(tmpdir(), "phones-"));
  const dist = join(cwd, "frontend", "dist");
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, "index.html"), html);
  if (css !== undefined) writeFileSync(join(dist, "app.css"), css);
  return spawnSync(process.execPath, [SCRIPT], { cwd, encoding: "utf8" });
};

describe("sandbox/phones.ts", () => {
  it("passes a built app that is ready for phones", () => {
    const run = checkPhones(
      '<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="app.css">',
      "body { margin: 0 }"
    );

    expect(run.status).toBe(0);
    expect(run.stdout).toBe("");
  });

  it("prints what the host prints and exits with the number of problems", () => {
    const run = checkPhones("<p>hi</p>");

    expect(run.status).toBeGreaterThan(0);
    expect(run.stdout).toMatch(
      /^Schmeide's check of the built app \(frontend\/dist\) for phones found:\n- /
    );
    expect(run.stdout.trimEnd().split("\n")).toHaveLength(1 + (run.status ?? 0));
  });
});
