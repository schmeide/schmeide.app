import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { createDb } from "../db/client.ts";

const server = new URL("../..", import.meta.url).pathname;
const files = readdirSync(new URL("../../drizzle", import.meta.url)).filter((name) =>
  name.endsWith(".sql")
);

// A database of its own on the test server, so the run starts from nothing.
const name = `migrate_${randomUUID().replaceAll("-", "")}`;
const admin = createDb(process.env.DATABASE_URL ?? "");
const emptyUrl = Object.assign(new URL(process.env.DATABASE_URL ?? ""), { pathname: `/${name}` });
const empty = createDb(emptyUrl.href);
afterAll(async () => {
  await empty.$client.end();
  await admin.execute(sql.raw(`DROP DATABASE IF EXISTS "${name}"`));
  await admin.$client.end();
});

// `node src/migrate.ts` as the production image's PreSync Job runs it: no devDependencies.
const migrate = (url: string) =>
  spawnSync(process.execPath, ["src/migrate.ts"], {
    cwd: server,
    encoding: "utf8",
    env: { PATH: process.env.PATH, DATABASE_URL: url },
  });

describe("node src/migrate.ts", () => {
  it("applies every file in server/drizzle to an empty database, and leaves no demo tenant", async () => {
    await admin.execute(sql.raw(`CREATE DATABASE "${name}"`));
    const first = migrate(emptyUrl.href);
    expect(first.stderr).toBe("");
    expect(first.status).toBe(0);

    const applied = await empty.execute(sql`SELECT hash FROM drizzle.__drizzle_migrations`);
    expect(applied.rows).toHaveLength(files.length);
    const demo = await empty.execute(sql`SELECT id FROM tenants WHERE slug = 'demo'`);
    expect(demo.rows).toEqual([]);

    expect(migrate(emptyUrl.href).status).toBe(0);
    expect((await empty.execute(sql`SELECT hash FROM drizzle.__drizzle_migrations`)).rows).toEqual(
      applied.rows
    );
  });

  it("exits non-zero and says why when it cannot migrate, so the deploy stops", () => {
    const missing = Object.assign(new URL(emptyUrl.href), { pathname: `/${name}_missing` });
    const result = migrate(missing.href);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Error:");
    expect(result.stderr).toContain("does not exist");
  });
});
