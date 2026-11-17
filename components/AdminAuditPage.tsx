import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { copy } from "../data/copy";
import { useTRPC } from "../trpc";
import { ErrorNote } from "./ErrorNote";

import styles from "./AdminAuditPage.module.css";

const when = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" });

// What admins did, newest first, narrowed to one admin or one business.
export function AdminAuditPage() {
  const trpc = useTRPC();
  const [admin, setAdmin] = useState("");
  const [tenantId, setTenantId] = useState("");
  const filters = useQuery(trpc.admin.audit.filters.queryOptions());
  const log = useInfiniteQuery(
    trpc.admin.audit.list.infiniteQueryOptions(
      { admin: admin || undefined, tenantId: tenantId ? Number(tenantId) : undefined },
      { getNextPageParam: (page) => page.nextCursor }
    )
  );
  const entries = log.data?.pages.flatMap((page) => page.entries) ?? [];

  return (
    <>
      <header>
        <h1>{copy.routes.adminAudit}</h1>
        <p className={styles.intro}>{copy.audit.intro}</p>
      </header>

      <div className={styles.filters}>
        <label>
          {copy.audit.adminLabel}
          <select value={admin} onChange={(event) => setAdmin(event.target.value)}>
            <option value="">{copy.audit.anyAdmin}</option>
            {filters.data?.admins.map((label) => (
              <option key={label} value={label}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          {copy.audit.businessLabel}
          <select value={tenantId} onChange={(event) => setTenantId(event.target.value)}>
            <option value="">{copy.audit.anyBusiness}</option>
            {filters.data?.businesses.map((business) => (
              <option key={business.id} value={business.id}>
                {business.name || business.slug}
              </option>
            ))}
          </select>
        </label>
      </div>

      <ErrorNote error={log.error ?? filters.error} />
      {log.isPending && <p>{copy.loading}</p>}
      {log.isSuccess && entries.length === 0 && <p>{copy.audit.empty}</p>}
      {entries.length > 0 && (
        <div className={styles.scroll} role="region" aria-label={copy.audit.caption} tabIndex={0}>
          <table className={styles.table}>
            <caption className={styles.caption}>{copy.audit.caption}</caption>
            <thead>
              <tr>
                {copy.audit.columns.map((column) => (
                  <th key={column} scope="col">
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id}>
                  <td>
                    <time dateTime={entry.createdAt.toISOString()}>
                      {when.format(entry.createdAt)}
                    </time>
                  </td>
                  <td>{entry.admin}</td>
                  <td>
                    <code>{entry.action}</code>
                  </td>
                  <td>
                    {[entry.targetEmail, entry.targetBusiness].filter(Boolean).map((target) => (
                      <span key={target} className={styles.target}>
                        {target}
                      </span>
                    ))}
                  </td>
                  <td>{entry.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {log.hasNextPage && (
        <button
          type="button"
          className={styles.more}
          disabled={log.isFetchingNextPage}
          onClick={() => void log.fetchNextPage()}
        >
          {log.isFetchingNextPage ? copy.loading : copy.audit.more}
        </button>
      )}
    </>
  );
}
