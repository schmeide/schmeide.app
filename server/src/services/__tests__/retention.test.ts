import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { desc, eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { createDb } from "../../db/client.ts";
import { adminActions, sessions, users, websiteReads } from "../../db/schema.ts";
import { DEMO_TENANT_ID } from "../../__tests__/testAuth.ts";
import {
  approveSpec,
  createProject,
  setFeatures,
  transcriptsDir,
  transition,
  type Deps,
} from "../projects.ts";
import { copyOf } from "../resources.ts";
import { RETENTION, RETENTION_LABEL, sweepExpired } from "../retention.ts";

// Tests share one database, so rows are dated just around their period and asserted by id.
const db = createDb(process.env.DATABASE_URL ?? "");
afterAll(() => db.$client.end());

const DAY = 86_400_000;

const fakeDeps: Deps = {
  db,
  workflows: { start: async () => ({}) as never, getHandle: () => ({}) as never },
  taskQueue: "test",
};
const specReady = async () => {
  const project = await createProject(db, { name: `p ${randomUUID()}`, tenantId: DEMO_TENANT_ID });
  await setFeatures(db, { id: project.id, features: "a list of to-dos" });
  return transition(db, project.id, ["draft"], { status: "spec_ready", spec: "## Features" });
};
const daysOf = (kind: (typeof RETENTION)[number]["kind"]) =>
  RETENTION.find((entry) => entry.kind === kind)?.days ?? 0;

describe("RETENTION", () => {
  it("gives every kind of record one period", () => {
    const kinds = RETENTION.map((entry) => entry.kind);
    expect(new Set(kinds).size).toBe(kinds.length);
    expect(kinds).toEqual(
      expect.arrayContaining([
        "build_logs",
        "agent_sessions",
        "website_reads",
        "sign_ins",
        "usage",
        "audit_log",
      ])
    );
    for (const entry of RETENTION) expect(entry.days).toBeGreaterThan(0);
  });
});

describe("sweepExpired", () => {
  it("removes a record one day past its period and keeps one a day short", async () => {
    const now = new Date();
    const past = (kind: Parameters<typeof daysOf>[0]) =>
      new Date(now.getTime() - (daysOf(kind) + 1) * DAY);
    const short = (kind: Parameters<typeof daysOf>[0]) =>
      new Date(now.getTime() - (daysOf(kind) - 1) * DAY);

    const dataDir = await mkdtemp(join(tmpdir(), "schmeide-retention-"));
    const claude = join(dataDir, "claude");
    const file = async (path: string, at: Date) => {
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, "text");
      await utimes(path, at, at);
    };
    const { build: old } = await approveSpec(fakeDeps, (await specReady()).id);
    const { build: young, project } = await approveSpec(fakeDeps, (await specReady()).id);
    await file(join(dataDir, "logs", `build-${old.id}.log`), past("build_logs"));
    await file(join(dataDir, "logs", `build-${young.id}.log`), short("build_logs"));
    await file(join(dataDir, "attachments", `build-${old.id}`, "1.pdf"), past("build_logs"));
    const oldDir = join(dataDir, "attachments", `build-${old.id}`);
    await utimes(oldDir, past("build_logs"), past("build_logs"));
    await file(join(dataDir, "attachments", `build-${young.id}`, "1.pdf"), short("build_logs"));
    const transcripts = transcriptsDir(claude, copyOf(dataDir, project.slug, "staging").dir);
    await file(join(transcripts, "old.jsonl"), past("agent_sessions"));
    await file(join(transcripts, "new.jsonl"), short("agent_sessions"));

    const [user] = await db
      .insert(users)
      .values({ id: randomUUID(), name: "R", email: `${randomUUID()}@example.com` })
      .returning();
    const reads = await db
      .insert(websiteReads)
      .values([
        { userId: user.id, tenantId: DEMO_TENANT_ID, at: past("website_reads") },
        { userId: user.id, tenantId: DEMO_TENANT_ID, at: short("website_reads") },
      ])
      .returning();
    const signIns = await db
      .insert(sessions)
      .values(
        [past("sign_ins"), short("sign_ins")].map((expiresAt) => ({
          id: randomUUID(),
          token: randomUUID(),
          userId: user.id,
          expiresAt,
        }))
      )
      .returning();

    const removed = await sweepExpired(db, dataDir, now, claude);

    expect(await readdir(join(dataDir, "logs"))).toEqual([`build-${young.id}.log`]);
    expect(await readdir(join(dataDir, "attachments"))).toEqual([`build-${young.id}`]);
    expect(await readdir(transcripts)).toEqual(["new.jsonl"]);
    expect(
      (
        await db
          .select({ id: websiteReads.id })
          .from(websiteReads)
          .where(
            inArray(
              websiteReads.id,
              reads.map((row) => row.id)
            )
          )
      ).map((row) => row.id)
    ).toEqual([reads[1].id]);
    expect(
      (
        await db
          .select({ id: sessions.id })
          .from(sessions)
          .where(
            inArray(
              sessions.id,
              signIns.map((row) => row.id)
            )
          )
      ).map((row) => row.id)
    ).toEqual([signIns[1].id]);
    expect(removed.build_logs).toBeGreaterThanOrEqual(2);
    expect(removed.agent_sessions).toBeGreaterThanOrEqual(1);
    expect(removed.website_reads).toBeGreaterThanOrEqual(1);
    expect(removed.sign_ins).toBeGreaterThanOrEqual(1);

    const [recorded] = await db
      .select()
      .from(adminActions)
      .where(eq(adminActions.adminLabel, RETENTION_LABEL))
      .orderBy(desc(adminActions.id))
      .limit(1);
    expect(recorded.action).toBe("retention sweep");
    expect(JSON.parse(recorded.detail)).toMatchObject({ build_logs: removed.build_logs });
  });

  it("removes what a deleted project left on disk, however new, and keeps a live one's", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "schmeide-retention-"));
    const claude = join(dataDir, "claude");
    const live = await createProject(db, { name: `p ${randomUUID()}`, tenantId: DEMO_TENANT_ID });
    const { build } = await approveSpec(fakeDeps, (await specReady()).id);
    const transcriptsOf = (slug: string) =>
      transcriptsDir(claude, copyOf(dataDir, slug, "staging").dir);
    const write = async (path: string) => {
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, "text");
    };
    // No build has this id: the serial ids only grow.
    const deletedBuild = 2_000_000_000;
    await write(join(dataDir, "logs", `build-${deletedBuild}.log`));
    await write(join(dataDir, "attachments", `build-${deletedBuild}`, "1.pdf"));
    await write(join(dataDir, "logs", `build-${build.id}.log`));
    await write(join(transcriptsOf(`gone-${randomUUID()}`), "s.jsonl"));
    await write(join(transcriptsOf(live.slug), "s.jsonl"));
    // Someone else's Claude Code project beside them is not the builder's.
    await write(join(claude, "projects", "-Users-someone-code", "s.jsonl"));

    await sweepExpired(db, dataDir, new Date(), claude);

    expect(await readdir(join(dataDir, "logs"))).toEqual([`build-${build.id}.log`]);
    expect(await readdir(join(dataDir, "attachments"))).toEqual([]);
    expect((await readdir(join(claude, "projects"))).sort()).toEqual(
      [transcriptsOf(live.slug).split("/").at(-1), "-Users-someone-code"].sort()
    );
  });

  it("does nothing to a data dir the builder never wrote to", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "schmeide-retention-"));
    const removed = await sweepExpired(db, dataDir, new Date(), join(dataDir, "claude"));
    expect(removed.build_logs).toBe(0);
    expect(removed.agent_sessions).toBe(0);
  });
});
