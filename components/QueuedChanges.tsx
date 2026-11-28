import { useMutation } from "@tanstack/react-query";
import { useRef, useState, type FormEvent } from "react";

import { copy } from "../data/copy";
import { useRefreshProjects, useTRPC, type Build, type Project } from "../trpc";
import { ErrorNote } from "./ErrorNote";
import { Working } from "./Working";

import stepStyles from "./Step.module.css";
import styles from "./QueuedChanges.module.css";

// One waiting change: its request, edited in place, or removed.
function QueuedChange({ build, position }: { readonly build: Build; readonly position: number }) {
  const trpc = useTRPC();
  const refresh = useRefreshProjects();
  const [draft, setDraft] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
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
    const text = draft?.trim() ?? "";
    setMissing(text === "");
    if (text === "") {
      field.current?.focus();
      return;
    }
    edit.mutate({ buildId: build.id, request: draft ?? "" });
  };

  return (
    <li className={styles.item}>
      {draft === null ? (
        <>
          <p className={styles.request}>
            {build.kind === "site" ? copy.project.siteChangeRequest : build.request}
          </p>
          <div className={stepStyles.actions}>
            {build.kind === "change" && (
              <button
                type="button"
                onClick={() => {
                  setMissing(false);
                  setDraft(build.request);
                }}
                disabled={pending}
                aria-label={copy.project.queueEditLabel(position)}
              >
                {copy.project.queueEdit}
              </button>
            )}
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
        <form onSubmit={onSave} className={stepStyles.form} noValidate>
          <label htmlFor={fieldId}>{copy.project.queueEditFieldLabel(position)}</label>
          <textarea
            ref={field}
            id={fieldId}
            rows={3}
            required
            maxLength={5000}
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              setMissing(false);
            }}
            autoFocus
            aria-invalid={missing || undefined}
            aria-describedby={missing ? `${fieldId}-error` : undefined}
          />
          {missing && (
            <p id={`${fieldId}-error`} className={stepStyles.fieldError}>
              {copy.project.queueMissing}
            </p>
          )}
          <div className={stepStyles.actions}>
            <button type="submit" disabled={pending}>
              {edit.isPending ? copy.project.saving : copy.project.queueSave}
            </button>
            <button
              type="button"
              onClick={() => {
                setMissing(false);
                setDraft(null);
              }}
              disabled={pending}
            >
              {copy.project.queueCancelEdit}
            </button>
          </div>
        </form>
      )}
      <ErrorNote error={edit.error ?? remove.error} />
    </li>
  );
}

// After a failed or canceled build the queue waits; this starts its oldest change.
function BuildWaiting({ project }: { readonly project: Project }) {
  const trpc = useTRPC();
  const refresh = useRefreshProjects();
  const start = useMutation(
    trpc.projects.buildWaiting.mutationOptions({ onSettled: () => refresh() })
  );
  if (project.status !== "failed" && project.status !== "stopped") return null;
  return (
    <>
      <div className={stepStyles.actions}>
        <button
          type="button"
          onClick={() => start.mutate({ id: project.id })}
          disabled={start.isPending}
        >
          {start.isPending ? (
            <Working>{copy.project.queueStarting}</Working>
          ) : (
            copy.project.queueBuildNow
          )}
        </button>
      </div>
      <ErrorNote error={start.error} />
    </>
  );
}

// Changes waiting for the running build, in the order they will be built.
export function QueuedChanges({
  project,
  queued,
}: {
  readonly project: Project;
  readonly queued: readonly Build[];
}) {
  if (queued.length === 0) return null;
  return (
    <section aria-labelledby="queue" className={stepStyles.step}>
      <h2 id="queue">{copy.project.queueTitle}</h2>
      <p className={stepStyles.muted}>{copy.project.queueIntro}</p>
      <BuildWaiting project={project} />
      <ol className={styles.list}>
        {queued.map((build, index) => (
          <QueuedChange key={build.id} build={build} position={index + 1} />
        ))}
      </ol>
    </section>
  );
}
