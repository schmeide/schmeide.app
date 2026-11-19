import { useMutation } from "@tanstack/react-query";
import { useState } from "react";

import { copy } from "../data/copy";
import { useRefreshProjects, useTRPC, type Project } from "../trpc";
import { navigate } from "../utils/navigation";
import { pathTo } from "../utils/routes";
import { appName } from "../utils/appName";
import { ErrorNote } from "./ErrorNote";

import styles from "./Step.module.css";

export const canDelete = (project: Project) =>
  project.status !== "building" && project.status !== "spec_generating";

// "Delete project", which asks first and says what goes. Nothing while a spec or build runs.
export function DeleteProject({ project }: { readonly project: Project }) {
  const trpc = useTRPC();
  const refresh = useRefreshProjects();
  const [confirming, setConfirming] = useState(false);
  const remove = useMutation(
    trpc.projects.delete.mutationOptions({
      onSuccess: () => {
        navigate(pathTo("apps"));
        void refresh();
      },
    })
  );
  if (!canDelete(project)) return null;

  return (
    <>
      {confirming ? (
        <div role="group" aria-labelledby="delete-confirm" className={styles.warning}>
          <p id="delete-confirm">{copy.project.deleteConfirm(appName(project))}</p>
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
      ) : (
        <button type="button" data-variant="danger" onClick={() => setConfirming(true)}>
          {copy.project.delete}
        </button>
      )}
      <ErrorNote error={remove.error} />
    </>
  );
}
