import { useMutation } from "@tanstack/react-query";

import { copy } from "../data/copy";
import { ErrorNote } from "./ErrorNote";
import { useSession } from "./SessionProvider";

import styles from "./ImpersonationBanner.module.css";

// While an admin views the app as someone: who, and the way back. It cannot be dismissed. The
// status region is always there, so screen readers announce the banner when it appears.
export function ImpersonationBanner() {
  const { session, stopViewing } = useSession();
  const stop = useMutation({ mutationFn: stopViewing });
  const { person, impersonatedBy } = session;

  return (
    <div role="status">
      {person && impersonatedBy && (
        <section aria-label={copy.impersonation.label} className={styles.banner}>
          <div className={styles.inner}>
            <p className={styles.text}>
              <strong>{copy.impersonation.viewing(person.name, person.email)}</strong>{" "}
              {copy.impersonation.recorded(impersonatedBy.email)}
            </p>
            <button type="button" disabled={stop.isPending} onClick={() => stop.mutate()}>
              {stop.isPending ? copy.impersonation.stopping : copy.impersonation.stop}
            </button>
          </div>
          <ErrorNote error={stop.error} />
        </section>
      )}
    </div>
  );
}
