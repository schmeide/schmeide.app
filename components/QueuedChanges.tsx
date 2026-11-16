import { useMutation } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";

import { copy } from "../data/copy";
import { useRefreshProjects, useTRPC, type Build } from "../trpc";
import { ErrorNote } from "./ErrorNote";

import stepStyles from "./Step.module.css";
import styles from "./QueuedChanges.module.css";

// One waiting change: its request, edited in place, or removed.
function QueuedChange({ build, position }: { readonly build: Build; readonly position: number }) {
  const trpc = useTRPC();
  const refresh = useRefreshProjects();
  const [draft, setDraft] = useState<string | null>(null);
  const edit = useMutation(
    trpc.builds.editQueued.mutationOptions({
      onSuccess: () => setDraft(null),
      onSettled: () => refresh(),
    })
  );
  const remove = useMutation(
    trpc.builds.removeQueued.mutationOptions({ onSettled: () => refresh() })
  );
  const pending = edit.isPending || remove.isPending;
  const fieldId = `queued-${build.id}`;
  const onSave = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (draft !== null) edit.mutate({ buildId: build.id, request: draft });
  };

  return (
    <li className={styles.item}>
      {draft === null ? (
        <>
          <p className={styles.request}>{build.request}</p>
          <div className={stepStyles.actions}>
            <button
              type="button"
              onClick={() => setDraft(build.request)}
              disabled={pending}
              aria-label={copy.project.queueEditLabel(position)}
            >
              {copy.project.queueEdit}
            </button>
            <button
              type="button"
              data-variant="danger"
              onClick={() => remove.mutate({ buildId: build.id })}
              disabled={pending}
              aria-label={copy.project.queueRemoveLabel(position)}
            >
              {remove.isPending ? copy.project.queueRemoving : copy.project.queueRemove}
            </button>
          </div>
        </>
      ) : (
        <form onSubmit={onSave} className={stepStyles.form}>
          <label htmlFor={fieldId}>{copy.project.queueEditFieldLabel(position)}</label>
          <textarea
            id={fieldId}
            rows={3}
            required
            maxLength={5000}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            autoFocus
          />
          <div className={stepStyles.actions}>
            <button type="submit" data-variant="primary" disabled={pending || !draft.trim()}>
              {edit.isPending ? copy.project.saving : copy.project.queueSave}
            </button>
            <button type="button" onClick={() => setDraft(null)} disabled={pending}>
              {copy.project.queueCancelEdit}
            </button>
          </div>
        </form>
      )}
      <ErrorNote error={edit.error ?? remove.error} />
    </li>
  );
}

// Changes waiting for the running build, in the order they will be built.
export function QueuedChanges({ queued }: { readonly queued: readonly Build[] }) {
  if (queued.length === 0) return null;
  return (
    <section aria-labelledby="queue" className={stepStyles.step}>
      <h2 id="queue">{copy.project.queueTitle}</h2>
      <p className={stepStyles.muted}>{copy.project.queueIntro}</p>
      <ol className={styles.list}>
        {queued.map((build, index) => (
          <QueuedChange key={build.id} build={build} position={index + 1} />
        ))}
      </ol>
    </section>
  );
}
