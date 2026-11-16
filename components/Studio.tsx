import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { copy } from "../data/copy";
import { useTRPC } from "../trpc";
import { classifyError } from "../utils/apiError";
import { Routes } from "./Routes";

import styles from "./Studio.module.css";

// Shows the app (the shell and its routes) once the API is known to answer.
export function Studio({
  isPublicSite,
  fallback,
}: {
  readonly isPublicSite: boolean;
  readonly fallback: ReactNode;
}) {
  const trpc = useTRPC();
  const list = useQuery(trpc.projects.list.queryOptions());
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
  return <Routes />;
}
