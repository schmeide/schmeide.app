import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createDb } from "../../db/client.ts";
import { agentRuns, builds, usage } from "../../db/schema.ts";
import { appendEvent, finishBuild, getBuild, listEvents, type RunUsage } from "../builds.ts";
import { createProject, getProject } from "../projects.ts";
import { createSummaries, listSummaries, RELEASE_SUMMARIES } from "../summaries.ts";
import type { Summarizer, SummaryInput } from "../summarizer.ts";
import { usageSummary } from "../usageSummary.ts";
import { DEMO_TENANT_ID } from "../../__tests__/testAuth.ts";

const db = createDb(process.env.DATABASE_URL ?? "");
afterAll(() => db.$client.end());

const aRunningBuild = async () => {
  const project = await createProject(db, { name: `s ${randomUUID()}`, tenantId: DEMO_TENANT_ID });
  const [build] = await db
    .insert(builds)
    .values({ projectId: project.id, kind: "initial", request: "spec", status: "running" })
    .returning();
  return build;
};

const usageOf = ({ projectId, buildId }: SummaryInput): RunUsage => ({
  run: { projectId, buildId, runKind: "summary", durationMs: 800 },
  models: [
    {
      projectId,
      buildId,
      runKind: "summary",
      model: "claude-haiku",
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0.25,
    },
  ],
});

// Answers each pass with how many events it was given, and whether the build had ended.
const counting = () =>
  vi.fn<Summarizer>(async (input) => ({
    text: input.outcome
      ? `Done: ${input.outcome.status}, after ${input.earlier.length} updates.`
      : `${input.events.length} new steps.`,
    usage: usageOf(input),
  }));

const quiet = { log: vi.fn(), intervalMs: 60_000 };

describe("build summaries", () => {
  it("are written in batches as events arrive and once at the end, stored in order", async () => {
    const build = await aRunningBuild();
    const summarize = counting();
    const summaries = createSummaries(db, summarize, { ...quiet, batch: 3 });
    const messages = Array.from({ length: 7 }, (_, index) => `step ${index + 1}`);

    for (const message of messages) {
      await appendEvent(db, build.id, "agent", message);
      summaries.noticed(build.id);
      // Events take a while to come in; a pass reads whatever is new when it runs.
      await summaries.settled();
    }
    await finishBuild(db, build.id);
    summaries.finished(build.id);
    await summaries.settled();

    expect((await listSummaries(db, build.id)).map(({ text, final }) => [text, final])).toEqual([
      ["3 new steps.", false],
      ["3 new steps.", false],
      ["Done: passed, after 2 updates.", true],
    ]);
    expect(
      summarize.mock.calls.map(([input]) => input.events.map((event) => event.message))
    ).toEqual([messages.slice(0, 3), messages.slice(3, 6), messages.slice(6)]);
    // The raw log is untouched and complete.
    expect((await listEvents(db, build.id, 0)).map((event) => event.message)).toEqual(messages);
  });

  it("are written after a quiet spell for the events that came in, and not without new ones", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const build = await aRunningBuild();
      const summarize = counting();
      const summaries = createSummaries(db, summarize, {
        log: vi.fn(),
        batch: 50,
        intervalMs: 20_000,
      });
      await appendEvent(db, build.id, "agent", "one");
      summaries.noticed(build.id);

      await vi.advanceTimersByTimeAsync(19_000);
      expect(summarize).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_000);
      await summaries.settled();
      expect((await listSummaries(db, build.id)).map(({ text }) => text)).toEqual(["1 new steps."]);

      summaries.noticed(build.id);
      await vi.advanceTimersByTimeAsync(20_000);
      await summaries.settled();
      // The second nudge came with no new event, so nothing was asked.
      expect(summarize).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("write the last one once, however often the end is reported", async () => {
    const build = await aRunningBuild();
    const summarize = counting();
    const summaries = createSummaries(db, summarize, quiet);
    await appendEvent(db, build.id, "error", "make test failed");
    await finishBuild(db, build.id, "make test failed");

    summaries.finished(build.id);
    summaries.finished(build.id);
    await summaries.settled();

    expect(await listSummaries(db, build.id)).toEqual([
      expect.objectContaining({ text: "Done: failed, after 0 updates.", final: true }),
    ]);
    expect(summarize.mock.calls[0][0].outcome).toEqual({
      status: "failed",
      error: "make test failed",
    });
  });

  it("are recorded as summary runs that do not count against the customer", async () => {
    const build = await aRunningBuild();
    const summaries = createSummaries(db, counting(), quiet);
    await appendEvent(db, build.id, "agent", "one");
    await finishBuild(db, build.id);
    summaries.finished(build.id);
    await summaries.settled();

    const rows = await db.select().from(usage).where(eq(usage.buildId, build.id));
    expect(rows.map(({ runKind }) => runKind)).toEqual(["summary"]);
    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.buildId, build.id));
    expect(run).toMatchObject({ runKind: "summary", durationMs: 800 });
    const project = await getProject(db, build.projectId);
    expect(project.usage.costUsd).toBe(0);
    expect(project.usage.inputTokens).toBe(0);
    expect(project.time.builderMs).toBe(0);
    // Schmeide's admin totals still show it, as its own kind of run.
    const admin = await usageSummary(db, {});
    expect(admin.runKinds.map(({ runKind }) => runKind)).toContain("summary");
  });

  it("of a promote or a discard ask no model and say only what was done, once it ends", async () => {
    const summarize = counting();
    const summaries = createSummaries(db, summarize, { ...quiet, batch: 1 });
    const cases = [
      ["promote", undefined, RELEASE_SUMMARIES.promote.passed],
      ["promote", "make up failed", RELEASE_SUMMARIES.promote.failed],
      ["discard", undefined, RELEASE_SUMMARIES.discard.passed],
      ["discard", "make up failed", RELEASE_SUMMARIES.discard.failed],
    ] as const;
    for (const [kind, error, text] of cases) {
      const { projectId } = await aRunningBuild();
      const [build] = await db
        .insert(builds)
        .values({ projectId, kind, request: kind, status: "running" })
        .returning();
      await appendEvent(db, build.id, "deploy", "Starting your live app (make up)");
      summaries.noticed(build.id);
      await summaries.settled();
      expect(await listSummaries(db, build.id)).toEqual([]);

      await finishBuild(db, build.id, error);
      summaries.finished(build.id);
      await summaries.settled();

      expect((await listSummaries(db, build.id)).map(({ text, final }) => [text, final])).toEqual([
        [text, true],
      ]);
      expect(await db.select().from(usage).where(eq(usage.buildId, build.id))).toEqual([]);
    }
    expect(summarize).not.toHaveBeenCalled();
  });

  it("leave the build alone when the summarizer throws or takes too long, and say so in the log", async () => {
    const build = await aRunningBuild();
    const log = vi.fn();
    const throwing = createSummaries(
      db,
      vi.fn<Summarizer>(async () => {
        throw new Error("model unavailable");
      }),
      { log, batch: 1, intervalMs: 60_000 }
    );
    const hanging = createSummaries(
      db,
      vi.fn<Summarizer>(() => new Promise(() => undefined)),
      { log, batch: 1, intervalMs: 60_000, timeoutMs: 50 }
    );
    await appendEvent(db, build.id, "agent", "one");

    throwing.noticed(build.id);
    hanging.noticed(build.id);
    await finishBuild(db, build.id);
    throwing.finished(build.id);
    hanging.finished(build.id);
    await Promise.all([throwing.settled(), hanging.settled()]);

    expect(await getBuild(db, build.id)).toMatchObject({ status: "passed", error: null });
    expect(await listSummaries(db, build.id)).toEqual([]);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining(`build ${build.id}`),
      expect.anything()
    );
    expect(log.mock.calls.map(([, error]) => String(error))).toEqual(
      expect.arrayContaining([
        expect.stringContaining("model unavailable"),
        expect.stringContaining("timed out"),
      ])
    );
  });
});
