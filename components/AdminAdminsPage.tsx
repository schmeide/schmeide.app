import { useQuery } from "@tanstack/react-query";

import { copy } from "../data/copy";
import { useTRPC, useTRPCClient } from "../trpc";
import { AdminActionForm } from "./AdminActionForm";
import { AdminTable } from "./AdminTable";
import { ErrorNote } from "./ErrorNote";
import { useSession } from "./SessionProvider";

import styles from "./AdminTable.module.css";

// Who has the platform admin role. Each change asks for a reason. Your own role is not offered:
// the server refuses it, and the last admin's.
export function AdminAdminsPage() {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const { session } = useSession();
  const list = useQuery(trpc.admin.admins.list.queryOptions());

  return (
    <>
      <header>
        <h1>{copy.routes.adminAdmins}</h1>
        <p className={styles.intro}>{copy.admins.intro}</p>
      </header>
      <details className={styles.action}>
        <summary>{copy.admins.grant}</summary>
        <AdminActionForm
          hint={copy.admins.grantHint}
          fields={[{ name: "email", label: copy.adminActions.emailLabel, email: true }]}
          action={copy.admins.grantAction}
          run={({ email, reason }) =>
            client.admin.admins.grant.mutate({ email, reason }).then(({ token }) => token)
          }
        />
      </details>
      <ErrorNote error={list.error} />
      {list.isPending && <p>{copy.loading}</p>}
      {list.data && (
        <AdminTable caption={copy.admins.caption} columns={copy.admins.columns}>
          {list.data.map((admin) => {
            const name = admin.name ?? copy.people.notSignedIn;
            return (
              <tr key={admin.email}>
                <td>{name}</td>
                <td>{admin.email}</td>
                <td>{admin.pending ? copy.admins.pending : copy.admins.active}</td>
                <td>
                  {admin.email !== session.person?.email && (
                    <details>
                      <summary>{copy.admins.revoke(name)}</summary>
                      <AdminActionForm
                        hint={copy.admins.revokeHint}
                        action={copy.admins.revokeAction}
                        run={({ reason }) =>
                          client.admin.admins.revoke
                            .mutate({ email: admin.email, reason })
                            .then(() => null)
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
    </>
  );
}
