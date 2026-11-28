import { useMutation } from "@tanstack/react-query";

import { copy } from "../data/copy";
import { useRefreshProjects, useTRPC, type Project } from "../trpc";
import { ErrorNote } from "./ErrorNote";
import { StopButton } from "./StopButton";
import { Working } from "./Working";

import styles from "./Step.module.css";

type Props = { readonly project: Project; readonly onStop: () => void };

// Takes a live app offline, or puts an offline one back online as it was, without a build. Says
// what visitors see meanwhile. Nothing in any other status.
export function OfflineStep({ project, onStop }: Props) {
  const trpc = useTRPC();
  const refresh = useRefreshProjects();
  const start = useMutation(trpc.projects.start.mutationOptions({ onSettled: () => refresh() }));
  const offline = project.status === "stopped";
  if (!offline && project.status !== "live") return null;

  return (
    <section aria-labelledby="offline" className={styles.step}>
      <h2 id="offline">{offline ? copy.project.offline.offTitle : copy.project.offline.title}</h2>
      <p className={styles.muted}>
        {offline ? copy.project.offline.offIntro : copy.project.offline.intro}
      </p>
      <div className={styles.actions}>
        {offline ? (
          <button
            type="button"
            onClick={() => start.mutate({ id: project.id })}
            disabled={start.isPending}
          >
            {copy.project.offline.start}
          </button>
        ) : (
          <StopButton project={project} onStop={onStop} />
        )}
        <span aria-live="polite" className={styles.muted}>
          {start.isPending ? (
            <Working>{copy.project.offline.starting}</Working>
          ) : (
            start.isSuccess && !offline && copy.project.offline.started
          )}
        </span>
      </div>
      <ErrorNote error={start.error} />
    </section>
  );
}
