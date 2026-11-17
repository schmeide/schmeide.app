import type { ReactNode } from "react";

import { copy } from "../data/copy";
import type { Usage } from "../trpc";
import { formatCost, formatTokens, TOKEN_FIELDS } from "../utils/usage";
import { AdminTable } from "./AdminTable";

import styles from "./AdminTable.module.css";

type Props = {
  readonly caption: string;
  // The heading of the first column: what each row is.
  readonly label: string;
  readonly rows: readonly {
    readonly key: string | number;
    readonly label: ReactNode;
    readonly totals: Usage;
  }[];
};

// Tokens and cost per row, as a project's usage summary shows them.
export function AdminUsageTable({ caption, label, rows }: Props) {
  const columns = [
    label,
    ...TOKEN_FIELDS.map((field) => copy.project.usage[field]),
    copy.project.usage.costUsd,
  ];
  return (
    <AdminTable caption={caption} columns={columns}>
      {rows.map((row) => (
        <tr key={row.key}>
          <td>{row.label}</td>
          {TOKEN_FIELDS.map((field) => (
            <td key={field} className={styles.number}>
              {formatTokens(row.totals[field])}
            </td>
          ))}
          <td className={styles.number}>{formatCost(row.totals.costUsd)}</td>
        </tr>
      ))}
    </AdminTable>
  );
}
