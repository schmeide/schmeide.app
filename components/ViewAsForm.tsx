import { useMutation } from "@tanstack/react-query";
import { useId, useState, type FormEvent } from "react";

import { copy } from "../data/copy";
import { ErrorNote } from "./ErrorNote";
import { useSession } from "./SessionProvider";

import errorStyles from "./ErrorNote.module.css";
import styles from "./ViewAsForm.module.css";

type Props = {
  // The person to view as. Left out, the admin types their email.
  readonly email?: string;
};

// Starts viewing the app as a person, after the admin gives a reason, which the audit log keeps.
// The admin then lands on the person's home (SessionProvider).
export function ViewAsForm({ email }: Props) {
  const { startViewingAs } = useSession();
  const id = useId();
  const [missingReason, setMissingReason] = useState(false);
  const start = useMutation({
    mutationFn: (input: { readonly email: string; readonly reason: string }) =>
      startViewingAs(input.email, input.reason),
  });

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const reason = String(form.get("reason")).trim();
    setMissingReason(reason === "");
    if (reason === "") return;
    start.mutate({ email: email ?? String(form.get("email")), reason });
  };

  return (
    <form onSubmit={onSubmit} noValidate className={styles.form}>
      {email === undefined && (
        <>
          <label htmlFor={`${id}-email`}>{copy.viewAs.emailLabel}</label>
          <input id={`${id}-email`} name="email" type="email" required autoComplete="off" />
        </>
      )}
      <label htmlFor={`${id}-reason`}>{copy.viewAs.reasonLabel}</label>
      <input
        id={`${id}-reason`}
        name="reason"
        required
        maxLength={500}
        aria-invalid={missingReason || undefined}
        aria-describedby={`${id}-hint${missingReason ? ` ${id}-error` : ""}`}
      />
      <p id={`${id}-hint`} className={styles.hint}>
        {copy.viewAs.reasonHint}
      </p>
      {missingReason && (
        <p id={`${id}-error`} role="alert" className={errorStyles.error}>
          {copy.viewAs.reasonNeeded}
        </p>
      )}
      <button type="submit" data-variant="primary" disabled={start.isPending}>
        {start.isPending ? copy.viewAs.starting : copy.viewAs.action}
      </button>
      <ErrorNote error={start.error} />
    </form>
  );
}
