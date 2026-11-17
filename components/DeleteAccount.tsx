import { useMutation } from "@tanstack/react-query";
import { useEffect, useRef, useState, type FormEvent } from "react";

import { copy } from "../data/copy";
import { useTRPC, type Account } from "../trpc";
import { leaveTo } from "../utils/navigation";
import { pathTo } from "../utils/routes";
import { ErrorNote } from "./ErrorNote";
import { Link } from "./Link";
import { useSession } from "./SessionProvider";

import errorStyles from "./ErrorNote.module.css";
import styles from "./Account.module.css";
import stepStyles from "./Step.module.css";

const text = copy.accountPage.delete;

// Says what deleting does to each business, refuses while a business would be stranded, and
// otherwise deletes once the person types their email address.
export function DeleteAccount({ account }: { readonly account: Account }) {
  const trpc = useTRPC();
  const { signOut } = useSession();
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState("");
  const [mismatch, setMismatch] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  // "Keep my account" puts focus back on the button that opened the form.
  const startButton = useRef<HTMLButtonElement>(null);
  const wasConfirming = useRef(false);
  useEffect(() => {
    if (wasConfirming.current && !confirming) startButton.current?.focus();
    wasConfirming.current = confirming;
  }, [confirming]);
  const remove = useMutation(
    trpc.account.delete.mutationOptions({
      // A full page load, so nothing of the deleted account stays in memory.
      onSuccess: async () => {
        await signOut();
        leaveTo(`${pathTo("signIn")}?deleted`);
      },
    })
  );

  const blocked = account.businesses.filter(
    (business) => business.onDelete === "deleteApps" || business.onDelete === "handOver"
  );

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (typed.trim().toLowerCase() !== account.email.toLowerCase()) {
      setMismatch(true);
      field.current?.focus();
      return;
    }
    remove.mutate({ email: typed.trim() });
  };

  return (
    <section aria-labelledby="delete-account" className={stepStyles.step}>
      <h2 id="delete-account">{text.title}</h2>
      <p>{text.intro}</p>
      {blocked.length > 0 ? (
        <div className={stepStyles.warning}>
          <h3 className={styles.subhead}>{text.blockedTitle}</h3>
          <ul className={styles.reasons}>
            {blocked.map((business) => (
              <li key={business.id}>
                {business.onDelete === "deleteApps"
                  ? text.blocked.deleteApps(business.name)
                  : text.blocked.handOver(business.name)}
              </li>
            ))}
          </ul>
          {blocked.some((business) => business.onDelete === "deleteApps") && (
            <p className={styles.reasonLink}>
              <Link to={pathTo("apps")}>{text.toApps}</Link>
            </p>
          )}
        </div>
      ) : (
        <>
          {account.businesses.length > 0 && (
            <ul className={styles.reasons}>
              {account.businesses.map((business) => (
                <li key={business.id}>
                  {business.onDelete === "remove"
                    ? text.outcome.remove(business.name)
                    : text.outcome.leave(business.name)}
                </li>
              ))}
            </ul>
          )}
          {confirming ? (
            <form onSubmit={onSubmit} className={stepStyles.form}>
              <label htmlFor="delete-email" className={styles.email}>
                {text.confirmLabel(account.email)}
              </label>
              <input
                id="delete-email"
                ref={field}
                name="confirm-email"
                type="email"
                autoComplete="off"
                spellCheck={false}
                required
                autoFocus
                value={typed}
                aria-invalid={mismatch || undefined}
                aria-describedby={mismatch ? "delete-email-error" : undefined}
                onChange={(event) => {
                  setTyped(event.target.value);
                  setMismatch(false);
                }}
              />
              {mismatch && (
                <p id="delete-email-error" role="alert" className={errorStyles.error}>
                  {text.mismatch}
                </p>
              )}
              <div className={stepStyles.actions}>
                <button type="submit" data-variant="danger" disabled={remove.isPending}>
                  {remove.isPending ? text.deleting : text.confirm}
                </button>
                <button
                  type="button"
                  disabled={remove.isPending}
                  onClick={() => {
                    setConfirming(false);
                    setTyped("");
                    setMismatch(false);
                  }}
                >
                  {text.cancel}
                </button>
              </div>
              <ErrorNote error={remove.error} />
            </form>
          ) : (
            <button
              type="button"
              ref={startButton}
              data-variant="danger"
              onClick={() => setConfirming(true)}
            >
              {text.start}
            </button>
          )}
        </>
      )}
    </section>
  );
}
