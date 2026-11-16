import { useMutation } from "@tanstack/react-query";
import { useState } from "react";

import { copy } from "../data/copy";
import { useRefreshProjects, useTRPC, type Project } from "../trpc";
import { ErrorNote } from "./ErrorNote";

import styles from "./Step.module.css";

type Props = { readonly project: Project; readonly onStop: () => void };

// Stop (cancel a build, or take a live app offline) and delete, which asks first.
export function ProjectActions({ project, onStop }: Props) {
  const trpc = useTRPC();
  const refresh = useRefreshProjects();
  const [confirming, setConfirming] = useState(false);
  const stop = useMutation(
    trpc.projects.stop.mutationOptions({ onSuccess: onStop, onSettled: () => refresh() })
  );
  const remove = useMutation(
    trpc.projects.delete.mutationOptions({
      onSuccess: () => {
        window.location.assign("#/");
        void refresh();
      },
    })
  );
  const stopLabel =
    project.status === "building"
      ? copy.project.cancelBuild
      : project.status === "live"
        ? copy.project.takeOffline
        : null;
  const canDelete = project.status !== "building" && project.status !== "spec_generating";
  if (!stopLabel && !canDelete) return null;

  return (
    <section aria-labelledby="manage" className={styles.step}>
      <h2 id="manage">{copy.project.manageTitle}</h2>
      <div className={styles.actions}>
        {stopLabel && (
          <button
            type="button"
            onClick={() => stop.mutate({ id: project.id })}
            disabled={stop.isPending}
          >
            {stop.isPending ? copy.project.stopping : stopLabel}
          </button>
        )}
        {canDelete && !confirming && (
          <button type="button" data-variant="danger" onClick={() => setConfirming(true)}>
            {copy.project.delete}
          </button>
        )}
      </div>
      {confirming && canDelete && (
        <div role="group" aria-labelledby="delete-confirm" className={styles.warning}>
          <p id="delete-confirm">{copy.project.deleteConfirm(project.name)}</p>
          <div className={styles.actions}>
            <button
              type="button"
              data-variant="danger"
              onClick={() => remove.mutate({ id: project.id })}
              disabled={remove.isPending}
            >
              {copy.project.deleteYes}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              disabled={remove.isPending}
              autoFocus
            >
              {copy.project.deleteNo}
            </button>
          </div>
          <p aria-live="polite">{remove.isPending ? copy.project.deleting : ""}</p>
        </div>
      )}
      <ErrorNote error={stop.error ?? remove.error} />
    </section>
  );
}
