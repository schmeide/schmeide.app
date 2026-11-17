import { copy } from "../data/copy";
import type { TimeTotals, Usage } from "../trpc";
import { formatCost, formatDuration, formatTokens, TOKEN_FIELDS } from "../utils/usage";
import { useNow } from "./useNow";

import stepStyles from "./Step.module.css";
import styles from "./UsageSummary.module.css";

type Props = {
  readonly usage: Usage;
  // A project's time; the admin area's business totals have none.
  readonly time?: TimeTotals;
  // When the build that is running now started: its time is added, and keeps counting.
  readonly runningSince?: Date | null;
};

// What the project, or in the admin area a business, has cost so far.
export function UsageSummary({ usage, time, runningSince = null }: Props) {
  const now = useNow(runningSince !== null);
  const running = runningSince ? Math.max(0, now - runningSince.getTime()) : 0;
  return (
    <section aria-labelledby="usage" className={stepStyles.step}>
      <h2 id="usage">{copy.project.usageTitle}</h2>
      <dl className={styles.usage}>
        {time && (
          <>
            <div>
              <dt>{copy.project.time.building}</dt>
              <dd>{formatDuration(time.buildingMs + running)}</dd>
              {time.failedBuildingMs > 0 && (
                <dd className={styles.note}>
                  {copy.project.time.failed(formatDuration(time.failedBuildingMs))}
                </dd>
              )}
            </div>
            <div>
              <dt>{copy.project.time.builder}</dt>
              <dd>
                {time.builderMs === 0 && time.builderUnrecorded
                  ? copy.project.time.notRecorded
                  : formatDuration(time.builderMs)}
              </dd>
              {time.builderMs > 0 && time.builderUnrecorded && (
                <dd className={styles.note}>{copy.project.time.partlyRecorded}</dd>
              )}
            </div>
          </>
        )}
        {TOKEN_FIELDS.map((field) => (
          <div key={field}>
            <dt>{copy.project.usage[field]}</dt>
            <dd>{formatTokens(usage[field])}</dd>
          </div>
        ))}
        <div>
          <dt>{copy.project.usage.costUsd}</dt>
          <dd>{formatCost(usage.costUsd)}</dd>
        </div>
      </dl>
      {time && <p className={stepStyles.muted}>{copy.project.time.explained}</p>}
    </section>
  );
}
