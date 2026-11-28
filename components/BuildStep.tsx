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
import { ageOf } from "../utils/reviewAge";
import { formatDuration } from "../utils/usage";
import { useNow } from "./useNow";

import stepStyles from "./Step.module.css";
import styles from "./BuildStep.module.css";

const EVENTS_PAGE = 500;
// How far from the bottom the log still counts as scrolled to the bottom (fractional scroll offsets).
const BOTTOM_SLACK_PX = 4;

// Pages the build's events forward with afterId, every POLL_MS while the build runs and once more
// when it ends. Mount it with key={build.id} so a new build starts a fresh log.
export function useBuildEvents(build: Pick<Build, "id" | "status">): readonly BuildEvent[] {
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
export function useBuildSummaries(build: Build): readonly BuildSummary[] {
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
export const requestText = (build: Pick<Build, "kind" | "request">): string =>
  REQUESTS[build.kind] ?? build.request;

// The four phases of a first build, in order, and the phase each kind of event belongs to. A
// problem belongs to none: the build is still in the phase it happened in.
const PHASES = ["step", "agent", "check", "deploy"] as const;
const PHASE_OF: Readonly<Record<BuildEvent["kind"], number | null>> = {
  step: 0,
  agent: 1,
  skill: 1,
  check: 2,
  warning: 2,
  deploy: 3,
  error: null,
};

const ago = new Intl.RelativeTimeFormat("en", { numeric: "always" });

type Props = {
  readonly build: Build;
  readonly title: string;
  // Who asked for it, for a build a person asked for by name (putting live, throwing away).
  readonly by?: string | null;
  // The live app, offered as the one way on once a first build finished.
  readonly appUrl?: string | null;
};

// `title` differs by place: a numbered setup step, or the latest change of a running app.
export function BuildStep({ build, title, by = null, appUrl = null }: Props) {
  const events = useBuildEvents(build);
  const summaries = useBuildSummaries(build);
  const running = build.status === "running";
  const now = useNow(running);
  const log = useRef<HTMLDivElement>(null);
  const last = events.at(-1);
  const logId = useId();
  // Kept here, so it stays as the person left it while polling re-renders the step.
  const [showLog, setShowLog] = useState(false);

  // How many lines the log held when the reader scrolled up from the bottom; null while following.
  const [pinnedAt, setPinnedAt] = useState<number | null>(null);
  const behind = pinnedAt !== null && events.length > pinnedAt;

  const scrollToNewest = () => {
    if (log.current) log.current.scrollTop = log.current.scrollHeight;
  };

  const onScroll = () => {
    const el = log.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_SLACK_PX;
    setPinnedAt((pinned) => (atBottom ? null : (pinned ?? events.length)));
  };

  // Follow the newest event inside the log, without scrolling the page, only while at the bottom.
  useEffect(() => {
    if (pinnedAt === null) scrollToNewest();
  }, [events, showLog, pinnedAt]);

  const end = build.finishedAt?.getTime() ?? now;
  // A first build shows its phases while it runs; before its first step it is getting ready.
  const first = build.kind === "initial";
  const phase = events.reduce((at, event) => PHASE_OF[event.kind] ?? at, 0);
  const age = ageOf(build.startedAt, new Date(now));
  return (
    <section aria-labelledby="build" className={stepStyles.step}>
      <h2 id="build">{title}</h2>
      {build.kind !== "initial" && (
        <p>
          <span className={stepStyles.muted}>{copy.project.changeRequestLabel}</span>{" "}
          {requestText(build)}
          {by && <span className={stepStyles.muted}> {copy.project.release.askedBy(by)}</span>}
        </p>
      )}
      <p className={styles.summary} data-status={build.status}>
        <strong>{copy.project.buildStatus[build.status]}</strong>
        {/* For a first build, the phase list below says this, except for a problem. */}
        {running && last && (!first || last.kind === "error") && (
          <span>{copy.project.phase[last.kind]}</span>
        )}
        <span className={stepStyles.muted}>
          {first && running
            ? copy.project.firstBuildTime(
                age.amount === 0 ? null : ago.format(-age.amount, age.unit)
              )
            : `${copy.project.elapsed} ${formatDuration(end - build.startedAt.getTime())}`}
        </span>
      </p>

      {first && running && (
        <>
          <ol aria-label={copy.project.phasesLabel} className={styles.phases}>
            {PHASES.map((kind, index) => (
              <li
                key={kind}
                aria-current={index === phase ? "step" : undefined}
                data-state={index < phase ? "done" : index === phase ? "current" : "todo"}
              >
                {copy.project.phase[kind]}
                {index < phase && <span className={styles.hidden}> {copy.project.setup.done}</span>}
              </li>
            ))}
          </ol>
          <p className={stepStyles.muted}>{copy.project.canLeave}</p>
        </>
      )}

      {first && build.status === "passed" && appUrl && (
        <p>
          <a href={appUrl} target="_blank" rel="noreferrer" className={styles.openApp}>
            {copy.project.openApp} {copy.project.opensInNewTab}
          </a>
        </p>
      )}

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
          onScroll={onScroll}
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
          {behind && (
            <button
              type="button"
              className={styles.jump}
              onClick={() => {
                setPinnedAt(null);
                scrollToNewest();
              }}
            >
              {copy.project.jumpToNewest}
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
