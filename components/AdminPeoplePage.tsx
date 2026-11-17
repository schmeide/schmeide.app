import { useInfiniteQuery } from "@tanstack/react-query";
import { useState } from "react";

import { copy } from "../data/copy";
import { useTRPC, useTRPCClient } from "../trpc";
import { pathTo } from "../utils/routes";
import { AdminActionForm } from "./AdminActionForm";
import { AdminSearch } from "./AdminSearch";
import { AdminTable } from "./AdminTable";
import { ErrorNote } from "./ErrorNote";
import { Link } from "./Link";
import { useSession } from "./SessionProvider";
import { ViewAsDisclosure } from "./ViewAsDisclosure";

import styles from "./AdminTable.module.css";

// Every person with an account, and every approved email with none yet. A customer's row offers
// viewing the app as them and taking their access away or giving it back, each behind a disclosure
// that asks for the reason. An admin, the caller included, is offered none of them: their access
// goes with the admin role.
export function AdminPeoplePage() {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const { session } = useSession();
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
      <details className={styles.action}>
        <summary>{copy.people.approve}</summary>
        <AdminActionForm
          hint={copy.people.approveHint}
          fields={[{ name: "email", label: copy.adminActions.emailLabel, email: true }]}
          action={copy.people.approveAction}
          run={({ email, reason }) =>
            client.admin.access.approve.mutate({ email, reason }).then(({ token }) => token)
          }
        />
      </details>
      <AdminSearch hint={copy.people.searchHint} onSearch={setSearch} />
      <ErrorNote error={list.error} />
      {list.isPending && <p>{copy.loading}</p>}
      {list.isSuccess && entries.length === 0 && <p>{copy.people.empty}</p>}
      {entries.length > 0 && (
        <AdminTable caption={copy.people.caption} columns={copy.people.columns}>
          {entries.map((person) => {
            const name = person.name ?? copy.people.notSignedIn;
            const customer = !person.admin && person.email !== session.person?.email;
            return (
              <tr key={person.email}>
                <td>{name}</td>
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
                  {person.hasAccount && (
                    <ViewAsDisclosure name={name} email={person.email} admin={person.admin} />
                  )}
                  {customer && person.approved && (
                    <details>
                      <summary>{copy.people.removeAccess(name)}</summary>
                      <AdminActionForm
                        hint={copy.people.removeHint}
                        action={copy.people.removeAction}
                        run={({ reason }) =>
                          client.admin.access.remove
                            .mutate({ email: person.email, reason })
                            .then(() => null)
                        }
                      />
                    </details>
                  )}
                  {!person.approved && (
                    <details>
                      <summary>{copy.people.restoreAccess(name)}</summary>
                      <AdminActionForm
                        hint={copy.people.restoreHint}
                        action={copy.people.restoreAction}
                        run={({ reason }) =>
                          client.admin.access.approve
                            .mutate({ email: person.email, reason })
                            .then(({ token }) => token)
                        }
                      />
                    </details>
                  )}
                </td>
              </tr>
            );
          })}
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
