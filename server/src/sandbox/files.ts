// The secrets and outside-calls check in a checks pod (SCHMEIDE_RUNNER=kubernetes), after make build
// in the project's clone: prints what runChecks reports on the host and exits with the number of
// problems. SCHMEIDE_BASE is the commit the build started from.
import { buildProblems, safetyReport } from "../services/buildChecks.ts";

const problems = await buildProblems(process.cwd(), process.env.SCHMEIDE_BASE || undefined);
if (problems.length > 0) console.log(safetyReport(problems));
process.exitCode = Math.min(problems.length, 255);
