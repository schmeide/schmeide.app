import { useInfiniteQuery } from "@tanstack/react-query";
import { useState } from "react";

import { copy } from "../data/copy";
import { useTRPC } from "../trpc";
import { pathTo } from "../utils/routes";
import { AdminSearch } from "./AdminSearch";
import { AdminTable } from "./AdminTable";
import { ErrorNote } from "./ErrorNote";
import { Link } from "./Link";
import { ViewAsDisclosure } from "./ViewAsDisclosure";

import styles from "./AdminTable.module.css";

// Every person with an account. A customer's row offers viewing the app as them.
export function AdminPeoplePage() {
  const trpc = useTRPC();
  const [search, setSearch] = useState("");
  const list = useInfiniteQuery(
    trpc.admin.people.list.infiniteQueryOptions(
      { search: search || undefined },
      { getNextPageParam: (page) => page.nextCursor }
    )
  );
  const entries = list.data?.pages.flatMap((page) => page.entries) ?? [];

  return (
    <>
      <header>
        <h1>{copy.routes.adminPeople}</h1>
        <p className={styles.intro}>{copy.people.intro}</p>
      </header>
      <AdminSearch hint={copy.people.searchHint} onSearch={setSearch} />
      <ErrorNote error={list.error} />
      {list.isPending && <p>{copy.loading}</p>}
      {list.isSuccess && entries.length === 0 && <p>{copy.people.empty}</p>}
      {entries.length > 0 && (
        <AdminTable caption={copy.people.caption} columns={copy.people.columns}>
          {entries.map((person) => (
            <tr key={person.email}>
              <td>{person.name}</td>
              <td>{person.email}</td>
              <td>
                {person.businesses.map((business) => (
                  <Link
                    key={business.id}
                    to={pathTo("adminBusiness", { id: business.id })}
                    className={styles.stacked}
                  >
                    {business.name || business.id}
                  </Link>
                ))}
              </td>
              <td>{person.approved ? copy.people.yes : copy.people.no}</td>
              <td>{person.admin ? copy.people.yes : copy.people.no}</td>
              <td>
                <ViewAsDisclosure name={person.name} email={person.email} admin={person.admin} />
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
