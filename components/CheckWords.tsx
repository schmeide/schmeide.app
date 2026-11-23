import { copy } from "../data/copy";

import styles from "./CheckWords.module.css";

type Props = {
  readonly given: string | null;
  readonly steps: readonly string[];
  readonly expect: string | null;
};

// One acceptance check in plain words: where the person starts, what they do, and what should
// happen. A part that is missing is left out.
export function CheckWords({ given, steps, expect }: Props) {
  return (
    <dl className={styles.words}>
      {given && (
        <div>
          <dt>{copy.project.check.given}</dt>
          <dd>{given}</dd>
        </div>
      )}
      {steps.length > 0 && (
        <div>
          <dt>{copy.project.check.steps}</dt>
          <dd>
            <ol className={styles.steps}>
              {steps.map((step, index) => (
                <li key={index}>{step}</li>
              ))}
            </ol>
          </dd>
        </div>
      )}
      {expect && (
        <div>
          <dt>{copy.project.check.expect}</dt>
          <dd>{expect}</dd>
        </div>
      )}
    </dl>
  );
}
