import {
  CancellationScope,
  isCancellation,
  proxyActivities,
  type ActivityOptions,
} from "@temporalio/workflow";
import type { Activities } from "./activities.ts";

// Expensive or side-effecting steps run once; the workflow decides what to retry.
const once: ActivityOptions = { retry: { maximumAttempts: 1 } };

const { generateSpec } = proxyActivities<Activities>({
  ...once,
  startToCloseTimeout: "10 minutes",
  heartbeatTimeout: "1 minute",
});
const { prepareWorkspace, finishBuild, stopDeployment } = proxyActivities<Activities>({
  startToCloseTimeout: "10 minutes",
  heartbeatTimeout: "1 minute",
  retry: { maximumAttempts: 3 },
});
const { runAgent } = proxyActivities<Activities>({
  ...once,
  startToCloseTimeout: "90 minutes",
  heartbeatTimeout: "2 minutes",
});
const { runChecks, deploy } = proxyActivities<Activities>({
  ...once,
  startToCloseTimeout: "30 minutes",
  heartbeatTimeout: "2 minutes",
});

// Fix-up rounds after the first independent check run fails.
export const MAX_FIX_ATTEMPTS = 3;

export async function specWorkflow(projectId: number): Promise<void> {
  await generateSpec(projectId);
}

// projectId is unused but makes runs easy to find in the Temporal UI.
export async function buildWorkflow(_projectId: number, buildId: number): Promise<void> {
  try {
    await prepareWorkspace(buildId);
    let session = await runAgent({ buildId });
    for (let attempt = 0; ; attempt++) {
      const checks = await runChecks(buildId);
      if (checks.ok) break;
      if (attempt === MAX_FIX_ATTEMPTS) {
        throw new Error(
          `Checks still failing after ${MAX_FIX_ATTEMPTS} fix attempts:\n${checks.output}`
        );
      }
      session = await runAgent({ buildId, resume: session, feedback: checks.output });
    }
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
