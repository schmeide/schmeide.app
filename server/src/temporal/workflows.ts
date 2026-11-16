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
// means a canceled build is only marked failed once its agent or make process has stopped.
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
const { prepareWorkspace, runChecks, deploy } = proxyActivities<Activities>({
  ...longRunning,
  startToCloseTimeout: "30 minutes",
});

// Fix-up rounds after the first independent check run fails.
export const MAX_FIX_ATTEMPTS = 3;

// The agent builds, then the server's own checks run, with fix-up rounds while they fail.
async function buildAndCheck(buildId: number): Promise<void> {
  let session = await runAgent({ buildId });
  for (let attempt = 0; ; attempt++) {
    const checks = await runChecks(buildId);
    if (checks.ok) return;
    if (attempt === MAX_FIX_ATTEMPTS) {
      // A plain Error would fail only the workflow task, which Temporal retries forever.
      throw ApplicationFailure.nonRetryable(
        `Checks still failing after ${MAX_FIX_ATTEMPTS} fix attempts:\n${checks.output}`
      );
    }
    session = await runAgent({ buildId, resume: session, feedback: checks.output });
  }
}

export async function specWorkflow(projectId: number): Promise<void> {
  await generateSpec(projectId);
}

// projectId is unused but makes runs easy to find in the Temporal UI. A `site` build only applies
// the page title and icon and redeploys. kind is missing for runs started before it existed.
export async function buildWorkflow(
  _projectId: number,
  buildId: number,
  kind?: Build["kind"]
): Promise<void> {
  try {
    await prepareWorkspace(buildId);
    if (kind !== "site") await buildAndCheck(buildId);
    // patched: a build already running when this step was added replays without it.
    if (patched("apply-site")) await applySite(buildId);
    await deploy(buildId);
    await finishBuild(buildId);
  } catch (error) {
    const message = isCancellation(error)
      ? "Build canceled"
      : error instanceof Error
        ? error.cause instanceof Error
          ? error.cause.message
          : error.message
        : String(error);
    await CancellationScope.nonCancellable(() => finishBuild(buildId, message));
    throw error;
  }
}

export async function stopWorkflow(projectId: number): Promise<void> {
  await stopDeployment(projectId);
}

export async function deleteWorkflow(projectId: number): Promise<void> {
  await removeProject(projectId);
}
