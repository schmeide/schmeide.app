// The journeys in a journeys pod (SCHMEIDE_RUNNER=kubernetes, #372), in the project's clone at the
// commit on staging: adds the journeys the worker just wrote (the run Secret's `journeys`, file name
// to text), runs the app's `make journeys` against staging as runJourneys does on the host, and
// prints, after make has exited, the one line the worker reads back: which of them passed.
// SCHMEIDE_JOURNEYS names the files to run, SCHMEIDE_BASE_URL is staging's address.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { journeysMarker } from "../kube/jobs.ts";
import { JOURNEYS_DIR, idOfJourney, passedIn } from "../services/journeys.ts";

const cwd = process.cwd();
const written = join(process.env.SCHMEIDE_RUN_DIR ?? "/run/schmeide", "journeys");
const files = (process.env.SCHMEIDE_JOURNEYS ?? "").split(" ").filter((file) => idOfJourney(file));

if (existsSync(written)) {
  mkdirSync(join(cwd, JOURNEYS_DIR), { recursive: true });
  const texts: unknown = JSON.parse(readFileSync(written, "utf8"));
  for (const [file, text] of Object.entries(texts as Record<string, unknown>))
    if (idOfJourney(file) && typeof text === "string")
      writeFileSync(join(cwd, JOURNEYS_DIR, file), text);
}

const report = join(mkdtempSync(join(tmpdir(), "journeys-")), "report.json");
const passed = (() => {
  if (files.length === 0) return new Set<string>();
  spawnSync(
    "make",
    ["journeys", `BASE_URL=${process.env.SCHMEIDE_BASE_URL ?? ""}`, `JOURNEYS=${files.join(" ")}`],
    {
      cwd,
      stdio: ["ignore", "inherit", "inherit"],
      env: { ...process.env, JOURNEYS_REPORT: report },
    }
  );
  try {
    return passedIn(JSON.parse(readFileSync(report, "utf8")));
  } catch {
    // A run that cannot report passed none.
    return new Set<string>();
  }
})();
console.log(journeysMarker(files.filter((file) => passed.has(file))));
