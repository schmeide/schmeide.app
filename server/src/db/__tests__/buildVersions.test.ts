import { randomUUID } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, describe, expect, it } from "vitest";
import { createDb } from "../client.ts";
import { builds, projects, tenants } from "../schema.ts";

const drizzle = fileURLToPath(new URL("../../../drizzle", import.meta.url));
const name = `versions_${randomUUID().replaceAll("-", "")}`;
const admin = createDb(process.env.DATABASE_URL ?? "");
const emptyUrl = Object.assign(new URL(process.env.DATABASE_URL ?? ""), { pathname: `/${name}` });
const empty = createDb(emptyUrl.href);
let prior: string | undefined;

afterAll(async () => {
  await empty.$client.end();
  await admin.execute(sql.raw(`DROP DATABASE IF EXISTS "${name}"`));
  await admin.$client.end();
  if (prior) rmSync(prior, { recursive: true, force: true });
});

const sha = (n: number) => n.toString(16).padStart(40, "0");

// Migrations through 0031, so 0032's backfill runs against rows that predate the columns.
const migrationsBeforeVersions = () => {
  prior = mkdtempSync(join(tmpdir(), "schmeide-versions-"));
  cpSync(drizzle, prior, { recursive: true });
  rmSync(join(prior, "0032_build_versions.sql"));
  rmSync(join(prior, "meta", "0032_snapshot.json"));
  const journal = JSON.parse(readFileSync(join(prior, "meta", "_journal.json"), "utf8")) as {
    entries: { tag: string }[];
  };
  journal.entries = journal.entries.filter((entry) => entry.tag !== "0032_build_versions");
  writeFileSync(join(prior, "meta", "_journal.json"), JSON.stringify(journal));
  return prior;
};

describe("build version backfill", () => {
  it("numbers passed builds that have their own commit, skipping failed, queued, and copies", async () => {
    await admin.execute(sql.raw(`CREATE DATABASE "${name}"`));
    await migrate(empty, { migrationsFolder: migrationsBeforeVersions() });
    const [tenant] = await empty.insert(tenants).values({ slug: "acme", name: "Acme" }).returning();
    const [project] = await empty
      .insert(projects)
      .values({ tenantId: tenant.id, slug: "notes", name: "Notes", webPort: 8100 })
      .returning();
    const [other] = await empty
      .insert(projects)
      .values({ tenantId: tenant.id, slug: "tasks", name: "Tasks", webPort: 8101 })
      .returning();
    // Raw SQL: these rows predate the version columns, which 0032 adds.
    const insertBuild = (projectId: number, kind: string, status: string, commit: string | null) =>
      empty.execute(
        sql`insert into builds (project_id, kind, request, status, commit) values (${projectId}, ${kind}, 'x', ${status}, ${commit})`
      );
    await insertBuild(project.id, "initial", "passed", sha(1));
    await insertBuild(project.id, "change", "failed", sha(2));
    await insertBuild(project.id, "change", "queued", sha(3));
    await insertBuild(project.id, "change", "passed", sha(4));
    await insertBuild(project.id, "promote", "passed", sha(4));
    await insertBuild(project.id, "site", "passed", null);
    await insertBuild(project.id, "discard", "passed", sha(1));
    await insertBuild(project.id, "site", "passed", sha(5));
    await insertBuild(other.id, "change", "passed", sha(6));
    await insertBuild(other.id, "initial", "passed", sha(7));

    await migrate(empty, { migrationsFolder: drizzle });

    const numbered = async (projectId: number) =>
      empty
        .select({
          kind: builds.kind,
          status: builds.status,
          commit: builds.commit,
          version: builds.version,
          baseCommit: builds.baseCommit,
        })
        .from(builds)
        .where(eq(builds.projectId, projectId))
        .orderBy(builds.id);
    expect(await numbered(project.id)).toEqual([
      { kind: "initial", status: "passed", commit: sha(1), version: 1, baseCommit: null },
      { kind: "change", status: "failed", commit: sha(2), version: null, baseCommit: null },
      { kind: "change", status: "queued", commit: sha(3), version: null, baseCommit: null },
      { kind: "change", status: "passed", commit: sha(4), version: 2, baseCommit: sha(1) },
      { kind: "promote", status: "passed", commit: sha(4), version: null, baseCommit: null },
      { kind: "site", status: "passed", commit: null, version: null, baseCommit: null },
      { kind: "discard", status: "passed", commit: sha(1), version: null, baseCommit: null },
      { kind: "site", status: "passed", commit: sha(5), version: 3, baseCommit: sha(4) },
    ]);
    expect(await numbered(other.id)).toEqual([
      { kind: "change", status: "passed", commit: sha(6), version: 1, baseCommit: null },
      { kind: "initial", status: "passed", commit: sha(7), version: 2, baseCommit: sha(6) },
    ]);
  });
});
