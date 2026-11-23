// The journeys check in a checks pod (SCHMEIDE_RUNNER=kubernetes), after the files check: prints
// what runChecks reports on the host and exits with the number of changes the build made under
// journeys/. SCHMEIDE_BASE is the commit the build started from.
import { journeyProblems, journeysReport } from "../services/journeys.ts";

const problems = await journeyProblems(process.cwd(), process.env.SCHMEIDE_BASE || undefined);
if (problems.length > 0) console.log(journeysReport(problems));
process.exitCode = Math.min(problems.length, 255);
