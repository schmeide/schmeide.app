// The journeys as a journeys pod runs them (SCHMEIDE_RUNNER=kubernetes, #372).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseJourneysMarker } from "../../kube/jobs.ts";

const SCRIPT = join(import.meta.dirname, "..", "runJourneys.ts");

// A clone whose `make journeys` notes how it was called and passes every journey but those
// holding BREAKS, as the template's would report them.
const MAKEFILE = [
  ".PHONY: journeys",
  "journeys:",
  '\t@echo "$(BASE_URL) $(JOURNEYS)" > ran',
  `\t@node -e 'const fs = require("fs"); fs.writeFileSync(process.env.JOURNEYS_REPORT, JSON.stringify({ suites: process.argv[1].split(" ").filter(Boolean).map((file) => ({ file, specs: [{ ok: !fs.readFileSync("journeys/" + file, "utf8").includes("BREAKS") }] })) }))' "$(JOURNEYS)"`,
  "",
].join("\n");

const runJourneys = (
  options: {
    readonly makefile?: string;
    readonly kept?: Readonly<Record<string, string>>;
    readonly written?: Readonly<Record<string, string>>;
    readonly files: string;
  } = { files: "" }
) => {
  const cwd = mkdtempSync(join(tmpdir(), "journeys-clone-"));
  const runDir = mkdtempSync(join(tmpdir(), "journeys-run-"));
  writeFileSync(join(cwd, "Makefile"), options.makefile ?? MAKEFILE);
  mkdirSync(join(cwd, "journeys"));
  for (const [file, text] of Object.entries(options.kept ?? {}))
    writeFileSync(join(cwd, "journeys", file), text);
  if (options.written) writeFileSync(join(runDir, "journeys"), JSON.stringify(options.written));
  const run = spawnSync(process.execPath, [SCRIPT], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      SCHMEIDE_RUN_DIR: runDir,
      SCHMEIDE_BASE_URL: "https://h1.apps.example",
      SCHMEIDE_JOURNEYS: options.files,
    },
  });
  const lines = run.stdout.trimEnd().split("\n");
  return {
    run,
    cwd,
    passed: parseJourneysMarker(lines.at(-1) ?? ""),
    ran: existsSync(join(cwd, "ran")) ? readFileSync(join(cwd, "ran"), "utf8").trim() : undefined,
  };
};

describe("sandbox/runJourneys.ts", () => {
  it("runs the kept journeys against staging and prints the ones that passed last", () => {
    const { run, passed, ran } = runJourneys({
      kept: { "F1.1.spec.ts": "ok", "F2.1.spec.ts": "BREAKS" },
      files: "F1.1.spec.ts F2.1.spec.ts",
    });

    expect(run.status).toBe(0);
    expect(ran).toBe("https://h1.apps.example F1.1.spec.ts F2.1.spec.ts");
    expect(passed).toEqual(["F1.1.spec.ts"]);
  });

  it("adds the journeys the worker wrote before running them, and only under journeys/", () => {
    const { passed, cwd } = runJourneys({
      written: { "F3.1.spec.ts": "ok", "F3.2.spec.ts": "BREAKS", "../Makefile": "all:\n" },
      files: "F3.1.spec.ts F3.2.spec.ts",
    });

    expect(passed).toEqual(["F3.1.spec.ts"]);
    expect(readFileSync(join(cwd, "journeys", "F3.1.spec.ts"), "utf8")).toBe("ok");
    expect(readFileSync(join(cwd, "Makefile"), "utf8")).toBe(MAKEFILE);
  });

  it("passes none when make writes no report", () => {
    const { passed, ran } = runJourneys({
      makefile:
        ".PHONY: journeys\njourneys:\n\t@echo ::schmeide:: journeys passed F1.1.spec.ts\n\t@exit 2\n",
      kept: { "F1.1.spec.ts": "ok" },
      files: "F1.1.spec.ts",
    });

    // The app's own output came first; the last line is the script's.
    expect(passed).toEqual([]);
    expect(ran).toBeUndefined();
  });

  it("runs nothing when it is given no journey", () => {
    const { passed, ran } = runJourneys({ files: "Makefile ../x" });

    expect(passed).toEqual([]);
    expect(ran).toBeUndefined();
  });
});
