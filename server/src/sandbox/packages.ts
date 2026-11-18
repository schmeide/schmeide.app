// The packages check in a checks pod (SCHMEIDE_RUNNER=kubernetes), after make build in the
// project's clone: prints what runChecks reports on the host and exits with the number of problems.
import { packageProblems, packagesReport } from "../services/packageChecks.ts";

const problems = await packageProblems(process.cwd());
if (problems.length > 0) console.log(packagesReport(problems));
process.exitCode = Math.min(problems.length, 255);
