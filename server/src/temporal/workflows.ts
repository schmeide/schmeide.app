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
const { reviewDesign } = proxyActivities<Activities>({
  ...longRunning,
  startToCloseTimeout: "30 minutes",
});

// Fix-up rounds after the first independent check run fails.
export const MAX_FIX_ATTEMPTS = 3;
// Fix rounds for the design review's serious problems; what is left after them is recorded.
export const MAX_REVIEW_ROUNDS = 2;

// The design lead chooses the look (a no-op unless the design team is on), the agent builds, then
// the server's own checks run, with fix-up rounds while they fail. Once they pass, a build with a
// design brief is reviewed against it, with fix rounds of its own; each round is checked again.
// Each agent run is told its round, which names its Job on the cluster, and so are the checks after it.
async function buildAndCheck(buildId: number): Promise<void> {
  // patched: a build already running when the design team was added replays without it.
  const design = patched("design-team") ? await planDesign(buildId) : null;
  let round = 0;
  let session = await runAgent({ buildId, round });
  let checkFixes = 0;
  let reviewFixes = 0;
  for (;;) {
    const checks = await runChecks(buildId, round);
    if (!checks.ok) {
      if (checkFixes === MAX_FIX_ATTEMPTS) {
        // A plain Error would fail only the workflow task, which Temporal retries forever.
        throw ApplicationFailure.nonRetryable(
          `Checks still failing after ${MAX_FIX_ATTEMPTS} fix attempts:\n${checks.output}`
        );
      }
      checkFixes++;
      round++;
      session = await runAgent({ buildId, round, resume: session, feedback: checks.output });
      continue;
    }
    if (!design) return;
    const review = await reviewDesign({
      buildId,
      base: design.base,
      round: reviewFixes,
      last: reviewFixes === MAX_REVIEW_ROUNDS,
    });
    if (review.ok) return;
    reviewFixes++;
    round++;
    session = await runAgent({ buildId, round, resume: session, review: review.output });
  }
}

export async function specWorkflow(projectId: number): Promise<void> {
  await generateSpec(projectId);
}

// projectId is unused but makes runs easy to find in the Temporal UI. A `site` build only applies
// the page title and icon and redeploys; `promote` and `discard` only move one copy of the app to
// a commit. kind is missing for runs started before it existed.
export async function buildWorkflow(
  _projectId: number,
  buildId: number,
  kind?: Build["kind"]
): Promise<void> {
  try {
    if (kind === "promote" || kind === "discard") {
      await release(buildId);
    } else {
      await prepareWorkspace(buildId);
      if (kind !== "site") await buildAndCheck(buildId);
      // patched: a build already running when this step was added replays without it.
      if (patched("apply-site")) await applySite(buildId);
      await (patched("deploy-budget") ? deployWithBudget : deploy)(buildId);
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
