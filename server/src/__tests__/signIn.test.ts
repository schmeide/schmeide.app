import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.ts";
import { createDb } from "../db/client.ts";
import { invites } from "../db/schema.ts";
import type { AppContext } from "../router.ts";
import { approveEmail, listApproved, removeApproval } from "../services/access.ts";
import { admit, authConfigFromEnv, REFUSED } from "../services/auth.ts";
import { TEST_ORIGIN, testAuth } from "./testAuth.ts";

const db = createDb(process.env.DATABASE_URL ?? "");
afterAll(() => db.$client.end());

const auth = testAuth(db);
const context: AppContext = {
  db,
  workflows: { start: vi.fn(), getHandle: vi.fn() as never },
  taskQueue: "test",
  interviewer: vi.fn(),
  auth,
  providers: ["google"],
};
const app = buildApp(context);
afterAll(() => app.close());

const anEmail = () => `person-${randomUUID()}@example.com`;
const PASSWORD = "correct horse battery";

const trpc = async (path: string, input: unknown, cookie = "") => {
  const isQuery = path.endsWith(".get");
  const response = await app.inject({
    method: isQuery ? "GET" : "POST",
    url: `/api/trpc/${path}${isQuery ? `?input=${encodeURIComponent(JSON.stringify({ json: input }))}` : ""}`,
    headers: { cookie },
    ...(isQuery ? {} : { payload: { json: input } }),
  });
  const body = response.json();
  return { status: response.statusCode, data: body.result?.data.json, error: body.error?.json };
};

// Signs in with a password; answers the status and the session cookie to send back.
const signIn = async (email: string, password = PASSWORD) => {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/sign-in/email",
    headers: { origin: TEST_ORIGIN },
    payload: { email, password },
  });
  const cookie = response.cookies.map(({ name, value }) => `${name}=${value}`).join("; ");
  return { status: response.statusCode, cookie, body: response.json() };
};

// An approved person who has set a password through their link.
const aPerson = async (name = "Ada Example") => {
  const { email, token } = await approveEmail(db, anEmail());
  await trpc("invites.accept", { token, name, password: PASSWORD });
  return email;
};

describe("the approved list", () => {
  it("refuses an address that is not on it", async () => {
    expect(await admit(db, { email: anEmail(), emailVerified: true }, "oauth")).toEqual({
      error: REFUSED.notApproved,
    });
  });

  it("admits an approved address whatever its capitals, once the provider vouches for it", async () => {
    const { email } = await approveEmail(db, anEmail());
    const typed = email.toUpperCase();
    expect(await admit(db, { email: typed, emailVerified: true }, "oauth")).toBeUndefined();
    expect(await admit(db, { email: typed, emailVerified: false }, "oauth")).toEqual({
      error: REFUSED.emailNotVerified,
    });
    expect(await admit(db, { email: typed }, "oauth")).toEqual({
      error: REFUSED.emailNotVerified,
    });
  });

  it("is the check Better Auth runs before it creates a user or links a provider", async () => {
    const validate = auth.options.user.validateUserInfo;
    const source = { method: "oauth", action: "create-user" } as const;
    const { email } = await approveEmail(db, anEmail());
    expect(await validate({ user: { email: anEmail(), emailVerified: true }, source })).toEqual({
      error: REFUSED.notApproved,
    });
    expect(await validate({ user: { email, emailVerified: true }, source })).toBeUndefined();
    expect(await listApproved(db)).toContainEqual({ email, hasAccount: false });
  });

  it("has no public password sign-up", async () => {
    const { email } = await approveEmail(db, anEmail());
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      headers: { origin: TEST_ORIGIN },
      payload: { email, name: "Mallory", password: PASSWORD },
    });
    expect(response.statusCode).toBe(404);
    expect((await signIn(email)).status).toBe(401);
  });
});

describe("an invite link", () => {
  it("opens an account, signs the person in, and works only once", async () => {
    const { email, token } = await approveEmail(db, anEmail());
    expect((await trpc("invites.get", { token })).data).toEqual({ email, hasAccount: false });

    const accepted = await trpc("invites.accept", {
      token,
      name: "Ada Example",
      password: PASSWORD,
    });
    expect(accepted.data).toEqual({ email });

    const { status, cookie } = await signIn(email);
    expect(status).toBe(200);
    expect(cookie).not.toBe("");
    expect((await trpc("session.get", undefined, cookie)).data).toEqual({
      person: { name: "Ada Example", email },
      businesses: [{ id: 1, name: "Demo business" }],
      providers: ["google"],
    });

    expect((await trpc("invites.get", { token })).error.data.code).toBe("NOT_FOUND");
    const again = await trpc("invites.accept", {
      token,
      name: "Eve",
      password: "another password",
    });
    expect(again.error.data.code).toBe("NOT_FOUND");
    expect((await signIn(email, "another password")).status).toBe(401);
  });

  it("is not spent when a new person leaves out their name", async () => {
    const { token } = await approveEmail(db, anEmail());
    const nameless = await trpc("invites.accept", { token, password: PASSWORD });
    expect(nameless.error.data.code).toBe("NOT_FOUND");
    expect((await trpc("invites.get", { token })).data).toMatchObject({ hasAccount: false });
  });

  it("refuses a short password", async () => {
    const { token } = await approveEmail(db, anEmail());
    const short = await trpc("invites.accept", { token, name: "Ada", password: "short" });
    expect(short.error.data.code).toBe("BAD_REQUEST");
  });

  it("stops working after it expires", async () => {
    const { email, token } = await approveEmail(db, anEmail());
    await db
      .update(invites)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(invites.email, email));
    expect((await trpc("invites.get", { token })).error.data.code).toBe("NOT_FOUND");
    const late = await trpc("invites.accept", { token, name: "Ada", password: PASSWORD });
    expect(late.error.data.code).toBe("NOT_FOUND");
  });

  it("stops working when a newer link is made or the address is removed", async () => {
    const first = await approveEmail(db, anEmail());
    const second = await approveEmail(db, first.email);
    expect((await trpc("invites.get", { token: first.token })).error.data.code).toBe("NOT_FOUND");
    expect((await trpc("invites.get", { token: second.token })).data).toBeDefined();

    await removeApproval(db, first.email);
    expect((await trpc("invites.get", { token: second.token })).error.data.code).toBe("NOT_FOUND");
  });

  it("resets the password of an existing account and ends its sessions", async () => {
    const email = await aPerson();
    const before = await signIn(email);
    const { token } = await approveEmail(db, email);
    expect((await trpc("invites.get", { token })).data).toEqual({ email, hasAccount: true });

    await trpc("invites.accept", { token, password: "a brand new password" });

    expect((await trpc("session.get", undefined, before.cookie)).data.person).toBeNull();
    expect((await signIn(email)).status).toBe(401);
    expect((await signIn(email, "a brand new password")).status).toBe(200);
  });
});

describe("a session", () => {
  it("is signed out without a cookie, and still says which providers are on", async () => {
    expect((await trpc("session.get", undefined)).data).toEqual({
      person: null,
      businesses: [],
      providers: ["google"],
    });
  });

  it("does not start with a wrong password", async () => {
    const email = await aPerson();
    const { status, cookie } = await signIn(email, "not the password");
    expect(status).toBe(401);
    expect(cookie).toBe("");
  });

  it("ends when the address is taken off the approved list, and cannot start again", async () => {
    const email = await aPerson();
    const { cookie } = await signIn(email);
    expect((await trpc("session.get", undefined, cookie)).data.person).not.toBeNull();

    expect(await removeApproval(db, email)).toBe(true);

    expect((await trpc("session.get", undefined, cookie)).data.person).toBeNull();
    const retry = await signIn(email);
    expect(retry.status).toBe(403);
    expect(retry.body.code).toBe(REFUSED.notApproved);
  });

  it("ends on sign-out", async () => {
    const email = await aPerson();
    const { cookie } = await signIn(email);
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/sign-out",
      headers: { origin: TEST_ORIGIN, cookie },
    });
    expect(response.statusCode).toBe(200);
    expect((await trpc("session.get", undefined, cookie)).data.person).toBeNull();
  });

  it("uses a cookie that scripts cannot read and other sites cannot send", async () => {
    const email = await aPerson();
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { origin: TEST_ORIGIN },
      payload: { email, password: PASSWORD },
    });
    const session = response.cookies.find(({ name }) => name.includes("session_token"));
    expect(session).toMatchObject({ httpOnly: true, sameSite: "Lax" });
    expect(session).not.toHaveProperty("domain");
  });

  it("limits sign-in attempts", async () => {
    const limited = buildApp({ ...context, auth: testAuth(db, { rateLimit: true }) });
    const email = anEmail();
    const attempt = () =>
      limited.inject({
        method: "POST",
        url: "/api/auth/sign-in/email",
        headers: { origin: TEST_ORIGIN, "x-forwarded-for": "203.0.113.9" },
        payload: { email, password: "guess guess guess" },
      });
    const statuses = [];
    for (let i = 0; i < 6; i++) statuses.push((await attempt()).statusCode);
    await limited.close();
    expect(statuses).toContain(429);
  });
});

describe("sign-in settings", () => {
  it("needs a secret once the address is public", () => {
    expect(() => authConfigFromEnv({ SCHMEIDE_PUBLIC_URL: "https://schmeide.app" })).toThrow(
      /SCHMEIDE_AUTH_SECRET/
    );
    expect(authConfigFromEnv({}).publicUrl).toBe("http://localhost:5173");
  });

  it("turns a provider on only when both of its values are set", () => {
    const { providers } = authConfigFromEnv({
      SCHMEIDE_GOOGLE_CLIENT_ID: "id",
      SCHMEIDE_GOOGLE_CLIENT_SECRET: "secret",
      SCHMEIDE_APPLE_CLIENT_ID: "id",
    });
    expect(providers.google).toEqual({ clientId: "id", clientSecret: "secret" });
    expect(providers.apple).toBeUndefined();
  });
});
