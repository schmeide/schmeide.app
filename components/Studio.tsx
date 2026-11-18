import { useState, type ReactNode } from "react";

import { copy } from "../data/copy";
import { serverDownText } from "./ErrorNote";
import { MaintenancePage } from "./MaintenancePage";
import { OfflinePage } from "./OfflinePage";
import { Routes } from "./Routes";
import { useSession } from "./SessionProvider";

import styles from "./Studio.module.css";

// Planned work, set when the site is built: VITE_MAINTENANCE_UNTIL, the date and time to come back
// after (an ISO 8601 string, say 2026-12-01T06:00:00Z). Unset or unreadable, there is none.
const plannedUntil = (value: unknown): Date | null => {
  const until = typeof value === "string" && value ? new Date(value) : null;
  return until && !Number.isNaN(until.getTime()) ? until : null;
};

// Shows the app (the shell and its routes) once the server has said who is using it.
export function Studio({
  isPublicSite,
  expectsApi = false,
  fallback,
  maintenanceUntil = plannedUntil(import.meta.env.VITE_MAINTENANCE_UNTIL),
}: {
  readonly isPublicSite: boolean;
  // The public site was built with an API address, so it waits for the answer instead of
  // flashing the fallback first.
  readonly expectsApi?: boolean;
  readonly fallback: ReactNode;
  readonly maintenanceUntil?: Date | null;
}) {
  const { status, refresh } = useSession();
  // Read once: the page is not left open across the end of the work.
  const [now] = useState(() => Date.now());

  if (maintenanceUntil && maintenanceUntil.getTime() > now)
    return (
      <main className={styles.page}>
        <MaintenancePage until={maintenanceUntil} />
      </main>
    );
  if (status === "ready") return <Routes />;
  if (isPublicSite && !(expectsApi && status === "loading")) return <main>{fallback}</main>;
  return (
    <main className={styles.page}>
      {status === "loading" ? (
        <p>{copy.loading}</p>
      ) : (
        <OfflinePage title={copy.errors.serverDownTitle} body={serverDownText} onRetry={refresh} />
      )}
    </main>
  );
}
