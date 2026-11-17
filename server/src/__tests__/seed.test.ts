import { spawnSync } from "node:child_process";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.ts";
import { createDb } from "../db/client.ts";
import {
  accounts,
  adminActions,
  approvedEmails,
  memberships,
  sessions,
  users,
} from "../db/schema.ts";
import type { AppContext } from "../router.ts";
import { findTenantBySlug } from "../services/businesses.ts";
import { DEV_LOGINS, DEV_PASSWORD } from "../services/seed.ts";
import { callApi, signIn, testAuth } from "./testAuth.ts";

const db = createDb(process.env.DATABASE_URL ?? "");
afterAll(() => db.$client.end());

const deps: AppContext = {
  db,
  workflows: { start: vi.fn(), getHandle: vi.fn() as never },
  taskQueue: "test",
  interviewer: vi.fn(),
  siteFetcher: vi.fn(),
  websiteReader: vi.fn(),
  files: {} as never,
  reader: vi.fn(),
  auth: testAuth(db),
  providers: [],
};
const app = buildApp(deps);
afterAll(() => app.close());

const emails = [DEV_LOGINS.admin.email, DEV_LOGINS.owner.email];
const server = new URL("../..", import.meta.url).pathname;

// `make db/seed` as the Makefile runs it, against the test database.
const seed = (publicUrl: string) =>
  spawnSync(process.execPath, ["src/cli/access.ts", "seed"], {
    cwd: server,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      DATABASE_URL: process.env.DATABASE_URL,
      SCHMEIDE_PUBLIC_URL: publicUrl,
      SCHMEIDE_AUTH_SECRET: "a-deployed-secret-a-deployed-secret-0123",
    },
  });

// Everything the seed could have written about its two addresses.
const seeded = async () => {
  const people = await db
    .select({ id: users.id, email: users.email, role: users.role, hash: accounts.password })
    .from(users)
    .leftJoin(accounts, eq(accounts.userId, users.id))
    .where(inArray(users.email, emails));
  const ids = people.map(({ id }) => id);
  return {
    people,
    approved: await db.select().from(approvedEmails).where(inArray(approvedEmails.email, emails)),
    memberships: ids.length
      ? await db.select().from(memberships).where(inArray(memberships.userId, ids))
      : [],
    grants: ids.length
      ? await db
          .select()
          .from(adminActions)
          .where(
            and(eq(adminActions.action, "admin.grant"), inArray(adminActions.targetUserId, ids))
          )
      : [],
  };
};

describe("make db/seed", () => {
  it("refuses when the public address is not localhost, says what to run instead, and writes nothing", async () => {
    const result = seed("https://schmeide.app");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("only runs when SCHMEIDE_PUBLIC_URL is localhost");
    expect(result.stderr).toContain("https://schmeide.app");
    expect(result.stderr).toContain("make access/approve");
    expect(result.stderr).toContain("make access/admin");
    expect(await seeded()).toEqual({ people: [], approved: [], memberships: [], grants: [] });
  });

  it("leaves one admin and one demo owner, and changes nothing when run again", async () => {
    const first = seed("http://localhost:5173");
    expect(first.stderr).toBe("");
    expect(first.status).toBe(0);
    for (const email of emails) expect(first.stdout).toContain(email);
    expect(first.stdout).toContain(DEV_PASSWORD);
    expect(first.stdout).toContain("http://localhost:5173/sign-in");

    const before = await seeded();
    expect(before.people).toHaveLength(2);
    expect(before.approved).toHaveLength(2);
    expect(before.memberships).toEqual([
      expect.objectContaining({ tenantId: await findTenantBySlug(db, "demo"), role: "owner" }),
    ]);
    expect(before.grants).toHaveLength(1);
    const { cookie } = await signIn(app, DEV_LOGINS.owner.email, DEV_PASSWORD);
    const sessionsBefore = await db.select().from(sessions);

    expect(seed("http://localhost:5173").status).toBe(0);
    expect(await seeded()).toEqual(before);
    expect(await db.select().from(sessions)).toEqual(sessionsBefore);
    expect((await callApi(app, "session.get", undefined, cookie)).data.person.email).toBe(
      DEV_LOGINS.owner.email
    );
  });

  it("gives logins that sign in with the documented password: only the admin has the role", async () => {
    const admin = await signIn(app, DEV_LOGINS.admin.email, DEV_PASSWORD);
    const owner = await signIn(app, DEV_LOGINS.owner.email, DEV_PASSWORD);
    expect([admin.status, owner.status]).toEqual([200, 200]);

    const asAdmin = (await callApi(app, "session.get", undefined, admin.cookie)).data;
    expect(asAdmin.person).toMatchObject({ email: DEV_LOGINS.admin.email, role: "admin" });
    expect(asAdmin.businesses).toEqual([]);

    const asOwner = (await callApi(app, "session.get", undefined, owner.cookie)).data;
    expect(asOwner.person).toEqual({ name: DEV_LOGINS.owner.name, email: DEV_LOGINS.owner.email });
    expect(asOwner.businesses).toEqual([
      expect.objectContaining({ id: await findTenantBySlug(db, "demo") }),
    ]);
  });
});
