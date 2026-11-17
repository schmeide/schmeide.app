import { useQuery } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";

import { copy } from "../data/copy";
import {
  POLL_MS,
  useTRPC,
  useTRPCClient,
  type Build,
  type BuildEvent,
  type BuildSummary,
} from "../trpc";
import { formatDuration } from "../utils/usage";
import { useNow } from "./useNow";

import stepStyles from "./Step.module.css";
import styles from "./BuildStep.module.css";

const EVENTS_PAGE = 500;

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

// The last summary is written just after the build ends; the page keeps asking for it this long.
const FINAL_SUMMARY_WAIT_MS = 2 * 60_000;

// The plain-language account of the build, every POLL_MS until its last summary is in.
function useBuildSummaries(build: Build): readonly BuildSummary[] {
  const trpc = useTRPC();
  const { data } = useQuery({
    ...trpc.builds.summaries.queryOptions({ buildId: build.id }),
    refetchInterval: (query) =>
      !query.state.data?.some((summary) => summary.final) &&
      (build.finishedAt === null || Date.now() - build.finishedAt.getTime() < FINAL_SUMMARY_WAIT_MS)
        ? POLL_MS
        : false,
  });
  return data ?? [];
}

// What a build was asked for, in words: the person's own for a change, ours for the rest.
const REQUESTS: Readonly<Partial<Record<Build["kind"], string>>> = {
  site: copy.project.siteChangeRequest,
  promote: copy.project.release.promoteRequest,
  discard: copy.project.release.discardRequest,
};

type Props = {
  readonly build: Build;
  readonly title: string;
  // Who asked for it, for a build a person asked for by name (putting live, throwing away).
  readonly by?: string | null;
};

// `title` differs by place: a numbered setup step, or the latest change of a running app.
export function BuildStep({ build, title, by = null }: Props) {
  const events = useBuildEvents(build);
  const summaries = useBuildSummaries(build);
  const running = build.status === "running";
  const now = useNow(running);
  const log = useRef<HTMLDivElement>(null);
  const last = events.at(-1);
  const logId = useId();
  // Kept here, so it stays as the person left it while polling re-renders the step.
  const [showLog, setShowLog] = useState(false);

  // Keep the newest event in view inside the log, without scrolling the page.
  useEffect(() => {
    if (log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [events, showLog]);

  const end = build.finishedAt?.getTime() ?? now;
  return (
    <section aria-labelledby="build" className={stepStyles.step}>
      <h2 id="build">{title}</h2>
      {build.kind !== "initial" && (
        <p>
          <span className={stepStyles.muted}>{copy.project.changeRequestLabel}</span>{" "}
          {REQUESTS[build.kind] ?? build.request}
          {by && <span className={stepStyles.muted}> {copy.project.release.askedBy(by)}</span>}
        </p>
      )}
      <p className={styles.summary} data-status={build.status}>
        <strong>{copy.project.buildStatus[build.status]}</strong>
        {running && last && <span>{copy.project.phase[last.kind]}</span>}
        <span className={stepStyles.muted}>
          {copy.project.elapsed} {formatDuration(end - build.startedAt.getTime())}
        </span>
      </p>

      {build.status === "failed" && build.error && (
        <div className={styles.failure}>
          <h3>{copy.project.failureTitle}</h3>
          <pre>{build.error}</pre>
        </div>
      )}

      <h3 id="build-summary">{copy.project.summaryTitle}</h3>
      {summaries.length === 0 ? (
        <p className={stepStyles.muted}>
          {running ? copy.project.summaryWaiting : copy.project.summaryNone}
        </p>
      ) : (
        // Text only: what the summarizer wrote is never read as markup.
        <ol aria-labelledby="build-summary" aria-live="polite" className={styles.summaries}>
          {summaries.map((summary) => (
            <li key={summary.id} data-final={summary.final}>
              {summary.text}
            </li>
          ))}
        </ol>
      )}

      <button
        type="button"
        className={styles.toggle}
        aria-expanded={showLog}
        aria-controls={logId}
        onClick={() => setShowLog((open) => !open)}
      >
        {copy.project.behindTheScenes}
      </button>
      <div id={logId} hidden={!showLog} className={styles.logPanel}>
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
      </div>
    </section>
  );
}
