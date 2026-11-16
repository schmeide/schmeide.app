import { useEffect, useRef, useState } from "react";

import { copy } from "../data/copy";
import { POLL_MS, useTRPCClient, type Build, type BuildEvent } from "../trpc";

import stepStyles from "./Step.module.css";
import styles from "./BuildStep.module.css";

const EVENTS_PAGE = 500;

const duration = (ms: number) => {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return copy.duration(Math.floor(seconds / 60), seconds % 60);
};

// Pages the build's events forward with afterId, every POLL_MS while the build runs and once more
// when it ends. Mount it with key={build.id} so a new build starts a fresh log.
function useBuildEvents(build: Build): readonly BuildEvent[] {
  const client = useTRPCClient();
  const [events, setEvents] = useState<readonly BuildEvent[]>([]);
  const afterId = useRef(0);
  const running = build.status === "running";

  useEffect(() => {
    let canceled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const page = await client.builds.events.query({
          buildId: build.id,
          afterId: afterId.current,
        });
        if (canceled) return;
        const last = page.at(-1);
        if (last) {
          afterId.current = last.id;
          setEvents((previous) => [...previous, ...page]);
        }
        if (page.length === EVENTS_PAGE) return void poll();
      } catch {
        // The project query reports an unreachable server; keep trying while the build runs.
      }
      if (!canceled && running) timer = setTimeout(() => void poll(), POLL_MS);
    };
    void poll();
    return () => {
      canceled = true;
      clearTimeout(timer);
    };
  }, [client, build.id, running]);

  return events;
}

function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  return now;
}

export function BuildStep({ build }: { readonly build: Build }) {
  const events = useBuildEvents(build);
  const running = build.status === "running";
  const now = useNow(running);
  const log = useRef<HTMLDivElement>(null);
  const last = events.at(-1);

  // Keep the newest event in view inside the log, without scrolling the page.
  useEffect(() => {
    if (log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [events]);

  const end = build.finishedAt?.getTime() ?? now;
  return (
    <section aria-labelledby="build" className={stepStyles.step}>
      <h2 id="build">
        {build.kind === "initial" ? copy.project.buildTitle : copy.project.changeTitle}
      </h2>
      {build.kind !== "initial" && (
        <p>
          <span className={stepStyles.muted}>{copy.project.changeRequestLabel}</span>{" "}
          {build.kind === "site" ? copy.project.siteChangeRequest : build.request}
        </p>
      )}
      <p className={styles.summary} data-status={build.status}>
        <strong>{copy.project.buildStatus[build.status]}</strong>
        {running && last && <span>{copy.project.phase[last.kind]}</span>}
        <span className={stepStyles.muted}>
          {copy.project.elapsed} {duration(end - build.startedAt.getTime())}
        </span>
      </p>

      {build.status === "failed" && build.error && (
        <div className={styles.failure}>
          <h3>{copy.project.failureTitle}</h3>
          <pre>{build.error}</pre>
        </div>
      )}

      <h3 id="build-log">{copy.project.logTitle}</h3>
      <p className={stepStyles.muted}>{copy.project.logHint}</p>
      {/* aria-live off: the status line above announces progress; every line would be noise. */}
      <div
        role="log"
        aria-labelledby="build-log"
        aria-live="off"
        tabIndex={0}
        ref={log}
        className={styles.log}
      >
        {events.length === 0 ? (
          <p className={stepStyles.muted}>{copy.project.logEmpty}</p>
        ) : (
          <ol className={styles.events}>
            {events.map((event) => (
              <li key={event.id} className={styles.event} data-kind={event.kind}>
                <span className={styles.kind}>{copy.project.eventKind[event.kind]}</span>
                <time dateTime={event.at.toISOString()} className={styles.time}>
                  {event.at.toLocaleTimeString()}
                </time>
                <span className={styles.message}>{event.message}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}
