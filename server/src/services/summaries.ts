// The running summary of a build: when it is written, and where it is kept. It runs beside the
// build in the worker that runs the build, and the build never waits for it: the activities only
// tell it that an event was added (`noticed`) or that the build ended (`finished`), which return at
// once. Each pass is caught, so a summarizer that fails or hangs is logged and nothing else
// happens; the build's events and result are never touched here.
import { and, asc, desc, eq, gt } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { buildEvents, buildSummaries, type BuildSummary } from "../db/schema.ts";
import { getBuild, recordUsage } from "./builds.ts";
import { plainText, type Summarizer } from "./summarizer.ts";

// The newest events one pass reads at most, so a long quiet spell cannot make a huge prompt.
const MAX_EVENTS = 100;

// A promote or a discard (services/projects.ts) only moves one copy of the app to a commit.
export const RELEASE_SUMMARIES = {
  promote: {
    passed: "Your customers now see the version being worked on.",
    failed: "Putting the version being worked on live did not finish.",
  },
  discard: {
    passed:
      "The changes your customers did not see yet were thrown away. The version being worked on is back to what your customers see, with an empty database of its own.",
    failed: "Throwing away the changes your customers do not see yet did not finish.",
  },
} as const;

export type Summaries = {
  // An event was added to the build.
  readonly noticed: (buildId: number) => void;
  // The build has ended and its result is stored: write the last summary.
  readonly finished: (buildId: number) => void;
  // Resolves once every pass started so far is done. For tests and shutdown.
  readonly settled: () => Promise<void>;
};

export type SummariesOptions = {
  // A pass runs once this many events came in since the last one...
  readonly batch?: number;
  // ...or this long after the first of them, whichever comes first.
  readonly intervalMs?: number;
  // A pass that takes longer is given up.
  readonly timeoutMs?: number;
  readonly log?: (message: string, error: unknown) => void;
};

export const listSummaries = (db: Db, buildId: number): Promise<readonly BuildSummary[]> =>
  db
    .select()
    .from(buildSummaries)
    .where(eq(buildSummaries.buildId, buildId))
    .orderBy(asc(buildSummaries.id));

const timedOut = (signal: AbortSignal): Promise<never> =>
  new Promise((_, reject) =>
    signal.addEventListener("abort", () => reject(new Error("The summary timed out")), {
      once: true,
    })
  );

export const createSummaries = (
  db: Db,
  summarize: Summarizer,
  {
    batch = 20,
    intervalMs = 20_000,
    timeoutMs = 60_000,
    log = (message, error) => console.error(message, error),
  }: SummariesOptions = {}
): Summaries => {
  type State = { unsummarized: number; timer?: NodeJS.Timeout; passes: Promise<void> };
  // Per build while it runs, in memory only: what is stored says where the next pass starts.
  const states = new Map<number, State>();
  const stateOf = (buildId: number): State => {
    const found = states.get(buildId);
    if (found) return found;
    const created: State = { unsummarized: 0, passes: Promise.resolve() };
    states.set(buildId, created);
    return created;
  };

  // Reads the events since the last summary and writes the next one.
  const pass = async (buildId: number, final: boolean): Promise<void> => {
    const earlier = await listSummaries(db, buildId);
    if (earlier.some((summary) => summary.final)) return;
    const after = earlier.at(-1)?.throughEventId ?? 0;
    const events = (
      await db
        .select()
        .from(buildEvents)
        .where(and(eq(buildEvents.buildId, buildId), gt(buildEvents.id, after)))
        .orderBy(desc(buildEvents.id))
        .limit(MAX_EVENTS)
    ).reverse();
    if (!final && events.length === 0) return;
    const build = await getBuild(db, buildId);
    if (build.kind === "promote" || build.kind === "discard") {
      // No builder ran, so there is nothing for the model to tell: one fixed account, at the end.
      if (final)
        await db.insert(buildSummaries).values({
          buildId,
          throughEventId: events.at(-1)?.id ?? after,
          final,
          text: RELEASE_SUMMARIES[build.kind][build.status === "passed" ? "passed" : "failed"],
        });
      return;
    }
    const signal = AbortSignal.timeout(timeoutMs);
    const { text, usage } = await Promise.race([
      summarize({
        projectId: build.projectId,
        buildId,
        earlier: earlier.map((summary) => summary.text),
        events,
        outcome: final ? { status: build.status, error: build.error } : null,
        signal,
      }),
      timedOut(signal),
    ]);
    await recordUsage(db, usage);
    const plain = plainText(text);
    if (!plain) return;
    await db.insert(buildSummaries).values({
      buildId,
      throughEventId: events.at(-1)?.id ?? after,
      final,
      text: plain,
    });
  };

  const run = (buildId: number, final: boolean) => {
    const state = stateOf(buildId);
    clearTimeout(state.timer);
    state.timer = undefined;
    state.unsummarized = 0;
    const passes = state.passes
      .then(() => pass(buildId, final))
      .catch((error: unknown) => log(`The summary of build ${buildId} was not written:`, error));
    state.passes = passes;
    if (final)
      void passes.then(() => {
        if (states.get(buildId)?.passes === passes) states.delete(buildId);
      });
  };

  return {
    noticed: (buildId) => {
      const state = stateOf(buildId);
      state.unsummarized += 1;
      if (state.unsummarized >= batch) run(buildId, false);
      else if (!state.timer) {
        state.timer = setTimeout(() => run(buildId, false), intervalMs);
        // A pending summary never keeps the process alive.
        state.timer.unref();
      }
    },
    finished: (buildId) => run(buildId, true),
    settled: async () => {
      await Promise.all([...states.values()].map((state) => state.passes));
    },
  };
};
