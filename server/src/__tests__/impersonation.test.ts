import { and, eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.ts";
import { createDb } from "../db/client.ts";
import { adminActions, sessions, users } from "../db/schema.ts";
import type { AppContext } from "../router.ts";
import { approveEmail, endImpersonationsBy, removeApproval } from "../services/access.ts";
import { AUTH_PATHS_WHILE_IMPERSONATING, IMPERSONATION_SECONDS } from "../services/auth.ts";
import { createProject } from "../services/projects.ts";
import {
  aSignedInAdmin,
  aSignedInPerson,
  callApi,
  mutationPaths,
  signIn,
  TEST_ORIGIN,
  testAuth,
} from "./testAuth.ts";

const db = createDb(process.env.DATABASE_URL ?? "");
afterAll(() => db.$client.end());

const deps: AppContext = {
  db,
  workflows: { start: vi.fn(async () => ({}) as never), getHandle: vi.fn() as never },
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

const noProcedure = (path: string) => ({
  status: 404,
  code: "NOT_FOUND",
  message: `No procedure found on path "${path}"`,
});
const answer = async (path: string, cookie: string, input?: unknown) => {
  const { status, code, message } = await callApi(app, path, input, cookie);
  return { status, code, message };
};

const idOf = async (email: string) => {
  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
  return user.id;
};

type SetCookie = { readonly name: string; readonly value: string; readonly maxAge?: number };
// What a browser holds after an answer: the cookies it had, with the ones the answer set or
// cleared applied.
const applyCookies = (cookie: string, set: readonly SetCookie[]) => {
  const jar = new Map(
    cookie
      .split("; ")
      .filter(Boolean)
      .map((pair) => {
        const at = pair.indexOf("=");
        return [pair.slice(0, at), pair.slice(at + 1)] as const;
      })
  );
  for (const { name, value, maxAge } of set) {
    if (maxAge === 0 || value === "") jar.delete(name);
    else jar.set(name, value);
  }
  return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
};

// Calls a mutation over HTTP and answers what the browser then holds.
const mutate = async (path: string, input: unknown, cookie: string) => {
  const response = await app.inject({
    method: "POST",
    url: `/api/trpc/${path}`,
    headers: { cookie, origin: TEST_ORIGIN },
    payload: { json: input },
  });
  const body = response.json();
  return {
    status: response.statusCode,
    code: body.error?.json.data.code as string | undefined,
    data: body.result?.data.json,
    cookie: applyCookies(cookie, response.cookies),
  };
};

// An admin viewing as a new owner: the admin's own cookie, and the one the browser holds after.
const viewing = async (reason = "Reproducing a stuck build") => {
  const admin = await aSignedInAdmin(app, deps);
  const owner = await aSignedInPerson(app, deps, { name: "Olive Owner" });
  const started = await mutate(
    "admin.impersonation.start",
    { email: owner.email, reason },
    admin.cookie
  );
  expect(started.status).toBe(200);
  return { admin, owner, cookie: started.cookie };
};

// Uploads a small spreadsheet over the upload route (uploads.ts), outside tRPC.
const upload = async (cookie: string, projectId: number) =>
  (
    await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/files?owner=mine&name=prices.csv`,
      headers: { cookie, "content-type": "text/csv" },
      payload: "item,price\nbread,3\n",
    })
  ).statusCode;

const auditRows = (adminEmail: string) =>
  db.select().from(adminActions).where(eq(adminActions.adminLabel, adminEmail));

const impersonatedSessions = (adminEmail: string) =>
  db
    .select()
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.impersonatedBy))
    .where(eq(users.email, adminEmail));

describe("starting to view as a person", () => {
  it("answers an owner exactly as a procedure that does not exist", async () => {
    const owner = await aSignedInPerson(app, deps);
    const other = await aSignedInPerson(app, deps);
    const path = "admin.impersonation.start";
    expect(await answer(path, owner.cookie, { email: other.email, reason: "curious" })).toEqual(
      noProcedure(path)
    );
  });

  it("makes the admin that person, told apart by the session, with nothing of the admin's", async () => {
    const { admin, owner, cookie } = await viewing();
    const session = await callApi(app, "session.get", undefined, cookie);
    expect(session.data.person).toEqual({ name: "Olive Owner", email: owner.email });
    expect(session.data.impersonatedBy).toEqual({ name: "Grace Admin", email: admin.email });
    expect(session.data.businesses).toEqual(owner.businesses);
    // Nothing secret about the person rides along.
    expect(JSON.stringify(session.data)).not.toMatch(/password|token|accessToken/i);

    const own = await createProject(db, { name: "Theirs", tenantId: owner.tenantId });
    expect((await callApi(app, "projects.list", undefined, cookie)).data).toEqual([
      expect.objectContaining({ id: own.id }),
    ]);
    // The person's own guards: another business is still out of reach.
    const stranger = await aSignedInPerson(app, deps);
    const elsewhere = await createProject(db, { name: "Elsewhere", tenantId: stranger.tenantId });
    expect((await callApi(app, "projects.get", { id: elsewhere.id }, cookie)).code).toBe(
      "NOT_FOUND"
    );
    // And the admin area is gone, starting another one included.
    expect(await answer("admin.whoami", cookie)).toEqual(noProcedure("admin.whoami"));
    expect(
      await answer("admin.impersonation.start", cookie, { email: stranger.email, reason: "x" })
    ).toEqual(noProcedure("admin.impersonation.start"));
  });

  it("needs a reason", async () => {
    const admin = await aSignedInAdmin(app, deps);
    const owner = await aSignedInPerson(app, deps);
    for (const reason of ["", "   "]) {
      const started = await mutate(
        "admin.impersonation.start",
        { email: owner.email, reason },
        admin.cookie
      );
      expect(started.code).toBe("BAD_REQUEST");
    }
    expect(await impersonatedSessions(admin.email)).toEqual([]);
  });

  it("refuses another admin, the admin themselves, and nobody", async () => {
    const admin = await aSignedInAdmin(app, deps);
    const other = await aSignedInAdmin(app, deps);
    const start = (email: string) =>
      mutate("admin.impersonation.start", { email, reason: "testing" }, admin.cookie);
    expect((await start(other.email)).code).toBe("FORBIDDEN");
    expect((await start(admin.email)).code).toBe("FORBIDDEN");
    expect((await start("nobody@example.com")).code).toBe("NOT_FOUND");
    expect(await impersonatedSessions(admin.email)).toEqual([]);
    // The refused attempts leave the admin as they were.
    expect((await callApi(app, "admin.whoami", undefined, admin.cookie)).status).toBe(200);
  });

  it("works for a person whose approval was removed, who still cannot sign in", async () => {
    const admin = await aSignedInAdmin(app, deps);
    const owner = await aSignedInPerson(app, deps, { name: "Olive Owner" });
    await removeApproval(db, owner.email);
    expect((await signIn(app, owner.email)).status).toBe(403);
    const started = await mutate(
      "admin.impersonation.start",
      { email: owner.email, reason: "They say they cannot get in" },
      admin.cookie
    );
    expect(started.status).toBe(200);
    const session = await callApi(app, "session.get", undefined, started.cookie);
    expect(session.data.person.email).toBe(owner.email);
    expect((await signIn(app, owner.email)).status).toBe(403);
  });
});

describe("the audit trail", () => {
  it("records the start and the stop with the reason, and every write in between", async () => {
    const { admin, owner, cookie } = await viewing("Ticket 42: build stuck");
    const ownerId = await idOf(owner.email);
    const adminId = await idOf(admin.email);
    const created = await callApi(app, "projects.create", { name: "Made by support" }, cookie);
    expect(created.status).toBe(200);
    const stopped = await mutate("impersonation.stop", undefined, cookie);
    expect(stopped.status).toBe(200);

    expect(
      (await auditRows(admin.email)).map((row) => ({
        adminId: row.adminId,
        action: row.action,
        targetUserId: row.targetUserId,
        targetTenantId: row.targetTenantId,
        detail: row.detail,
      }))
    ).toEqual([
      {
        adminId,
        action: "impersonation.start",
        targetUserId: ownerId,
        targetTenantId: null,
        detail: "Ticket 42: build stuck",
      },
      {
        adminId,
        action: "impersonation.write",
        targetUserId: ownerId,
        targetTenantId: owner.tenantId,
        detail: "projects.create",
      },
      {
        adminId,
        action: "impersonation.stop",
        targetUserId: ownerId,
        targetTenantId: null,
        detail: "",
      },
    ]);
  });

  it("names the admin on every customer write, walked so a new one is covered unlisted", async () => {
    const { admin, cookie } = await viewing();
    // Not built on `signedIn`: they act on no business, and are tested on their own.
    const outside = ["invites.accept", "impersonation.stop"];
    const mutations = mutationPaths.filter(
      (path) => !path.startsWith("admin.") && !outside.includes(path)
    );
    expect(mutations).toEqual(expect.arrayContaining(["projects.create", "projects.delete"]));
    const unrecorded: string[] = [];
    for (const path of mutations) {
      const before = (await auditRows(admin.email)).length;
      // No input: the row is written before the input is even read.
      await callApi(app, path, undefined, cookie);
      const rows = await auditRows(admin.email);
      if (rows.length !== before + 1 || rows[rows.length - 1].detail !== path)
        unrecorded.push(path);
    }
    expect(unrecorded).toEqual([]);
  });

  it("records an upload, which is not a procedure", async () => {
    const { admin, owner, cookie } = await viewing();
    const project = await createProject(db, { name: "Theirs", tenantId: owner.tenantId });
    expect(await upload(cookie, project.id)).toBe(201);
    expect((await auditRows(admin.email)).at(-1)).toMatchObject({
      action: "impersonation.write",
      targetUserId: await idOf(owner.email),
      targetTenantId: owner.tenantId,
      detail: "files.upload",
    });
  });
});

describe("stopping", () => {
  it("returns the admin to their own session", async () => {
    const { admin, cookie } = await viewing();
    const stopped = await mutate("impersonation.stop", undefined, cookie);
    expect(stopped.status).toBe(200);
    const session = await callApi(app, "session.get", undefined, stopped.cookie);
    expect(session.data.person).toEqual({ name: "Grace Admin", email: admin.email, role: "admin" });
    expect(session.data.impersonatedBy).toBeNull();
    expect(await impersonatedSessions(admin.email)).toEqual([]);
  });

  it("answers anyone not viewing as someone exactly as a procedure that does not exist", async () => {
    const owner = await aSignedInPerson(app, deps);
    const admin = await aSignedInAdmin(app, deps);
    for (const cookie of [owner.cookie, admin.cookie, ""])
      expect(await answer("impersonation.stop", cookie)).toEqual(noProcedure("impersonation.stop"));
  });

  it("still ends the view when the admin's own session has gone", async () => {
    const { admin, cookie } = await viewing();
    await db
      .delete(sessions)
      .where(and(eq(sessions.userId, await idOf(admin.email)), sql`impersonated_by is null`));
    const stopped = await mutate("impersonation.stop", undefined, cookie);
    expect(stopped.status).toBe(200);
    expect(await impersonatedSessions(admin.email)).toEqual([]);
    expect((await callApi(app, "session.get", undefined, stopped.cookie)).data.person).toBeNull();
    expect((await auditRows(admin.email)).map((row) => row.action)).toEqual([
      "impersonation.start",
      "impersonation.stop",
    ]);
  });
});

describe("the time limit", () => {
  it("is an hour from the start", async () => {
    const { admin } = await viewing();
    const [{ sessions: session }] = await impersonatedSessions(admin.email);
    expect(IMPERSONATION_SECONDS).toBe(3600);
    expect(session.expiresAt.getTime() - session.createdAt.getTime()).toBeCloseTo(3_600_000, -4);
  });

  it("ends the view, signed out, even when the session was renewed", async () => {
    const { admin, owner, cookie } = await viewing();
    // As if an hour has passed, and something pushed the expiry out.
    await db
      .update(sessions)
      .set({
        createdAt: sql`now() - interval '61 minutes'`,
        expiresAt: sql`now() + interval '7 days'`,
      })
      .where(eq(sessions.impersonatedBy, await idOf(admin.email)));
    const read = await app.inject({
      method: "GET",
      url: "/api/auth/get-session",
      headers: { cookie, origin: TEST_ORIGIN },
    });
    expect(read.json()).toBeNull();
    const session = await callApi(app, "session.get", undefined, cookie);
    expect(session.data.person).toBeNull();
    expect((await callApi(app, "projects.list", undefined, cookie)).code).toBe("UNAUTHORIZED");
    expect(await impersonatedSessions(admin.email)).toEqual([]);
    // Nothing is left that blocks signing in again.
    expect((await signIn(app, admin.email)).status).toBe(200);
    expect((await signIn(app, owner.email)).status).toBe(200);
  });

  it("ends the view at the session's own expiry", async () => {
    const { admin, cookie } = await viewing();
    await db
      .update(sessions)
      .set({ expiresAt: sql`now() - interval '1 second'` })
      .where(eq(sessions.impersonatedBy, await idOf(admin.email)));
    expect((await callApi(app, "session.get", undefined, cookie)).data.person).toBeNull();
  });
});

describe("while viewing as a person", () => {
  it("refuses every sign-in route but the session read, walked so a new route is refused", async () => {
    const { cookie, owner } = await viewing();
    const paths = Object.values(deps.auth.api)
      .map((endpoint) => (endpoint as { readonly path?: string }).path)
      .filter((path): path is string => typeof path === "string");
    expect(paths).toEqual(
      expect.arrayContaining([
        "/change-password",
        "/change-email",
        "/delete-user",
        "/revoke-sessions",
        "/revoke-other-sessions",
        "/link-social",
        "/unlink-account",
        "/list-accounts",
        "/update-user",
        "/sign-out",
        "/get-access-token",
      ])
    );
    expect(AUTH_PATHS_WHILE_IMPERSONATING).toEqual(["/get-session"]);
    const served: string[] = [];
    for (const path of paths.filter((path) => !AUTH_PATHS_WHILE_IMPERSONATING.includes(path))) {
      const url = `/api/auth${path.replace(/:\w+/g, "x")}`;
      for (const method of ["GET", "POST"] as const) {
        const response = await app.inject({
          method,
          url,
          headers: { cookie, origin: TEST_ORIGIN },
          ...(method === "POST" ? { payload: {} } : {}),
        });
        if (response.statusCode !== 403 || response.json().code !== "IMPERSONATING")
          served.push(`${method} ${path}`);
      }
    }
    expect(served).toEqual([]);

    const read = await app.inject({
      method: "GET",
      url: "/api/auth/get-session",
      headers: { cookie, origin: TEST_ORIGIN },
    });
    expect(read.statusCode).toBe(200);
    expect(read.json().user.email).toBe(owner.email);
    // The person still signs in with the same password: nothing was changed.
    expect((await signIn(app, owner.email)).status).toBe(200);
  });

  it("cannot be claimed by a person marking their own session", async () => {
    const admin = await aSignedInAdmin(app, deps);
    const owner = await aSignedInPerson(app, deps);
    await app.inject({
      method: "POST",
      url: "/api/auth/update-session",
      headers: { cookie: owner.cookie, origin: TEST_ORIGIN },
      payload: { impersonatedBy: await idOf(admin.email) },
    });
    expect(await impersonatedSessions(admin.email)).toEqual([]);
    const session = await callApi(app, "session.get", undefined, owner.cookie);
    expect(session.data.impersonatedBy).toBeNull();
  });

  it("refuses the same routes only while viewing, not to the person themselves", async () => {
    const owner = await aSignedInPerson(app, deps);
    const response = await app.inject({
      method: "GET",
      url: "/api/auth/list-accounts",
      headers: { cookie: owner.cookie, origin: TEST_ORIGIN },
    });
    expect(response.statusCode).toBe(200);
  });

  it("refuses accepting a set-password link", async () => {
    const { cookie, owner } = await viewing();
    const { token } = await approveEmail(db, owner.email);
    const accepted = await callApi(
      app,
      "invites.accept",
      { token, password: "a new long password" },
      cookie
    );
    expect(accepted.code).toBe("FORBIDDEN");
    expect((await callApi(app, "invites.get", { token })).status).toBe(200);
  });
});

describe("ending views", () => {
  it("ends every view an admin has open when their role is removed", async () => {
    const { admin, cookie } = await viewing();
    const second = await aSignedInPerson(app, deps);
    await mutate("admin.impersonation.start", { email: second.email, reason: "two" }, admin.cookie);
    expect(await impersonatedSessions(admin.email)).toHaveLength(2);
    expect(await endImpersonationsBy(db, await idOf(admin.email))).toBe(2);
    expect(await impersonatedSessions(admin.email)).toEqual([]);
    expect((await callApi(app, "session.get", undefined, cookie)).data.person).toBeNull();
  });

  it("stops a view the moment the admin no longer has the role, whatever removed it", async () => {
    const { admin, owner, cookie } = await viewing();
    const project = await createProject(db, { name: "Theirs", tenantId: owner.tenantId });
    await db.update(users).set({ role: null }).where(eq(users.email, admin.email));
    expect((await callApi(app, "session.get", undefined, cookie)).data.person).toBeNull();
    expect(await upload(cookie, project.id)).toBe(401);
  });

  it("is not a side effect of signing the person out everywhere", async () => {
    const { owner, cookie } = await viewing();
    await removeApproval(db, owner.email);
    expect((await callApi(app, "session.get", undefined, cookie)).data.person.email).toBe(
      owner.email
    );
  });

  it("happens when the admin's own approval is removed", async () => {
    const { admin, cookie } = await viewing();
    await removeApproval(db, admin.email);
    expect(await impersonatedSessions(admin.email)).toEqual([]);
    expect((await callApi(app, "session.get", undefined, cookie)).data.person).toBeNull();
  });
});
