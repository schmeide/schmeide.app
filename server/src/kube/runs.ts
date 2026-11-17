// A run's lifecycle (docs/stage2.md, "How the activity drives it"): create its Job and Secret or
// adopt the Job a dead worker started, follow its log to the end, and delete it.
import { setTimeout as sleep } from "node:timers/promises";
import { KubeError, type Job, type Kube } from "./client.ts";
import { LABELS, RUNS_SELECTOR, runJob, runName, runSecret, type RunJob } from "./jobs.ts";

// Creates the run's Job and then its Secret, owned by the Job; `secretData` is asked only then, so
// a deploy key is made only for a run that is really started. A Job of the run's name is adopted:
// a restarted worker follows the agent it started instead of paying for another. One whose Secret
// never came (a worker died between the two) is deleted and started afresh.
export const startRun = async (
  kube: Kube,
  run: RunJob,
  secretData: () => Promise<Readonly<Record<string, string>>>
): Promise<"created" | "adopted"> => {
  const name = runName(run.kind, run.buildId, run.round);
  if (await kube.getJob(name)) {
    if (await kube.secretExists(name)) return "adopted";
    await deleteRun(kube, name);
  }
  const job = await kube.createJob(runJob(run)).catch((error: unknown) => {
    if (error instanceof KubeError && error.status === 409) return undefined;
    throw error;
  });
  // Another worker created it a moment ago.
  if (!job) return "adopted";
  try {
    await kube.createSecret(
      runSecret(run, { name, uid: job.metadata.uid ?? "" }, await secretData())
    );
  } catch (error) {
    await deleteRun(kube, name);
    throw error;
  }
  return "created";
};

// Times as the kubelet stamps them (RFC 3339, up to nine digits of fraction, trailing zeros
// dropped), padded so that comparing the strings compares the times.
const instant = (time: string): string => {
  const match = /^(.*?T\d\d:\d\d:\d\d)(?:\.(\d+))?Z$/.exec(time);
  return match ? `${match[1]}.${(match[2] ?? "").padEnd(9, "0")}Z` : time;
};

export class RunFailed extends Error {}

// Follows the run's container until it exits, handing each log line to `onLine`, and answers its
// exit code. A dropped log stream is picked up after the last line seen; `sinceTime` starts there
// for a run adopted after a restart. Polls while the pod waits (for the quota, an image, the
// node), telling `onWaiting` once. Throws when the Job is gone or failed without the container
// ever running; stops when `signal` aborts.
export const followRun = async (
  kube: Kube,
  name: string,
  container: string,
  options: {
    readonly signal: AbortSignal;
    readonly sinceTime?: string;
    readonly pollMs?: number;
    readonly onLine: (text: string) => Promise<void>;
    readonly onWaiting?: (why: string) => Promise<void>;
  }
): Promise<number> => {
  let since = options.sinceTime;
  // Lines can share a time, so a stream picked up again skips as many lines at `since` as were seen.
  let seenAtSince = 0;
  let told = false;
  for (;;) {
    options.signal.throwIfAborted();
    const job = await kube.getJob(name);
    if (!job) throw new RunFailed(`The Job ${name} is gone`);
    const [pod] = await kube.listPods(`job-name=${name}`);
    const state = pod?.status?.containerStatuses?.find(
      (status) => status.name === container
    )?.state;
    if (pod && (state?.running || state?.terminated)) {
      let skip = seenAtSince;
      for await (const line of kube.logLines(pod.metadata.name, container, {
        sinceTime: since,
        signal: options.signal,
      })) {
        const at = instant(line.time);
        const last = since === undefined ? undefined : instant(since);
        if (last !== undefined && at < last) continue;
        if (at === last && skip > 0) {
          skip--;
          continue;
        }
        if (at === last) seenAtSince++;
        else {
          since = line.time;
          seenAtSince = 1;
        }
        await options.onLine(line.text);
      }
      const [after] = await kube.listPods(`job-name=${name}`);
      const exited = after?.status?.containerStatuses?.find((status) => status.name === container)
        ?.state?.terminated;
      if (exited) return exited.exitCode;
      continue;
    }
    const failed = job.status?.conditions?.find(
      (condition) => condition.type === "Failed" && condition.status === "True"
    );
    if (failed)
      throw new RunFailed(`The Job ${name} failed: ${failed.reason ?? ""} ${failed.message ?? ""}`);
    if (!told) {
      told = true;
      await options.onWaiting?.(
        state?.waiting?.reason ??
          (pod ? (pod.status?.phase ?? "pending") : "the cluster has not started it yet")
      );
    }
    await sleep(options.pollMs ?? 2000, undefined, { signal: options.signal });
  }
};

// Deletes the run's Job, its pod first (Foreground), and its Secret, and waits until the Job is
// gone, so a canceled build is only recorded as failed once nothing of it runs.
export const deleteRun = async (kube: Kube, name: string, timeoutMs = 120_000): Promise<void> => {
  await kube.deleteJob(name, "Foreground");
  await kube.deleteSecret(name);
  const deadline = Date.now() + timeoutMs;
  while ((await kube.getJob(name)) && Date.now() < deadline) await sleep(1000);
};

// Deletes every run whose build `keep` does not name, and answers them, so the caller can delete
// their deploy keys too. A worker runs it at startup, beside failOrphanedBuilds.
export const sweepRuns = async (
  kube: Kube,
  keep: (buildId: number) => boolean
): Promise<readonly Job[]> => {
  const leftovers = (await kube.listJobs(RUNS_SELECTOR)).filter(
    (job) => !keep(Number(job.metadata.labels?.[LABELS.build]))
  );
  for (const job of leftovers) await deleteRun(kube, job.metadata.name);
  return leftovers;
};
