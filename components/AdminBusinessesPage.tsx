import { useInfiniteQuery } from "@tanstack/react-query";
import { useState } from "react";

import { copy } from "../data/copy";
import { useTRPC } from "../trpc";
import { pathTo } from "../utils/routes";
import { AdminSearch } from "./AdminSearch";
import { AdminTable } from "./AdminTable";
import { ErrorNote } from "./ErrorNote";
import { Link } from "./Link";

import styles from "./AdminTable.module.css";

const day = new Intl.DateTimeFormat("en-US", { dateStyle: "medium" });

// Every business, newest first, found by its name or a member's email.
export function AdminBusinessesPage() {
  const trpc = useTRPC();
  const [search, setSearch] = useState("");
  const list = useInfiniteQuery(
    trpc.admin.businesses.list.infiniteQueryOptions(
      { search: search || undefined },
      { getNextPageParam: (page) => page.nextCursor }
    )
  );
  const entries = list.data?.pages.flatMap((page) => page.entries) ?? [];

  return (
    <>
      <header>
        <h1>{copy.routes.adminBusinesses}</h1>
        <p className={styles.intro}>{copy.businesses.intro}</p>
      </header>
      <AdminSearch hint={copy.businesses.searchHint} onSearch={setSearch} />
      <ErrorNote error={list.error} />
      {list.isPending && <p>{copy.loading}</p>}
      {list.isSuccess && entries.length === 0 && <p>{copy.businesses.empty}</p>}
      {entries.length > 0 && (
        <AdminTable caption={copy.businesses.caption} columns={copy.businesses.columns}>
          {entries.map((business) => (
            <tr key={business.id}>
              <td>
                <Link to={pathTo("adminBusiness", { id: business.id })}>
                  {business.name || business.slug}
                </Link>
              </td>
              <td>{business.slug}</td>
              <td className={styles.number}>{business.members}</td>
              <td className={styles.number}>{business.projects}</td>
              <td className={styles.number}>
                <time dateTime={business.createdAt.toISOString()}>
                  {day.format(business.createdAt)}
                </time>
              </td>
            </tr>
          ))}
        </AdminTable>
      )}
      {list.hasNextPage && (
        <button
          type="button"
          className={styles.more}
          disabled={list.isFetchingNextPage}
          onClick={() => void list.fetchNextPage()}
        >
          {list.isFetchingNextPage ? copy.loading : copy.adminSearch.more}
        </button>
      )}
    </>
  );
}
