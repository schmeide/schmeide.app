import { randomUUID } from "node:crypto";
import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { createDb } from "../../db/client.ts";
import { agentRuns, builds, usage } from "../../db/schema.ts";
import { appendEvent, finishBuild, listEvents, recordUsage, runUsage } from "../builds.ts";
import { createProject } from "../projects.ts";
import { DEMO_TENANT_ID } from "../../__tests__/testAuth.ts";

const db = createDb(process.env.DATABASE_URL ?? "");
afterAll(() => db.$client.end());

// Status "passed" so this build never counts as the one running build.
const newBuild = async () => {
  const project = await createProject(db, { name: `b ${randomUUID()}`, tenantId: DEMO_TENANT_ID });
  const [build] = await db
    .insert(builds)
    .values({ projectId: project.id, kind: "initial", request: "spec", status: "passed" })
    .returning();
  return build;
};

describe("build events", () => {
  it("pages forward from the last id seen", async () => {
    const build = await newBuild();
    const first = await appendEvent(db, build.id, "step", "one");
    await appendEvent(db, build.id, "agent", "two");
    await appendEvent(db, build.id, "check", "three");

    const all = await listEvents(db, build.id, 0);
    const rest = await listEvents(db, build.id, first.id);

    expect(all.map((event) => event.message)).toEqual(["one", "two", "three"]);
    expect(rest.map((event) => event.message)).toEqual(["two", "three"]);
    expect(await listEvents(db, build.id, all[2].id)).toEqual([]);
  });

  it("finishes a build as failed with its error", async () => {
    const build = await newBuild();

    const finished = await finishBuild(db, build.id, "make test failed");

    expect(finished).toMatchObject({ status: "failed", error: "make test failed" });
    expect(finished.finishedAt).toBeInstanceOf(Date);
  });
});

const USED = {
  inputTokens: 1,
  outputTokens: 2,
  cacheReadInputTokens: 3,
  cacheCreationInputTokens: 4,
  costUSD: 0.5,
} as const;

describe("agent run usage", () => {
  it("keeps the run's time once, and one usage row per model that names the run", async () => {
    const build = await newBuild();
    const result = {
      type: "result",
      subtype: "success",
      duration_ms: 65_400,
      modelUsage: { "claude-a": USED, "claude-b": USED },
    } as unknown as SDKResultMessage;

    await recordUsage(db, runUsage(result, build.projectId, build.id, "initial"));

    const runs = await db.select().from(agentRuns).where(eq(agentRuns.buildId, build.id));
    expect(runs).toEqual([
      expect.objectContaining({
        projectId: build.projectId,
        runKind: "initial",
        durationMs: 65_400,
      }),
    ]);
    const rows = await db.select().from(usage).where(eq(usage.buildId, build.id));
    expect(rows.map(({ model, runId }) => [model, runId])).toEqual([
      ["claude-a", runs[0].id],
      ["claude-b", runs[0].id],
    ]);
  });
});
