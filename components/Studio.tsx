import type { ReactNode } from "react";

import { copy } from "../data/copy";
import { Routes } from "./Routes";
import { useSession } from "./SessionProvider";

import styles from "./Studio.module.css";

// Shows the app (the shell and its routes) once the server has said who is using it.
export function Studio({
  isPublicSite,
  fallback,
}: {
  readonly isPublicSite: boolean;
  readonly fallback: ReactNode;
}) {
  const { status, refresh } = useSession();

  if (status === "ready") return <Routes />;
  if (isPublicSite) return <main>{fallback}</main>;
  return (
    <main className={styles.page}>
      {status === "loading" ? (
        <p>{copy.loading}</p>
      ) : (
        <>
          <h1>{copy.errors.serverDownTitle}</h1>
          <p>{copy.errors.serverDown}</p>
          <button type="button" onClick={() => void refresh()}>
            {copy.errors.retry}
          </button>
        </>
      )}
    </main>
  );
}
