// The phone check in a checks pod (SCHMEIDE_RUNNER=kubernetes), after make build in the project's
// clone: prints what runChecks reports on the host and exits with the number of problems.
import { builtApp, mobileProblems, phonesReport } from "../services/mobileCheck.ts";

const problems = mobileProblems(await builtApp(process.cwd()));
if (problems.length > 0) console.log(phonesReport(problems));
process.exitCode = problems.length;
