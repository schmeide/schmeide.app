import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useState, type FormEvent } from "react";

import { copy } from "../data/copy";
import { useTRPC } from "../trpc";
import { pathTo } from "../utils/routes";
import { ErrorNote } from "./ErrorNote";

import errorStyles from "./ErrorNote.module.css";
import styles from "./AdminActionForm.module.css";

export type ActionField = { readonly name: string; readonly label: string; readonly email?: true };

type Props = {
  // What the action does, above the form.
  readonly hint: string;
  // Fields to type besides the reason, which every action needs.
  readonly fields?: readonly ActionField[];
  readonly action: string;
  // Calls the server with what was typed, the reason trimmed. Answers a set-password token when
  // the server sent one, which is shown here once and kept nowhere else.
  readonly run: (values: Readonly<Record<string, string>>) => Promise<string | null | void>;
};

// An admin action that changes something, after the admin gives a reason. Every admin list is
// loaded again once it is done.
export function AdminActionForm({ hint, fields = [], action, run }: Props) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const id = useId();
  const [missingReason, setMissingReason] = useState(false);
  const mutation = useMutation({
    mutationFn: run,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: trpc.admin.pathKey() }),
  });

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const values = Object.fromEntries(
      [...fields.map(({ name }) => name), "reason"].map((name) => [
        name,
        String(form.get(name) ?? "").trim(),
      ])
    );
    setMissingReason(values.reason === "");
    if (values.reason !== "") mutation.mutate(values);
  };

  const link =
    mutation.data && `${window.location.origin}${pathTo("setPassword")}?token=${mutation.data}`;
  return (
    <form onSubmit={onSubmit} noValidate className={styles.form}>
      <p className={styles.hint}>{hint}</p>
      {fields.map((field) => (
        <div key={field.name} className={styles.field}>
          <label htmlFor={`${id}-${field.name}`}>{field.label}</label>
          <input
            id={`${id}-${field.name}`}
            name={field.name}
            type={field.email ? "email" : "text"}
            required
            autoComplete="off"
          />
        </div>
      ))}
      <label htmlFor={`${id}-reason`}>{copy.adminActions.reasonLabel}</label>
      <input
        id={`${id}-reason`}
        name="reason"
        required
        maxLength={500}
        aria-invalid={missingReason || undefined}
        aria-describedby={`${id}-hint${missingReason ? ` ${id}-error` : ""}`}
      />
      <p id={`${id}-hint`} className={styles.hint}>
        {copy.adminActions.reasonHint}
      </p>
      {missingReason && (
        <p id={`${id}-error`} role="alert" className={errorStyles.error}>
          {copy.adminActions.reasonNeeded}
        </p>
      )}
      <button type="submit" data-variant="primary" disabled={mutation.isPending}>
        {mutation.isPending ? copy.adminActions.working : action}
      </button>
      <ErrorNote error={mutation.error} />
      {mutation.isSuccess && (
        <output className={styles.result}>
          {link ? (
            <>
              <span>{copy.adminActions.linkIntro}</span>
              <code className={styles.link}>{link}</code>
            </>
          ) : (
            copy.adminActions.done
          )}
        </output>
      )}
    </form>
  );
}
