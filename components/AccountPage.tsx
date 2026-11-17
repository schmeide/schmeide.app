import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";

import { copy } from "../data/copy";
import { useTRPC, useTRPCClient, type Account } from "../trpc";
import { DeleteAccount } from "./DeleteAccount";
import { ErrorNote } from "./ErrorNote";
import { useSession } from "./SessionProvider";
import { SignedInDevices } from "./SignedInDevices";
import { SignInMethods } from "./SignInMethods";

import styles from "./Account.module.css";
import stepStyles from "./Step.module.css";

// The signed-in person's own account: their name, how and where they sign in, a copy of their
// details, and deleting it all. Each section is a card of its own.
export function AccountPage() {
  const trpc = useTRPC();
  const account = useQuery(trpc.account.get.queryOptions());

  return (
    <>
      <h1>{copy.routes.account}</h1>
      <ErrorNote error={account.error} />
      {account.isPending && <p>{copy.loading}</p>}
      {account.data && (
        <div className={styles.page}>
          <Profile account={account.data} />
          <SignInMethods account={account.data} />
          <SignedInDevices account={account.data} />
          <Details />
          <DeleteAccount account={account.data} />
        </div>
      )}
    </>
  );
}

function Profile({ account }: { readonly account: Account }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { refresh } = useSession();
  const [name, setName] = useState(account.name);
  const save = useMutation(
    trpc.account.rename.mutationOptions({
      // The account menu shows the name too.
      onSuccess: () =>
        Promise.all([
          refresh(),
          queryClient.invalidateQueries({ queryKey: trpc.account.pathKey() }),
        ]),
    })
  );
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    save.mutate({ name });
  };

  return (
    <section aria-labelledby="profile" className={stepStyles.step}>
      <h2 id="profile">{copy.accountPage.profile.title}</h2>
      <form onSubmit={onSubmit} className={stepStyles.form}>
        <label htmlFor="account-name">{copy.accountPage.profile.nameLabel}</label>
        <input
          id="account-name"
          name="name"
          type="text"
          required
          maxLength={100}
          autoComplete="name"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            save.reset();
          }}
        />
        <div className={stepStyles.actions}>
          <button type="submit" disabled={save.isPending}>
            {save.isPending ? copy.accountPage.profile.saving : copy.accountPage.profile.save}
          </button>
          <p role="status" className={styles.status}>
            {save.isSuccess ? copy.accountPage.profile.saved : ""}
          </p>
        </div>
        <ErrorNote error={save.error} />
      </form>
      <dl className={styles.facts}>
        <dt>{copy.accountPage.profile.emailLabel}</dt>
        <dd className={styles.email}>{account.email}</dd>
      </dl>
      <p className={stepStyles.muted}>{copy.accountPage.profile.emailNote}</p>
    </section>
  );
}

// A JSON file of what the server holds about the person, saved by the browser.
function Details() {
  const client = useTRPCClient();
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const download = async () => {
    setPreparing(true);
    setError(null);
    try {
      const details = await client.account.export.query();
      const file = new Blob([JSON.stringify(details, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(file);
      const link = document.createElement("a");
      link.href = url;
      link.download = copy.accountPage.details.fileName;
      link.click();
      URL.revokeObjectURL(url);
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error(String(caught)));
    } finally {
      setPreparing(false);
    }
  };

  return (
    <section aria-labelledby="details" className={stepStyles.step}>
      <h2 id="details">{copy.accountPage.details.title}</h2>
      <p>{copy.accountPage.details.intro}</p>
      <div className={stepStyles.actions}>
        <button type="button" onClick={() => void download()} disabled={preparing}>
          {copy.accountPage.details.download}
        </button>
        <p role="status" className={styles.status}>
          {preparing ? copy.accountPage.details.preparing : ""}
        </p>
      </div>
      <ErrorNote error={error} />
    </section>
  );
}
