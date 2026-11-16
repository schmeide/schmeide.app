import { useQuery } from "@tanstack/react-query";
import { useSyncExternalStore, type ReactNode } from "react";

import { copy } from "../data/copy";
import { useTRPC } from "../trpc";
import { classifyError } from "../utils/apiError";
import { ProjectList } from "./ProjectList";
import { ProjectPage } from "./ProjectPage";

import styles from "./Studio.module.css";

const subscribe = (onChange: () => void) => {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
};
const PROJECT_HASH = /^#\/projects\/(\d+)$/;

// Picks the view from the URL hash (#/ or #/projects/<id>) once the API is known to answer.
export function Studio({
  isPublicSite,
  fallback,
}: {
  readonly isPublicSite: boolean;
  readonly fallback: ReactNode;
}) {
  const trpc = useTRPC();
  const list = useQuery(trpc.projects.list.queryOptions());
  const hash = useSyncExternalStore(subscribe, () => window.location.hash);
  const offline = !list.data && list.error !== null && classifyError(list.error) === "unreachable";

  if (isPublicSite && (list.isPending || offline)) return <main>{fallback}</main>;
  if (offline) {
    return (
      <main className={styles.page}>
        <h1>{copy.errors.serverDownTitle}</h1>
        <p>{copy.errors.serverDown}</p>
        <button type="button" onClick={() => void list.refetch()} disabled={list.isFetching}>
          {copy.errors.retry}
        </button>
      </main>
    );
  }
  const projectId = PROJECT_HASH.exec(hash)?.[1];
  return (
    <main className={styles.page}>
      {projectId ? <ProjectPage key={projectId} id={Number(projectId)} /> : <ProjectList />}
    </main>
  );
}
