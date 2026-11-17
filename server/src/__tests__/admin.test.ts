import { afterAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.ts";
import { createDb } from "../db/client.ts";
import type { AppContext } from "../router.ts";
import {
  acceptInvite,
  approveEmail,
  grantAdmin,
  listApproved,
  removeApproval,
} from "../services/access.ts";
import { ADMIN_PLUGIN_PATHS } from "../services/auth.ts";
import {
  adminPaths,
  aSignedInAdmin,
  aSignedInPerson,
  anEmail,
  callApi,
  impersonationPaths,
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

// What tRPC itself answers for a path with no procedure behind it.
const noProcedure = (path: string) => ({
  status: 404,
  code: "NOT_FOUND",
  message: `No procedure found on path "${path}"`,
});
const answer = async (path: string, cookie = "") => {
  const { status, code, message } = await callApi(app, path, undefined, cookie);
  return { status, code, message };
};

describe("the admin procedures", () => {
  it("are found by walking the router", () => {
    expect(adminPaths).toContain("admin.whoami");
  });

  it("answer exactly as a missing procedure does to an owner and to a signed-out caller", async () => {
    const owner = await aSignedInPerson(app, deps);
    expect(await answer("admin.noSuchProcedure", owner.cookie)).toEqual(
      noProcedure("admin.noSuchProcedure")
    );
    for (const path of adminPaths) {
      expect(await answer(path, owner.cookie)).toEqual(noProcedure(path));
      expect(await answer(path)).toEqual(noProcedure(path));
    }
  });

  it("include starting to view as someone, and stopping is just as hidden outside a view", async () => {
    expect(adminPaths).toContain("admin.impersonation.start");
    expect(impersonationPaths).toEqual(["impersonation.stop"]);
    const owner = await aSignedInPerson(app, deps);
    const admin = await aSignedInAdmin(app, deps);
    // impersonation.test.ts shows it answering inside a view.
    for (const path of impersonationPaths)
      for (const cookie of [owner.cookie, admin.cookie, ""])
        expect(await answer(path, cookie)).toEqual(noProcedure(path));
  });

  it("answer an admin", async () => {
    const admin = await aSignedInAdmin(app, deps);
    const whoami = await callApi(app, "admin.whoami", undefined, admin.cookie);
    expect(whoami.data).toEqual({ name: "Grace Admin", email: admin.email });
  });

  it("stop answering an admin taken off the approved list", async () => {
    const admin = await aSignedInAdmin(app, deps);
    await removeApproval(db, admin.email);
    expect(await answer("admin.whoami", admin.cookie)).toEqual(noProcedure("admin.whoami"));
  });
});

describe("the session", () => {
  it("reports the admin role to an admin, who is given no business", async () => {
    const admin = await aSignedInAdmin(app, deps);
    const session = await callApi(app, "session.get", undefined, admin.cookie);
    expect(session.data.person).toEqual({ name: "Grace Admin", email: admin.email, role: "admin" });
    expect(session.data.businesses).toEqual([]);
    // A business procedure does not make one either.
    expect((await callApi(app, "projects.list", undefined, admin.cookie)).code).toBe("FORBIDDEN");
    const upload = await app.inject({
      method: "POST",
      url: "/api/projects/1/files?owner=mine",
      headers: { cookie: admin.cookie, "content-type": "text/plain" },
      payload: "a note",
    });
    expect([upload.statusCode, upload.json().error.code]).toEqual([403, "forbidden"]);
    expect((await callApi(app, "session.get", undefined, admin.cookie)).data.businesses).toEqual(
      []
    );
  });

  it("reports no role to an owner", async () => {
    const owner = await aSignedInPerson(app, deps);
    const session = await callApi(app, "session.get", undefined, owner.cookie);
    expect(session.data.person).not.toHaveProperty("role");
  });

  it("cannot be made an admin by the person themselves", async () => {
    const owner = await aSignedInPerson(app, deps);
    await app.inject({
      method: "POST",
      url: "/api/auth/update-user",
      headers: { cookie: owner.cookie, origin: TEST_ORIGIN },
      payload: { role: "admin" },
    });
    const session = await callApi(app, "session.get", undefined, owner.cookie);
    expect(session.data.person).not.toHaveProperty("role");
    expect(await answer("admin.whoami", owner.cookie)).toEqual(noProcedure("admin.whoami"));
  });
});

describe("Better Auth's admin endpoints", () => {
  it("are not served, even to an admin", async () => {
    expect(ADMIN_PLUGIN_PATHS).toEqual(
      expect.arrayContaining(["/admin/impersonate-user", "/admin/set-role", "/admin/create-user"])
    );
    const admin = await aSignedInAdmin(app, deps);
    for (const path of ADMIN_PLUGIN_PATHS) {
      const response = await app.inject({
        method: "POST",
        url: `/api/auth${path}`,
        headers: { cookie: admin.cookie, origin: TEST_ORIGIN },
        payload: {},
      });
      expect([path, response.statusCode]).toEqual([path, 404]);
    }
  });
});

describe("granting the admin role", () => {
  it("refuses an address that is not approved, saying what to run", async () => {
    const email = anEmail();
    await expect(grantAdmin(db, email)).rejects.toThrow(`make access/approve EMAIL=${email}`);
  });

  it("refuses an approved address with no account yet, saying what to do", async () => {
    const { email } = await approveEmail(db, anEmail());
    await expect(grantAdmin(db, email)).rejects.toThrow("has not signed in yet");
  });

  it("gives an approved person the role, which the approved list shows", async () => {
    const { email, token } = await approveEmail(db, anEmail());
    await acceptInvite(deps, { token, name: "Ada", password: PASSWORD });
    expect(await grantAdmin(db, email.toUpperCase())).toEqual({ email });
    const { cookie } = await signIn(app, email);
    expect(await callApi(app, "admin.whoami", undefined, cookie)).toMatchObject({ status: 200 });
    const listed = (await listApproved(db)).find((entry) => entry.email === email);
    expect(listed).toEqual({ email, hasAccount: true, admin: true });
  });
});
