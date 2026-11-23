import {
  ActivityCancellationType,
  ApplicationFailure,
  CancellationScope,
  isCancellation,
  patched,
  proxyActivities,
  type ActivityOptions,
} from "@temporalio/workflow";
import type { Build } from "../db/schema.ts";
import type { Activities } from "./activities.ts";

// Expensive or side-effecting steps run once; the workflow decides what to retry.
const once: ActivityOptions = { retry: { maximumAttempts: 1 } };

const { generateSpec } = proxyActivities<Activities>({
  ...once,
  startToCloseTimeout: "10 minutes",
  heartbeatTimeout: "1 minute",
});
const { finishBuild, applySite, stopDeployment, removeProject } = proxyActivities<Activities>({
  startToCloseTimeout: "10 minutes",
  heartbeatTimeout: "1 minute",
  retry: { maximumAttempts: 3 },
});
// The SDK throttles heartbeats to 80% of heartbeatTimeout, and cancellation only arrives with a
// heartbeat, so a short timeout keeps cancellation prompt. Waiting for the cancellation to complete
// means a canceled build is only marked canceled once its agent or make process has stopped.
// One retry lets a build survive a server restart: the dying worker fails the activity (or its
// heartbeat times out) and the restarted worker runs it again. Agent failures are non-retryable.
const longRunning: ActivityOptions = {
  retry: { maximumAttempts: 2 },
  heartbeatTimeout: "30 seconds",
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
};
const { runAgent } = proxyActivities<Activities>({
  ...longRunning,
  startToCloseTimeout: "90 minutes",
});
const { prepareWorkspace, runChecks, deploy, release } = proxyActivities<Activities>({
  ...longRunning,
  startToCloseTimeout: "30 minutes",
});
// The image build is allowed 25 minutes (RUN_TIMEOUT_SECONDS). The rest is the clone, two
// rollouts, and two health checks. A deploy already scheduled keeps the 30 minute budget.
export const DEPLOY_BUDGET = "60 minutes";
const { deploy: deployWithBudget } = proxyActivities<Activities>({
  ...longRunning,
  startToCloseTimeout: DEPLOY_BUDGET,
});
// A single model answer with no tools; a retry reuses a brief already stored.
const { planDesign } = proxyActivities<Activities>({
  ...longRunning,
  startToCloseTimeout: "10 minutes",
});
// A single model answer with no tools; a retry reuses the checks already stored.
const { planAcceptance } = proxyActivities<Activities>({
  ...longRunning,
  startToCloseTimeout: "10 minutes",
});
// The tester follows every check in a browser, a few features at a time.
const { checkAcceptance } = proxyActivities<Activities>({
  ...longRunning,
  startToCloseTimeout: "90 minutes",
});
// An app's first build is put live here, which can copy data and roll production out.
const { goLive } = proxyActivities<Activities>({
  ...longRunning,
  startToCloseTimeout: DEPLOY_BUDGET,
});
const { reviewDesign } = proxyActivities<Activities>({
  ...longRunning,
  startToCloseTimeout: "30 minutes",
});

// Fix-up rounds after the first independent check run fails.
export const MAX_FIX_ATTEMPTS = 3;
// Fix rounds for the design review's serious problems; what is left after them is recorded.
export const MAX_REVIEW_ROUNDS = 2;
// Fix rounds for acceptance checks the tester found broken; what is left after them is recorded.
export const MAX_ACCEPTANCE_ROUNDS = 2;

// The design lead chooses the look (a no-op unless the design team is on), the acceptance checks
// are written (a no-op with them off), the agent builds, then
// the server's own checks run, with fix-up rounds while they fail. Once they pass, a build with a
// design brief is reviewed against it, with fix rounds of its own; each round is checked again.
// Each agent run is told its round, which names its Job on the cluster, and so are the checks after it.
// Where a build's builder is: the number of its last run, that run's session, and how many of its
// runs fixed failed checks.
type Run = { round: number; session: string; checkFixes: number };

// The server's own checks, with fix-up rounds while they fail.
async function passChecks(buildId: number, run: Run): Promise<void> {
  for (;;) {
    const checks = await runChecks(buildId, run.round);
    if (checks.ok) return;
    if (run.checkFixes === MAX_FIX_ATTEMPTS) {
      // A plain Error would fail only the workflow task, which Temporal retries forever.
      throw ApplicationFailure.nonRetryable(
        `Checks still failing after ${MAX_FIX_ATTEMPTS} fix attempts:\n${checks.output}`
      );
    }
    run.checkFixes++;
    run.round++;
    run.session = await runAgent({
      buildId,
      round: run.round,
      resume: run.session,
      feedback: checks.output,
    });
  }
}

async function buildAndCheck(buildId: number): Promise<Run> {
  // patched: a build already running when the design team was added replays without it.
  const design = patched("design-team") ? await planDesign(buildId) : null;
  // patched: a build already running when the acceptance checks were added replays without them.
  if (patched("acceptance-checks")) await planAcceptance(buildId);
  const run: Run = { round: 0, session: await runAgent({ buildId, round: 0 }), checkFixes: 0 };
  let reviewFixes = 0;
  for (;;) {
    await passChecks(buildId, run);
    if (!design) return run;
    const review = await reviewDesign({
      buildId,
      base: design.base,
      round: reviewFixes,
      last: reviewFixes === MAX_REVIEW_ROUNDS,
    });
    if (review.ok) return run;
    reviewFixes++;
    run.round++;
    run.session = await runAgent({
      buildId,
      round: run.round,
      resume: run.session,
      review: review.output,
    });
  }
}

// The build's commit goes up on staging and a tester follows every acceptance check there (a
// no-op with the checks off). What is broken goes back to the builder, whose fix is checked and
// put on staging again, and every check is followed once more. Only then does an app's first
// build go live.
async function deployAndAccept(buildId: number, run: Run): Promise<void> {
  for (let fixes = 0; ; fixes++) {
    await deployWithBudget(buildId, { hold: true });
    const accepted = await checkAcceptance({
      buildId,
      round: fixes,
      last: fixes === MAX_ACCEPTANCE_ROUNDS,
    });
    if (accepted.ok) break;
    run.round++;
    run.session = await runAgent({
      buildId,
      round: run.round,
      resume: run.session,
      acceptance: accepted.output,
    });
    await passChecks(buildId, run);
    await applySite(buildId);
  }
  await goLive(buildId);
}

export async function specWorkflow(projectId: number): Promise<void> {
  await generateSpec(projectId);
}

// projectId is unused but makes runs easy to find in the Temporal UI. A `site` build only applies
// the page title and icon and redeploys; `promote`, `discard`, and `rollback` only move one copy
// of the app to a commit. kind is missing for runs started before it existed.
export async function buildWorkflow(
  _projectId: number,
  buildId: number,
  kind?: Build["kind"]
): Promise<void> {
  try {
    if (kind === "promote" || kind === "discard" || kind === "rollback") {
      await release(buildId);
    } else {
      await prepareWorkspace(buildId);
      const run = kind === "site" ? undefined : await buildAndCheck(buildId);
      // patched: a build already running when this step was added replays without it.
      if (patched("apply-site")) await applySite(buildId);
      // patched: a build already running when the tester was added deploys as it did.
      if (run && patched("acceptance-gate")) await deployAndAccept(buildId, run);
      else await (patched("deploy-budget") ? deployWithBudget : deploy)(buildId);
    }
    await finishBuild(buildId);
  } catch (error) {
    // patched: a build already running when a cancel became its own status replays the old call.
    if (isCancellation(error) && patched("canceled-build-status")) {
      await CancellationScope.nonCancellable(() => finishBuild(buildId, undefined, "canceled"));
    } else {
      const message = isCancellation(error)
        ? "Build canceled"
        : error instanceof Error
          ? error.cause instanceof Error
            ? error.cause.message
            : error.message
          : String(error);
      await CancellationScope.nonCancellable(() => finishBuild(buildId, message));
    }
    throw error;
  }
}

export async function stopWorkflow(projectId: number): Promise<void> {
  await stopDeployment(projectId);
}

export async function deleteWorkflow(projectId: number): Promise<void> {
  await removeProject(projectId);
}
