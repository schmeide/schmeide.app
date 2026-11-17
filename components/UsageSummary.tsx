import { copy } from "../data/copy";
import type { Usage } from "../trpc";
import { formatCost, formatTokens, TOKEN_FIELDS } from "../utils/usage";

import stepStyles from "./Step.module.css";
import styles from "./UsageSummary.module.css";

// What the project, or in the admin area a business, has cost so far.
export function UsageSummary({ usage }: { readonly usage: Usage }) {
  return (
    <section aria-labelledby="usage" className={stepStyles.step}>
      <h2 id="usage">{copy.project.usageTitle}</h2>
      <dl className={styles.usage}>
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
    </section>
  );
}
