import { copy } from "../data/copy";

import styles from "./SetupStepper.module.css";

// Where setup stands: Describe → Spec → Build → Live, with the steps behind marked done.
export function SetupStepper({ current }: { readonly current: number }) {
  return (
    <ol aria-label={copy.project.setup.label} className={styles.stepper}>
      {copy.project.setup.steps.map((label, index) => (
        <li
          key={label}
          aria-current={index === current ? "step" : undefined}
          data-state={index < current ? "done" : index === current ? "current" : "todo"}
        >
          <span className={styles.label}>
            {label}
            {index < current && <span className={styles.hidden}> {copy.project.setup.done}</span>}
          </span>
        </li>
      ))}
    </ol>
  );
}
