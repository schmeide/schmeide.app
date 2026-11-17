import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.ts";
import { createDb } from "../db/client.ts";
import { ADMIN_ROLE, accounts, sessions, users } from "../db/schema.ts";
import type { AppContext } from "../router.ts";
import { approveEmail, removeApproval } from "../services/access.ts";
import { createProject } from "../services/projects.ts";
import { aSignedInAdmin, aSignedInPerson, adminPaths, callApi, testAuth } from "./testAuth.ts";

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

type BusinessRow = {
  readonly id: number;
  readonly name: string;
  readonly slug: string;
  readonly members: number;
  readonly projects: number;
  readonly createdAt: string;
};
type Page<T> = { readonly entries: readonly T[]; readonly nextCursor: number | null };
type PersonRow = {
  readonly name: string;
  readonly email: string;
  readonly approved: boolean;
  readonly admin: boolean;
  readonly businesses: readonly { readonly id: number; readonly name: string }[];
};

// What could let someone sign in as the person, none of which an admin list may carry.
const secretsOf = async (email: string, token: string) => {
  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
  const [account] = await db
    .select({ password: accounts.password })
    .from(accounts)
    .where(eq(accounts.userId, user.id));
  const tokens = await db
    .select({ token: sessions.token })
    .from(sessions)
    .where(eq(sessions.userId, user.id));
  return [account.password ?? "", token, ...tokens.map((row) => row.token)].filter(Boolean);
};
const expectNoSecrets = (data: unknown, secrets: readonly string[]) => {
  const json = JSON.stringify(data);
  for (const secret of secrets) expect(json).not.toContain(secret);
  expect(json).not.toMatch(/password|token|hash/i);
};

describe("the admin directory procedures", () => {
  it("are on the admin base, which admin.test.ts walks as an owner and as nobody", () => {
    expect(adminPaths).toEqual(
      expect.arrayContaining(["admin.businesses.list", "admin.businesses.get", "admin.people.list"])
    );
  });
});

describe("listing businesses", () => {
  it("includes one the admin does not belong to, with its counts, newest first", async () => {
    const admin = await aSignedInAdmin(app, deps);
    const older = await aSignedInPerson(app, deps);
    const owner = await aSignedInPerson(app, deps, { name: "Olive" });
    await aSignedInPerson(app, deps, { joins: owner.tenantId });
    await createProject(db, { name: "Invoices", tenantId: owner.tenantId });

    const page = (await callApi(app, "admin.businesses.list", { limit: 100 }, admin.cookie))
      .data as Page<BusinessRow>;
    const ids = page.entries.map(({ id }) => id);
    expect(ids.indexOf(owner.tenantId)).toBeLessThan(ids.indexOf(older.tenantId));
    expect(page.entries.find(({ id }) => id === owner.tenantId)).toEqual({
      id: owner.tenantId,
      name: "Olive’s business",
      slug: expect.any(String),
      members: 2,
      projects: 1,
      createdAt: expect.any(String),
    });
  });

  it("searches by business name and by member email", async () => {
    const admin = await aSignedInAdmin(app, deps);
    const marker = randomUUID().slice(0, 8);
    const named = await aSignedInPerson(app, deps, { name: `Bakery ${marker}` });
    const member = await aSignedInPerson(app, deps);
    const search = async (text: string) =>
      (
        (await callApi(app, "admin.businesses.list", { search: text }, admin.cookie))
          .data as Page<BusinessRow>
      ).entries.map(({ id }) => id);

    expect(await search(marker.toUpperCase())).toEqual([named.tenantId]);
    expect(await search(member.email)).toEqual([member.tenantId]);
    // A wildcard is searched for as itself.
    expect(await search("%")).toEqual([]);
  });

  it("pages", async () => {
    const admin = await aSignedInAdmin(app, deps);
    await aSignedInPerson(app, deps);
    await aSignedInPerson(app, deps);
    const list = async (cursor?: number) =>
      (await callApi(app, "admin.businesses.list", { limit: 1, cursor }, admin.cookie))
        .data as Page<BusinessRow>;
    const first = await list();
    expect(first.nextCursor).toBe(1);
    const second = await list(first.nextCursor ?? undefined);
    expect(second.entries).toHaveLength(1);
    expect(second.entries[0].id).not.toBe(first.entries[0].id);
  });
});

describe("one business", () => {
  it("has its members with their roles and whether each is an admin, and its projects with their state", async () => {
    const admin = await aSignedInAdmin(app, deps);
    const owner = await aSignedInPerson(app, deps, { name: "Olive" });
    const editor = await aSignedInPerson(app, deps, { name: "Eddie", joins: owner.tenantId });
    const staff = await aSignedInPerson(app, deps, { name: "Stella", joins: owner.tenantId });
    await db.update(users).set({ role: ADMIN_ROLE }).where(eq(users.email, staff.email));
    const project = await createProject(db, { name: "Invoices", tenantId: owner.tenantId });

    const { data } = await callApi(
      app,
      "admin.businesses.get",
      { id: owner.tenantId },
      admin.cookie
    );
    expect(data).toEqual({
      business: {
        id: owner.tenantId,
        name: "Olive’s business",
        slug: expect.any(String),
        createdAt: expect.any(String),
      },
      members: [
        { name: "Olive", email: owner.email, role: "owner", admin: false },
        { name: "Eddie", email: editor.email, role: "editor", admin: false },
        { name: "Stella", email: staff.email, role: "editor", admin: true },
      ],
      projects: [{ id: project.id, name: "Invoices", status: "draft" }],
    });
    expectNoSecrets(data, await secretsOf(owner.email, ""));
  });

  it("answers not found for a business that does not exist", async () => {
    const admin = await aSignedInAdmin(app, deps);
    const { code } = await callApi(app, "admin.businesses.get", { id: 2 ** 30 }, admin.cookie);
    expect(code).toBe("NOT_FOUND");
  });
});

describe("listing people", () => {
  it("shows each person's businesses, approval, and role, with nothing secret", async () => {
    const admin = await aSignedInAdmin(app, deps);
    const owner = await aSignedInPerson(app, deps, { name: "Olive" });
    const removed = await aSignedInPerson(app, deps);
    await removeApproval(db, removed.email);
    // A link the person has not used yet, which must not leak either.
    const { token } = await approveEmail(db, owner.email);

    const find = async (email: string) => {
      const { data } = await callApi(app, "admin.people.list", { search: email }, admin.cookie);
      return (data as Page<PersonRow>).entries;
    };
    const [olive] = await find(owner.email);
    expect(olive).toEqual({
      name: "Olive",
      email: owner.email,
      approved: true,
      admin: false,
      businesses: [{ id: owner.tenantId, name: "Olive’s business" }],
    });
    expect(await find(removed.email)).toEqual([expect.objectContaining({ approved: false })]);
    expect(await find(admin.email)).toEqual([
      expect.objectContaining({ admin: true, businesses: [] }),
    ]);
    expectNoSecrets(olive, await secretsOf(owner.email, token));
  });

  it("searches by name and pages", async () => {
    const admin = await aSignedInAdmin(app, deps);
    const marker = randomUUID().slice(0, 8);
    const first = await aSignedInPerson(app, deps, { name: `Pat ${marker}` });
    const second = await aSignedInPerson(app, deps, { name: `Sam ${marker}` });
    const list = async (cursor?: number) =>
      (await callApi(app, "admin.people.list", { search: marker, limit: 1, cursor }, admin.cookie))
        .data as Page<PersonRow>;
    const one = await list();
    const two = await list(one.nextCursor ?? undefined);
    // Newest first.
    expect([...one.entries, ...two.entries].map(({ email }) => email)).toEqual([
      second.email,
      first.email,
    ]);
    expect(two.nextCursor).toBeNull();
  });
});
