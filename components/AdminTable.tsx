import type { ReactNode } from "react";

import styles from "./AdminTable.module.css";

type Props = {
  // Names the table and the region it scrolls in.
  readonly caption: string;
  readonly columns: readonly string[];
  // The body rows.
  readonly children: ReactNode;
};

// A table on an admin screen. Wide tables scroll inside their own box, which the keyboard reaches.
export function AdminTable({ caption, columns, children }: Props) {
  return (
    <div className={styles.scroll} role="region" aria-label={caption} tabIndex={0}>
      <table className={styles.table}>
        <caption className={styles.caption}>{caption}</caption>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column} scope="col">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
