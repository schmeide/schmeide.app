import { copy } from "../data/copy";
import type { Usage } from "../trpc";

import stepStyles from "./Step.module.css";
import styles from "./UsageSummary.module.css";

const count = new Intl.NumberFormat("en-US");
const TOKEN_FIELDS = [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheCreationTokens",
] as const;

// What the project has cost so far.
export function UsageSummary({ usage }: { readonly usage: Usage }) {
  return (
    <section aria-labelledby="usage" className={stepStyles.step}>
      <h2 id="usage">{copy.project.usageTitle}</h2>
      <dl className={styles.usage}>
        {TOKEN_FIELDS.map((field) => (
          <div key={field}>
            <dt>{copy.project.usage[field]}</dt>
            <dd>{count.format(usage[field])}</dd>
          </div>
        ))}
        <div>
          <dt>{copy.project.usage.costUsd}</dt>
          <dd>${usage.costUsd.toFixed(2)}</dd>
        </div>
      </dl>
    </section>
  );
}
