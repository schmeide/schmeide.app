import { useId, useState } from "react";

import { copy } from "../data/copy";
import type { Build } from "../trpc";
import { useBuildEvents } from "./BuildStep";

import stepStyles from "./Step.module.css";
import styles from "./BuildLog.module.css";

type Finished = Pick<Build, "id" | "status">;

// A finished build's log, fetched only once it is opened.
function Events({ build }: { readonly build: Finished }) {
  const events = useBuildEvents(build);
  return events.length === 0 ? (
    <p className={stepStyles.muted}>{copy.project.logEmpty}</p>
  ) : (
    <ol className={styles.events}>
      {events.map((event) => (
        <li key={event.id} data-kind={event.kind}>
          <span className={styles.kind}>{copy.project.eventKind[event.kind]}</span> {event.message}
        </li>
      ))}
    </ol>
  );
}

// "Show its log" and a finished build's log under it. `describedBy` names the build, since every
// past build has the same button.
export function BuildLog({
  build,
  describedBy,
}: {
  readonly build: Finished;
  readonly describedBy: string;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <>
      <button
        type="button"
        className={styles.toggle}
        aria-expanded={open}
        aria-controls={id}
        aria-describedby={describedBy}
        onClick={() => setOpen((shown) => !shown)}
      >
        {copy.project.history.showLog}
      </button>
      <div id={id} hidden={!open} className={styles.log} tabIndex={0}>
        {open && <Events build={build} />}
      </div>
    </>
  );
}
