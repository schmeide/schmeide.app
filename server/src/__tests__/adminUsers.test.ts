import { randomUUID } from "node:crypto";
import { and, eq, inArray, notInArray } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.ts";
import { createDb } from "../db/client.ts";
import {
  ADMIN_ROLE,
  adminActions,
  approvedEmails,
  memberships,
  sessions,
  users,
} from "../db/schema.ts";
import type { AppContext } from "../router.ts";
import { acceptInvite, approveEmail, grantAdmin, revokeAdmin } from "../services/access.ts";
import { COMMAND_LINE, withAudit } from "../services/audit.ts";
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

const deps: AppContext = {
  db,
  workflows: { start: vi.fn(), getHandle: vi.fn() as never },
  taskQueue: "test",
  interviewer: vi.fn(),
  siteFetcher: vi.fn(),
  websiteReader: vi.fn(),
  files: {} as never,
  reader: vi.fn(),
  resources: {} as never,
  auth: testAuth(db),
  providers: [],
};
const app = buildApp(deps);
afterAll(() => app.close());

const noProcedure = (path: string) => ({
  status: 404,
  code: "NOT_FOUND",
  message: `No procedure found on path "${path}"`,
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
    cookies: response.cookies,
  };
};

const userOf = async (email: string) => {
  const [user] = await db
    .select({ id: users.id, role: users.role })
    .from(users)
    .where(eq(users.email, email));
  return user;
};
const auditOf = (adminEmail: string) =>
  db.select().from(adminActions).where(eq(adminActions.adminLabel, adminEmail));
const whoami = async (cookie: string) => {
  const { status, code, message } = await callApi(app, "admin.whoami", undefined, cookie);
  return { status, code, message };
};
// Takes the role from every admin but these, so a test can count on who the admins are. Every
// test that needs another admin makes a new one.
const onlyAdmins = (...emails: readonly string[]) =>
  db
    .update(users)
    .set({ role: null })
    .where(and(eq(users.role, ADMIN_ROLE), notInArray(users.email, ["", ...emails])));

describe("the list of admins", () => {
  it("shows every admin, and one who has not signed in yet as waiting", async () => {
    const admin = await aSignedInAdmin(app, deps);
    const waiting = anEmail();
    await mutate("admin.admins.grant", { email: waiting, reason: "New hire" }, admin.cookie);
    const list = await callApi(app, "admin.admins.list", undefined, admin.cookie);
    expect(list.data).toEqual(
      expect.arrayContaining([
        { name: "Grace Admin", email: admin.email, pending: false, approved: true },
        { name: null, email: waiting, pending: true, approved: true },
      ])
    );
    expect(JSON.stringify(list.data)).not.toMatch(/token|password/i);
  });
});

describe("making someone an admin", () => {
  it("gives an approved person with an account the role now, recorded against the admin", async () => {
    const admin = await aSignedInAdmin(app, deps);
    const owner = await aSignedInPerson(app, deps);
    const granted = await mutate(
      "admin.admins.grant",
      { email: owner.email, reason: "Joined support" },
      admin.cookie
    );
    expect(granted.data).toEqual({ email: owner.email, pending: false, token: null });
    expect((await whoami(owner.cookie)).status).toBe(200);
    expect(await auditOf(admin.email)).toEqual([
      expect.objectContaining({
        action: "admin.grant",
        targetUserId: (await userOf(owner.email)).id,
        detail: `${owner.email}: Joined support`,
      }),
    ]);
    // Their business is still theirs.
    const session = await callApi(app, "session.get", undefined, owner.cookie);
    expect(session.data.businesses.map((b: { id: number }) => b.id)).toEqual([owner.tenantId]);
    // Their business's admin page marks them an admin, so it no longer offers viewing as them.
    const business = await callApi(
      app,
      "admin.businesses.get",
      { id: owner.tenantId },
      admin.cookie
    );
    expect(business.data.members).toEqual([
      expect.objectContaining({ email: owner.email, admin: true }),
    ]);
  });

  it("approves someone with no account, and they are an admin from their first sign-in only", async () => {
    const admin = await aSignedInAdmin(app, deps);
    const email = anEmail();
    const granted = await mutate("admin.admins.grant", { email, reason: "New hire" }, admin.cookie);
    expect(granted.data).toMatchObject({ email, pending: true });
    const token: string = granted.data.token;
    expect(JSON.stringify(await auditOf(admin.email))).not.toContain(token);
    expect(await userOf(email)).toBeUndefined();

    await acceptInvite(deps, { token, name: "Nina New", password: PASSWORD });
    expect((await userOf(email)).role).toBe(ADMIN_ROLE);
    const { cookie } = await signIn(app, email);
    expect((await whoami(cookie)).status).toBe(200);
    // Applied once: the approval no longer carries it.
    const [approval] = await db
      .select()
      .from(approvedEmails)
      .where(eq(approvedEmails.email, email));
    expect(approval.admin).toBe(false);
  });

  it("gives the role on a first provider sign-in too", async () => {
    const admin = await aSignedInAdmin(app, deps);
    const email = anEmail();
    await mutate("admin.admins.grant", { email, reason: "New hire" }, admin.cookie);
    // What a first sign-in with Google, Microsoft, or Apple runs to make the account.
    const { internalAdapter } = await deps.auth.$context;
    await internalAdapter.createOAuthUser(
      { email, name: "Pat Provider", emailVerified: true },
      { providerId: "google", accountId: randomUUID() }
    );
    expect((await userOf(email)).role).toBe(ADMIN_ROLE);
  });

  it("never comes from an approval without it, whatever the invite or the account asks for", async () => {
    const email = anEmail();
    const { token } = await approveEmail(db, email);
    const accepted = await callApi(app, "invites.accept", {
      token,
      name: "Mal",
      password: PASSWORD,
      role: ADMIN_ROLE,
      admin: true,
    });
    expect(accepted.status).toBe(200);
    expect((await userOf(email)).role).not.toBe(ADMIN_ROLE);
    const { cookie } = await signIn(app, email);
    expect(await whoami(cookie)).toEqual(noProcedure("admin.whoami"));

    const other = anEmail();
    await approveEmail(db, other);
    const { internalAdapter } = await deps.auth.$context;
    // A profile that somehow carries the role.
    const profile = { email: other, name: "Mal Provider", emailVerified: true, role: ADMIN_ROLE };
    await internalAdapter.createOAuthUser(profile, {
      providerId: "google",
      accountId: randomUUID(),
    });
    expect((await userOf(other)).role).not.toBe(ADMIN_ROLE);
  });

  it("is not carried by one person's link to another", async () => {
    const admin = await aSignedInAdmin(app, deps);
    await mutate("admin.admins.grant", { email: anEmail(), reason: "x" }, admin.cookie);
    const email = anEmail();
    const { token } = await approveEmail(db, email);
    await acceptInvite(deps, { token, name: "Bystander", password: PASSWORD });
    expect((await userOf(email)).role).not.toBe(ADMIN_ROLE);
  });

  it("refuses someone whose access was removed, and asks for a reason", async () => {
    const admin = await aSignedInAdmin(app, deps);
    const owner = await aSignedInPerson(app, deps);
    await db.delete(approvedEmails).where(eq(approvedEmails.email, owner.email));
    expect(
      (await mutate("admin.admins.grant", { email: owner.email, reason: "x" }, admin.cookie)).code
    ).toBe("CONFLICT");
    expect(
      (await mutate("admin.admins.grant", { email: anEmail(), reason: " " }, admin.cookie)).code
    ).toBe("BAD_REQUEST");
    expect((await userOf(owner.email)).role).not.toBe(ADMIN_ROLE);
    expect(await auditOf(admin.email)).toEqual([]);
  });

  it("works from the command line with no admin at all", async () => {
    const { email, token } = await approveEmail(db, anEmail());
    await acceptInvite(deps, { token, name: "Rescue", password: PASSWORD });
    await onlyAdmins();
    expect(await db.select().from(users).where(eq(users.role, ADMIN_ROLE))).toEqual([]);
    expect(await grantAdmin(db, email, COMMAND_LINE)).toEqual({ email });
    expect((await userOf(email)).role).toBe(ADMIN_ROLE);
  });
});

describe("taking the role away", () => {
  it("ends their sessions and their views, and the admin area is gone on the very next call", async () => {
    const admin = await aSignedInAdmin(app, deps);
    const other = await aSignedInAdmin(app, deps);
    const owner = await aSignedInPerson(app, deps);
    const view = await mutate(
      "admin.impersonation.start",
      { email: owner.email, reason: "x" },
      other.cookie
    );
    expect(view.status).toBe(200);
    const otherId = (await userOf(other.email)).id;

    const revoked = await mutate(
      "admin.admins.revoke",
      { email: other.email, reason: "Left the team" },
      admin.cookie
    );
    expect(revoked.status).toBe(200);
    expect(await whoami(other.cookie)).toEqual(noProcedure("admin.whoami"));
    expect(await db.select().from(sessions).where(eq(sessions.userId, otherId))).toEqual([]);
    expect(await db.select().from(sessions).where(eq(sessions.impersonatedBy, otherId))).toEqual(
      []
    );
    expect((await userOf(other.email)).role).toBeNull();
    // They can still sign in, as the customer they now are.
    const again = await signIn(app, other.email);
    expect(again.status).toBe(200);
    expect(await whoami(again.cookie)).toEqual(noProcedure("admin.whoami"));
    expect(await auditOf(admin.email)).toEqual([
      expect.objectContaining({
        action: "admin.revoke",
        targetUserId: otherId,
        detail: `${other.email}: Left the team`,
      }),
    ]);
  });

  it("leaves their business memberships alone", async () => {
    const admin = await aSignedInAdmin(app, deps);
    const owner = await aSignedInPerson(app, deps);
    await mutate("admin.admins.grant", { email: owner.email, reason: "x" }, admin.cookie);
    await mutate("admin.admins.revoke", { email: owner.email, reason: "y" }, admin.cookie);
    const ownerId = (await userOf(owner.email)).id;
    expect(await db.select().from(memberships).where(eq(memberships.userId, ownerId))).toEqual([
      expect.objectContaining({ tenantId: owner.tenantId, role: "owner" }),
    ]);
  });

  it("withdraws a grant that is still waiting for a first sign-in", async () => {
    const admin = await aSignedInAdmin(app, deps);
    const email = anEmail();
    const { data } = await mutate("admin.admins.grant", { email, reason: "x" }, admin.cookie);
    expect(
      (await mutate("admin.admins.revoke", { email, reason: "Wrong person" }, admin.cookie)).status
    ).toBe(200);
    await acceptInvite(deps, { token: data.token, name: "Not admin", password: PASSWORD });
    expect((await userOf(email)).role).not.toBe(ADMIN_ROLE);
  });

  it("refuses an admin's own role, and someone who is not an admin", async () => {
    const admin = await aSignedInAdmin(app, deps);
    const owner = await aSignedInPerson(app, deps);
    expect(
      (await mutate("admin.admins.revoke", { email: admin.email, reason: "x" }, admin.cookie)).code
    ).toBe("FORBIDDEN");
    expect(
      (await mutate("admin.admins.revoke", { email: owner.email, reason: "x" }, admin.cookie)).code
    ).toBe("NOT_FOUND");
    expect((await whoami(admin.cookie)).status).toBe(200);
    expect(await auditOf(admin.email)).toEqual([]);
  });

  it("refuses the last admin", async () => {
    const admin = await aSignedInAdmin(app, deps);
    await onlyAdmins(admin.email);
    // Asked by anyone at all: there must be an admin left.
    await expect(
      withAudit(db, COMMAND_LINE, "admin.revoke", (tx, audit) =>
        revokeAdmin(tx, audit, { email: admin.email, reason: "x", byId: null })
      )
    ).rejects.toThrow("The last admin");
    expect((await userOf(admin.email)).role).toBe(ADMIN_ROLE);
  });

  it("leaves one admin when the last two take each other's role at the same moment", async () => {
    const ada = await aSignedInAdmin(app, deps);
    const bob = await aSignedInAdmin(app, deps);
    await onlyAdmins(ada.email, bob.email);
    const answers = await Promise.all([
      mutate("admin.admins.revoke", { email: bob.email, reason: "race" }, ada.cookie),
      mutate("admin.admins.revoke", { email: ada.email, reason: "race" }, bob.cookie),
    ]);
    // The other is refused, as a removed admin or as the last one, whichever it reached first.
    expect(answers.filter(({ status }) => status === 200)).toHaveLength(1);
    const left = await db
      .select({ email: users.email })
      .from(users)
      .where(and(eq(users.role, ADMIN_ROLE), inArray(users.email, [ada.email, bob.email])));
    expect(left).toHaveLength(1);
    expect(await db.select().from(users).where(eq(users.role, ADMIN_ROLE))).toHaveLength(1);
    // Exactly one change is in the log.
    const ids = [(await userOf(ada.email)).id, (await userOf(bob.email)).id];
    expect(
      await db
        .select()
        .from(adminActions)
        .where(
          and(eq(adminActions.action, "admin.revoke"), inArray(adminActions.targetUserId, ids))
        )
    ).toHaveLength(1);
  });
});
