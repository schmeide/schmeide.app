import { useMutation } from "@tanstack/react-query";
import { useRef, useState, type FormEvent } from "react";

import { copy } from "../data/copy";
import { useRefreshProjects, useTRPC, type Project } from "../trpc";
import { navigate } from "../utils/navigation";
import { pathTo } from "../utils/routes";
import { appName } from "../utils/appName";
import { ErrorNote } from "./ErrorNote";

import styles from "./Step.module.css";

export const canDelete = (project: Project) =>
  project.status !== "building" && project.status !== "spec_generating";

// "Delete this app", which says what goes and asks for the app's name to be typed first. Nothing
// while a spec or build runs.
export function DeleteProject({ project }: { readonly project: Project }) {
  const trpc = useTRPC();
  const refresh = useRefreshProjects();
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState("");
  const [mismatch, setMismatch] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const remove = useMutation(
    trpc.projects.delete.mutationOptions({
      onSuccess: () => {
        navigate(pathTo("apps"));
        void refresh();
      },
    })
  );
  if (!canDelete(project)) return null;

  const name = appName(project);
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (typed.trim() !== name.trim()) {
      setMismatch(true);
      field.current?.focus();
      return;
    }
    remove.mutate({ id: project.id });
  };

  return (
    <>
      {confirming ? (
        <form
          onSubmit={onSubmit}
          aria-labelledby="delete-confirm"
          className={`${styles.warning} ${styles.form}`}
        >
          <p id="delete-confirm">{copy.project.deleteConfirm(name)}</p>
          <label htmlFor="delete-name">{copy.project.deleteLabel(name)}</label>
          <input
            id="delete-name"
            ref={field}
            type="text"
            autoComplete="off"
            spellCheck={false}
            autoFocus
            value={typed}
            aria-invalid={mismatch || undefined}
            aria-describedby={mismatch ? "delete-name-error" : undefined}
            onChange={(event) => {
              setTyped(event.target.value);
              setMismatch(false);
            }}
          />
          {mismatch && (
            <p id="delete-name-error" className={styles.fieldError}>
              {copy.project.deleteMismatch}
            </p>
          )}
          <div className={styles.actions}>
            <button type="submit" data-variant="danger" disabled={remove.isPending}>
              {copy.project.deleteYes}
            </button>
            <button
              type="button"
              onClick={() => {
                setConfirming(false);
                setTyped("");
                setMismatch(false);
              }}
              disabled={remove.isPending}
            >
              {copy.project.deleteNo}
            </button>
          </div>
          <p aria-live="polite">{remove.isPending ? copy.project.deleting : ""}</p>
        </form>
      ) : (
        <button type="button" data-variant="danger" onClick={() => setConfirming(true)}>
          {copy.project.delete}
        </button>
      )}
      <ErrorNote error={remove.error} />
    </>
  );
}
