import type { ReactNode } from "react";

import styles from "./StatusPage.module.css";

// The frame of the pages a person lands on when something is off: what happened in one sentence,
// then one way forward.
export function StatusPage({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <div className={styles.page}>
      <h1>{title}</h1>
      {children}
    </div>
  );
}
