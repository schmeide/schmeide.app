import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.ts";
import { createDb } from "../db/client.ts";
import { copy } from "../../../data/copy.ts";
import {
  adminActions,
  approvedEmails,
  invites,
  memberships,
  sessions,
  tenants,
  users,
} from "../db/schema.ts";
import { BUSINESS_HEADER, type AppContext } from "../router.ts";
import { acceptInvite, approveEmail } from "../services/access.ts";
import { createProject, transition } from "../services/projects.ts";
import {
  aSignedInAdmin,
  aSignedInPerson,
  anEmail,
  callApi,
  PASSWORD,
  signIn,
  TEST_ORIGIN,
  testAuth,
} from "./testAuth.ts";

const db = createDb(process.env.DATABASE_URL ?? "");
afterAll(() => db.$client.end());

const start = vi.fn(async () => ({}) as never);
const cancel = vi.fn();
const getHandle = vi.fn(() => ({ cancel }) as never);
const deps: AppContext = {
  db,
  workflows: { start, getHandle },
  taskQueue: "test",
  interviewer: vi.fn(),
  siteFetcher: vi.fn(),
  websiteReader: vi.fn(),
  files: { put: vi.fn(), get: vi.fn(), remove: vi.fn(), removeProject: vi.fn() },
  reader: vi.fn(),
  resources: {} as never,
  auth: testAuth(db),
  providers: [],
};
const app = buildApp(deps);
afterAll(() => app.close());
beforeEach(() => {
  start.mockClear();
  cancel.mockClear();
  getHandle.mockClear();
});

const mutate = async (path: string, input: unknown, cookie: string) => {
  const response = await app.inject({
    method: "POST",
    url: `/trpc/${path}`,
    headers: { cookie, origin: TEST_ORIGIN },
    payload: { json: input },
  });
  const body = response.json();
  return {
    status: response.statusCode,
    code: body.error?.json.data.code as string | undefined,
    message: body.error?.json.message as string | undefined,
    data: body.result?.data.json,
  };
};

const idOf = async (email: string) => {
  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
  return user?.id;
};
const auditOf = (adminEmail: string) =>
  db.select().from(adminActions).where(eq(adminActions.adminLabel, adminEmail));

const upload = async (cookie: string, projectId: number, headers = {}) => {
  const response = await app.inject({
    method: "POST",
    url: `/projects/${projectId}/files?owner=mine&name=prices.csv`,
    headers: { cookie, "content-type": "text/csv", ...headers },
    payload: "item,price\nbread,3\n",
  });
  return { status: response.statusCode, code: response.json().error?.code as string | undefined };
};

describe("taking a person's access away and giving it back", () => {
  it("does what make access/remove and access/approve do, with an audit row each", async () => {
    const admin = await aSignedInAdmin(app, deps);
    const owner = await aSignedInPerson(app, deps);
    const ownerId = await idOf(owner.email);

    const removed = await mutate(
      "admin.access.remove",
      { email: owner.email, reason: "Ticket 7: left the company" },
      admin.cookie
    );
    expect(removed).toMatchObject({ status: 200, data: { removed: true } });
    // Off the list, and signed out everywhere.
    expect(
      await db.select().from(approvedEmails).where(eq(approvedEmails.email, owner.email))
    ).toEqual([]);
    expect(
      await db
        .select()
        .from(sessions)
        .where(eq(sessions.userId, ownerId ?? ""))
    ).toEqual([]);
    expect((await callApi(app, "session.get", undefined, owner.cookie)).data.person).toBeNull();
    expect((await signIn(app, owner.email)).status).toBe(403);

    // They have an account with a password, so no link is needed to give it back.
    const restored = await mutate(
      "admin.access.approve",
      { email: owner.email, reason: "Ticket 8: back" },
      admin.cookie
    );
    expect(restored).toMatchObject({
      status: 200,
      data: { email: owner.email, hasAccount: true, token: null },
    });
    const again = await signIn(app, owner.email);
    expect(again.status).toBe(200);
    // Their business and everything in it are still theirs.
    const session = await callApi(app, "session.get", undefined, again.cookie);
    expect(session.data.businesses.map((b: { id: number }) => b.id)).toEqual([owner.tenantId]);

    expect(
      (await auditOf(admin.email)).map(({ action, targetUserId, detail }) => ({
        action,
        targetUserId,
        detail,
      }))
    ).toEqual([
      {
        action: "access.remove",
        targetUserId: ownerId,
        detail: `${owner.email}: Ticket 7: left the company`,
      },
      { action: "access.approve", targetUserId: ownerId, detail: `${owner.email}: Ticket 8: back` },
    ]);
  });

  it("approves someone new, whose link is answered once and kept nowhere else", async () => {
    const admin = await aSignedInAdmin(app, deps);
    const email = anEmail();
    const approved = await mutate(
      "admin.access.approve",
      { email: email.toUpperCase(), reason: "New customer" },
      admin.cookie
    );
    expect(approved.data).toMatchObject({ email, hasAccount: false });
    const token: string = approved.data.token;
    expect(token).toMatch(/^[\w-]{40,}$/);
    // The link works.
    expect((await callApi(app, "invites.get", { token })).data).toEqual({
      email,
      hasAccount: false,
      business: null,
    });
    // Nothing the log keeps or lists carries it.
    const rows = await auditOf(admin.email);
    expect(JSON.stringify(rows)).not.toContain(token);
    const listed = await callApi(app, "admin.audit.list", {}, admin.cookie);
    expect(JSON.stringify(listed.data)).not.toContain(token);
    const people = await callApi(app, "admin.people.list", { search: email }, admin.cookie);
    expect(JSON.stringify(people.data)).not.toContain(token);
    expect(people.data.entries).toEqual([
      { name: null, email, approved: true, admin: false, hasAccount: false, businesses: [] },
    ]);
  });

  it("needs a reason and a real email, and changes nothing without them", async () => {
    const admin = await aSignedInAdmin(app, deps);
    const owner = await aSignedInPerson(app, deps);
    for (const reason of ["", "  "])
      expect(
        (await mutate("admin.access.remove", { email: owner.email, reason }, admin.cookie)).code
      ).toBe("BAD_REQUEST");
    expect(
      (await mutate("admin.access.approve", { email: "not an email", reason: "x" }, admin.cookie))
        .code
    ).toBe("BAD_REQUEST");
    expect((await callApi(app, "session.get", undefined, owner.cookie)).data.person).not.toBeNull();
    expect(await auditOf(admin.email)).toEqual([]);
  });
});

describe("an admin's own access", () => {
  it("is not removed here, theirs or another admin's: it goes with the role", async () => {
    const admin = await aSignedInAdmin(app, deps);
    const other = await aSignedInAdmin(app, deps);
    for (const email of [admin.email, other.email])
      expect((await mutate("admin.access.remove", { email, reason: "x" }, admin.cookie)).code).toBe(
        "FORBIDDEN"
      );
    expect((await callApi(app, "admin.whoami", undefined, other.cookie)).status).toBe(200);
    expect(await auditOf(admin.email)).toEqual([]);
  });
});

describe("the people list", () => {
  it("shows approved addresses that have not signed in yet, and those taken off the list", async () => {
    const admin = await aSignedInAdmin(app, deps);
    const marker = randomUUID();
    const waiting = `waiting-${marker}@example.com`;
    await approveEmail(db, waiting);
    const gone = await aSignedInPerson(app, deps, { name: `Gone ${marker}` });
    await mutate("admin.access.remove", { email: gone.email, reason: "x" }, admin.cookie);
    const list = await callApi(app, "admin.people.list", { search: marker }, admin.cookie);
    expect(list.data.entries).toEqual(
      expect.arrayContaining([
        {
          name: null,
          email: waiting,
          approved: true,
          admin: false,
          hasAccount: false,
          businesses: [],
        },
        expect.objectContaining({ email: gone.email, approved: false, hasAccount: true }),
      ])
    );
  });
});

describe("removing a person from a business", () => {
  it("takes the business away at once, and their approval no longer leads back into it", async () => {
    const admin = await aSignedInAdmin(app, deps);
    const owner = await aSignedInPerson(app, deps);
    // A teammate whose approval names the owner's business.
    const teammate = await aSignedInPerson(app, deps, { joins: owner.tenantId });
    const removed = await mutate(
      "admin.businesses.removeMember",
      { id: owner.tenantId, email: teammate.email, reason: "Owner asked" },
      admin.cookie
    );
    expect(removed.status).toBe(200);
    // Still signed in (sessions are left alone), but the business is gone, even named outright.
    const inIt = { [BUSINESS_HEADER]: String(owner.tenantId) };
    const session = await callApi(app, "session.get", undefined, teammate.cookie, inIt);
    expect(session.data.person.email).toBe(teammate.email);
    // In no business now, so first-run setup is theirs to go through again.
    expect(session.data.businesses).toEqual([]);
    const project = await createProject(db, { name: "Owner's", tenantId: owner.tenantId });
    expect(
      (await callApi(app, "projects.get", { id: project.id }, teammate.cookie, inIt)).code
    ).toBe("FORBIDDEN");
    const [approval] = await db
      .select()
      .from(approvedEmails)
      .where(eq(approvedEmails.email, teammate.email));
    expect(approval.tenantId).toBeNull();
    expect(
      (await auditOf(admin.email)).map(({ action, targetUserId, targetTenantId, detail }) => ({
        action,
        targetUserId,
        targetTenantId,
        detail,
      }))
    ).toEqual([
      {
        action: "business.removeMember",
        targetUserId: await idOf(teammate.email),
        targetTenantId: owner.tenantId,
        detail: `${teammate.email}: Owner asked`,
      },
    ]);
  });

  it("refuses the last owner, and someone who is not in it", async () => {
    const admin = await aSignedInAdmin(app, deps);
    const owner = await aSignedInPerson(app, deps);
    const stranger = await aSignedInPerson(app, deps);
    const last = await mutate(
      "admin.businesses.removeMember",
      { id: owner.tenantId, email: owner.email, reason: "x" },
      admin.cookie
    );
    expect(last.code).toBe("CONFLICT");
    expect(last.message).toContain("Add another owner first");
    expect(last.message).toContain(`“${copy.business.suspend}”`);
    expect(
      (
        await mutate(
          "admin.businesses.removeMember",
          { id: owner.tenantId, email: stranger.email, reason: "x" },
          admin.cookie
        )
      ).code
    ).toBe("NOT_FOUND");
    expect(
      await db
        .select()
        .from(memberships)
        .where(
          and(
            eq(memberships.tenantId, owner.tenantId),
            eq(memberships.userId, (await idOf(owner.email)) ?? "")
          )
        )
    ).toHaveLength(1);
    expect(await auditOf(admin.email)).toEqual([]);
  });

  it("lets one of two owners go", async () => {
    const admin = await aSignedInAdmin(app, deps);
    const owner = await aSignedInPerson(app, deps);
    const second = await aSignedInPerson(app, deps);
    await db
      .update(memberships)
      .set({ tenantId: owner.tenantId })
      .where(eq(memberships.userId, (await idOf(second.email)) ?? ""));
    const removed = await mutate(
      "admin.businesses.removeMember",
      { id: owner.tenantId, email: owner.email, reason: "Handed over" },
      admin.cookie
    );
    expect(removed.status).toBe(200);
  });
});

describe("a suspended business", () => {
  // An owner with a project ready to build, and the same business suspended by an admin.
  const suspended = async () => {
    const admin = await aSignedInAdmin(app, deps);
    const owner = await aSignedInPerson(app, deps);
    const project = await createProject(db, {
      name: `p ${randomUUID()}`,
      tenantId: owner.tenantId,
    });
    await transition(db, project.id, ["draft"], { status: "spec_ready", spec: "## Features" });
    const done = await mutate(
      "admin.businesses.suspend",
      { id: owner.tenantId, reason: "Ticket 9: abuse report" },
      admin.cookie
    );
    expect(done.status).toBe(200);
    return { admin, owner, project };
  };

  it("cannot be opened by its members: no projects, no build, no spec, no upload", async () => {
    const { owner, project } = await suspended();
    const refused = { code: "PRECONDITION_FAILED", message: "This business is suspended" };
    for (const [path, input] of [
      ["projects.list", undefined],
      ["projects.approveSpec", { id: project.id }],
      ["projects.generateSpec", { id: project.id }],
      ["projects.requestChange", { id: project.id, request: "x" }],
      ["interview.start", { id: project.id }],
    ] as const)
      expect([path, await callApi(app, path, input, owner.cookie)]).toEqual([
        path,
        expect.objectContaining(refused),
      ]);
    expect(await upload(owner.cookie, project.id)).toEqual({ status: 403, code: "suspended" });
    expect(start).not.toHaveBeenCalled();
    // The session still says who they are, and that the business is suspended.
    const session = await callApi(app, "session.get", undefined, owner.cookie);
    expect(session.data.person.email).toBe(owner.email);
    expect(session.data.businesses).toEqual([
      expect.objectContaining({ id: owner.tenantId, suspended: true }),
    ]);
  });

  it("leaves another business alone, the other business of one of its members included", async () => {
    const { owner } = await suspended();
    const other = await aSignedInPerson(app, deps);
    expect((await callApi(app, "projects.list", undefined, other.cookie)).status).toBe(200);
    // The owner is also let into the other business: with nothing chosen, that is the one used.
    await approveEmail(db, owner.email, { tenantId: other.tenantId });
    const theirs = await createProject(db, { name: "Other", tenantId: other.tenantId });
    const listed = await callApi(app, "projects.list", undefined, owner.cookie);
    expect(listed.data.map((p: { id: number }) => p.id)).toEqual([theirs.id]);
    const named = { [BUSINESS_HEADER]: String(other.tenantId) };
    expect((await callApi(app, "projects.list", undefined, owner.cookie, named)).status).toBe(200);
    expect((await upload(owner.cookie, theirs.id, named)).status).toBe(201);
    // Naming the suspended one is refused.
    const inSuspended = { [BUSINESS_HEADER]: String(owner.tenantId) };
    expect((await callApi(app, "projects.list", undefined, owner.cookie, inSuspended)).code).toBe(
      "PRECONDITION_FAILED"
    );
  });

  it("is what an admin viewing as a member sees too", async () => {
    const { owner } = await suspended();
    const other = await aSignedInAdmin(app, deps);
    const view = await app.inject({
      method: "POST",
      url: "/trpc/admin.impersonation.start",
      headers: { cookie: other.cookie, origin: TEST_ORIGIN },
      payload: { json: { email: owner.email, reason: "Why can they not get in" } },
    });
    expect(view.statusCode).toBe(200);
    // The browser's cookies after the answer: the view's session replaces the admin's.
    const jar = new Map(
      other.cookie.split("; ").map((pair) => {
        const at = pair.indexOf("=");
        return [pair.slice(0, at), pair.slice(at + 1)] as const;
      })
    );
    for (const { name, value, maxAge } of view.cookies)
      if (maxAge === 0 || value === "") jar.delete(name);
      else jar.set(name, value);
    const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
    const session = await callApi(app, "session.get", undefined, cookie);
    expect(session.data.person.email).toBe(owner.email);
    expect((await callApi(app, "projects.list", undefined, cookie)).code).toBe(
      "PRECONDITION_FAILED"
    );
  });

  it("keeps its live apps running: nothing is stopped or canceled", async () => {
    await suspended();
    expect(start).not.toHaveBeenCalled();
    expect(getHandle).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("is open again once restored, and both are in the list, the page, and the audit log", async () => {
    const { admin, owner } = await suspended();
    const page = await callApi(app, "admin.businesses.get", { id: owner.tenantId }, admin.cookie);
    expect(page.data.business).toMatchObject({
      state: "suspended",
      stateReason: "Ticket 9: abuse report",
    });
    const list = await callApi(app, "admin.businesses.list", { search: owner.email }, admin.cookie);
    expect(list.data.entries).toEqual([
      expect.objectContaining({ id: owner.tenantId, state: "suspended" }),
    ]);
    // Suspending again is refused, not repeated.
    const again = await mutate(
      "admin.businesses.suspend",
      { id: owner.tenantId, reason: "again" },
      admin.cookie
    );
    expect(again.code).toBe("CONFLICT");
    expect(again.message).toContain("already suspended");
    expect(again.message).toContain(`“${copy.business.restore}”`);

    const restored = await mutate(
      "admin.businesses.restore",
      { id: owner.tenantId, reason: "Ticket 9 resolved" },
      admin.cookie
    );
    expect(restored.status).toBe(200);
    const restoredAgain = await mutate(
      "admin.businesses.restore",
      { id: owner.tenantId, reason: "again" },
      admin.cookie
    );
    expect(restoredAgain.message).toContain("nothing to restore");
    expect((await callApi(app, "projects.list", undefined, owner.cookie)).status).toBe(200);
    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, owner.tenantId));
    expect(tenant).toMatchObject({ state: "active", stateReason: "Ticket 9 resolved" });
    expect(
      (await auditOf(admin.email)).map(({ action, targetTenantId, detail }) => ({
        action,
        targetTenantId,
        detail,
      }))
    ).toEqual([
      {
        action: "business.suspend",
        targetTenantId: owner.tenantId,
        detail: "Ticket 9: abuse report",
      },
      { action: "business.restore", targetTenantId: owner.tenantId, detail: "Ticket 9 resolved" },
    ]);
  });

  it("needs a reason", async () => {
    const admin = await aSignedInAdmin(app, deps);
    const owner = await aSignedInPerson(app, deps);
    expect(
      (await mutate("admin.businesses.suspend", { id: owner.tenantId, reason: " " }, admin.cookie))
        .code
    ).toBe("BAD_REQUEST");
    expect((await callApi(app, "projects.list", undefined, owner.cookie)).status).toBe(200);
  });
});

describe("creating a business", () => {
  it("approves a new owner, answers their link once, and makes them owner on first sign-in", async () => {
    const admin = await aSignedInAdmin(app, deps);
    const email = anEmail();
    const name = `Bakery ${randomUUID()}`;
    const created = await mutate(
      "admin.businesses.create",
      { name, ownerEmail: email, reason: "Signed up by phone" },
      admin.cookie
    );
    expect(created.data).toMatchObject({ created: true, email, hasAccount: false });
    const token: string = created.data.token;
    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, created.data.id));
    expect(tenant.name).toBe(name);
    expect(tenant.slug).toMatch(/^bakery-/);
    expect(JSON.stringify(await auditOf(admin.email))).not.toContain(token);

    await acceptInvite(deps, { token, name: "Bea Baker", password: PASSWORD });
    const { cookie } = await signIn(app, email);
    const session = await callApi(app, "session.get", undefined, cookie);
    expect(session.data.businesses).toEqual([expect.objectContaining({ id: tenant.id, name })]);
    const [membership] = await db
      .select()
      .from(memberships)
      .where(eq(memberships.tenantId, tenant.id));
    expect(membership.role).toBe("owner");
  });

  it("makes one business when asked twice for the same name and owner", async () => {
    const admin = await aSignedInAdmin(app, deps);
    const email = anEmail();
    const name = `Twice ${randomUUID()}`;
    const input = { name, ownerEmail: email, reason: "x" };
    const [first, second] = await Promise.all([
      mutate("admin.businesses.create", input, admin.cookie),
      mutate(
        "admin.businesses.create",
        { ...input, name: ` ${name.toUpperCase()} ` },
        admin.cookie
      ),
    ]);
    expect(second.data.id).toBe(first.data.id);
    expect([first.data.created, second.data.created].sort()).toEqual([false, true]);
    expect(
      await db
        .select()
        .from(tenants)
        .where(sql`lower(${tenants.name}) = ${name.toLowerCase()}`)
    ).toHaveLength(1);
    // Only the newest link works.
    const live = await db
      .select()
      .from(invites)
      .where(and(eq(invites.email, email)));
    expect(live.filter((invite) => invite.usedAt === null)).toHaveLength(1);
  });

  it("makes an owner who already has an account its owner at once, with no link", async () => {
    const admin = await aSignedInAdmin(app, deps);
    const owner = await aSignedInPerson(app, deps);
    const name = `Second ${randomUUID()}`;
    const created = await mutate(
      "admin.businesses.create",
      { name, ownerEmail: owner.email, reason: "A second shop" },
      admin.cookie
    );
    expect(created.data).toMatchObject({ created: true, hasAccount: true, token: null });
    const session = await callApi(app, "session.get", undefined, owner.cookie);
    expect(session.data.businesses.map((b: { name: string }) => b.name)).toEqual([
      expect.any(String),
      name,
    ]);
  });

  it("gives a name that is already a slug another slug", async () => {
    const admin = await aSignedInAdmin(app, deps);
    const name = `Same ${randomUUID()}`;
    const first = await mutate(
      "admin.businesses.create",
      { name, ownerEmail: anEmail(), reason: "x" },
      admin.cookie
    );
    const second = await mutate(
      "admin.businesses.create",
      { name, ownerEmail: anEmail(), reason: "x" },
      admin.cookie
    );
    expect(second.data.id).not.toBe(first.data.id);
    const slugs = await db
      .select({ slug: tenants.slug })
      .from(tenants)
      .where(eq(tenants.name, name));
    expect(new Set(slugs.map(({ slug }) => slug)).size).toBe(2);
  });

  it("refuses an empty name and a bad email", async () => {
    const admin = await aSignedInAdmin(app, deps);
    for (const input of [
      { name: " ", ownerEmail: anEmail(), reason: "x" },
      { name: "Fine", ownerEmail: "nope", reason: "x" },
      { name: "x".repeat(121), ownerEmail: anEmail(), reason: "x" },
    ])
      expect((await mutate("admin.businesses.create", input, admin.cookie)).code).toBe(
        "BAD_REQUEST"
      );
  });

  it("is recorded naming the business and the owner", async () => {
    const admin = await aSignedInAdmin(app, deps);
    const email = anEmail();
    const created = await mutate(
      "admin.businesses.create",
      { name: `Logged ${randomUUID()}`, ownerEmail: email, reason: "Contract 12" },
      admin.cookie
    );
    expect(await auditOf(admin.email)).toEqual([
      expect.objectContaining({
        action: "business.create",
        targetTenantId: created.data.id,
        targetUserId: null,
        detail: `${email}: Contract 12`,
      }),
    ]);
  });
});
