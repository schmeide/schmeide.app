import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.ts";
import { createDb } from "../db/client.ts";
import { accounts, invites, users } from "../db/schema.ts";
import type { AppContext } from "../router.ts";
import { approveEmail, listApproved, removeApproval } from "../services/access.ts";
import { admit, authConfigFromEnv, enabledProviders, REFUSED } from "../services/auth.ts";
import {
  anEmail,
  callApi,
  PASSWORD,
  signIn as signInTo,
  TEST_ORIGIN,
  testAuth,
} from "./testAuth.ts";

const AUTH0_DOMAIN = "schmeide-test.us.auth0.com";

const db = createDb(process.env.DATABASE_URL ?? "");
afterAll(() => db.$client.end());

const auth = testAuth(db);
const context: AppContext = {
  db,
  workflows: { start: vi.fn(), getHandle: vi.fn() as never },
  taskQueue: "test",
  interviewer: vi.fn(),
  siteFetcher: vi.fn(),
  websiteReader: vi.fn(),
  files: {} as never,
  reader: vi.fn(),
  resources: {} as never,
  auth,
  providers: ["google"],
};
const app = buildApp(context);
afterAll(() => app.close());

const trpc = (path: string, input?: unknown, cookie = "") => callApi(app, path, input, cookie);
const signIn = (email: string, password?: string) => signInTo(app, email, password);

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
    expect(await listApproved(db)).toContainEqual({ email, hasAccount: false, admin: false });
  });

  it("has no public password sign-up", async () => {
    const { email } = await approveEmail(db, anEmail());
    const response = await app.inject({
      method: "POST",
      url: "/auth/sign-up/email",
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
    expect((await trpc("invites.get", { token })).data).toEqual({
      email,
      hasAccount: false,
      business: null,
    });

    const accepted = await trpc("invites.accept", {
      token,
      name: "Ada Example",
      password: PASSWORD,
    });
    expect(accepted.data).toEqual({ email });

    const { status, cookie } = await signIn(email);
    expect(status).toBe(200);
    expect(cookie).not.toBe("");
    expect((await trpc("session.get", undefined, cookie)).data).toMatchObject({
      person: { name: "Ada Example", email },
      providers: ["google"],
    });

    expect((await trpc("invites.get", { token })).code).toBe("NOT_FOUND");
    const again = await trpc("invites.accept", {
      token,
      name: "Eve",
      password: "another password",
    });
    expect(again.code).toBe("NOT_FOUND");
    expect((await signIn(email, "another password")).status).toBe(401);
  });

  it("is not spent when a new person leaves out their name", async () => {
    const { token } = await approveEmail(db, anEmail());
    const nameless = await trpc("invites.accept", { token, password: PASSWORD });
    expect(nameless.code).toBe("NOT_FOUND");
    expect((await trpc("invites.get", { token })).data).toMatchObject({ hasAccount: false });
  });

  it("refuses a short password", async () => {
    const { token } = await approveEmail(db, anEmail());
    const short = await trpc("invites.accept", { token, name: "Ada", password: "short" });
    expect(short.code).toBe("BAD_REQUEST");
  });

  it("stops working after it expires", async () => {
    const { email, token } = await approveEmail(db, anEmail());
    await db
      .update(invites)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(invites.email, email));
    expect((await trpc("invites.get", { token })).code).toBe("NOT_FOUND");
    const late = await trpc("invites.accept", { token, name: "Ada", password: PASSWORD });
    expect(late.code).toBe("NOT_FOUND");
  });

  it("stops working when a newer link is made or the address is removed", async () => {
    const first = await approveEmail(db, anEmail());
    const second = await approveEmail(db, first.email);
    expect((await trpc("invites.get", { token: first.token })).code).toBe("NOT_FOUND");
    expect((await trpc("invites.get", { token: second.token })).data).toBeDefined();

    await removeApproval(db, first.email);
    expect((await trpc("invites.get", { token: second.token })).code).toBe("NOT_FOUND");
  });

  it("resets the password of an existing account and ends its sessions", async () => {
    const email = await aPerson();
    const before = await signIn(email);
    const { token } = await approveEmail(db, email);
    expect((await trpc("invites.get", { token })).data).toEqual({
      email,
      hasAccount: true,
      business: null,
    });

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
      impersonatedBy: null,
      businesses: [],
      providers: ["google"],
      buildsOff: false,
      canBuild: false,
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
      url: "/auth/sign-out",
      headers: { origin: TEST_ORIGIN, cookie },
    });
    expect(response.statusCode).toBe(200);
    expect((await trpc("session.get", undefined, cookie)).data.person).toBeNull();
  });

  it("uses a cookie that scripts cannot read and other sites cannot send", async () => {
    const { cookies } = await signIn(await aPerson());
    const session = cookies.find(({ name }) => name.includes("session_token"));
    expect(session).toMatchObject({ httpOnly: true, sameSite: "Lax" });
    expect(session).not.toHaveProperty("domain");
  });

  it("limits sign-in attempts", async () => {
    const limited = buildApp({ ...context, auth: testAuth(db, { rateLimit: true }) });
    const email = anEmail();
    const attempt = () =>
      limited.inject({
        method: "POST",
        url: "/auth/sign-in/email",
        headers: { origin: TEST_ORIGIN, "x-forwarded-for": "203.0.113.9" },
        payload: { email, password: "guess guess guess" },
      });
    const statuses = [];
    for (let i = 0; i < 6; i++) statuses.push((await attempt()).statusCode);
    await limited.close();
    expect(statuses).toContain(429);
  });
});

describe("a provider sign-in", () => {
  // The address the provider is told to send the person back to: the one registered with it.
  const returnAddress = async (apiUrl?: string) => {
    const google = { clientId: "id", clientSecret: "secret" };
    const withGoogle = buildApp({
      ...context,
      auth: testAuth(db, { providers: { google }, ...(apiUrl && { apiUrl }) }),
    });
    const response = await withGoogle.inject({
      method: "POST",
      url: "/auth/sign-in/social",
      headers: { origin: TEST_ORIGIN },
      payload: { provider: "google", callbackURL: `${TEST_ORIGIN}/` },
    });
    await withGoogle.close();
    expect(response.statusCode).toBe(200);
    return new URL(response.json().url).searchParams.get("redirect_uri");
  };

  it("returns through the site's /api in `make serve`", async () => {
    expect(await returnAddress()).toBe(`${TEST_ORIGIN}/api/auth/callback/google`);
  });

  it("returns to the API's own address when it has one", async () => {
    expect(await returnAddress("https://api.schmeide.app")).toBe(
      "https://api.schmeide.app/auth/callback/google"
    );
  });
});

describe("sign-in settings", () => {
  it("needs a secret once the address is public", () => {
    expect(() => authConfigFromEnv({ SCHMEIDE_PUBLIC_URL: "https://schmeide.app" })).toThrow(
      /SCHMEIDE_AUTH_SECRET/
    );
    expect(authConfigFromEnv({}).publicUrl).toBe("http://localhost:5173");
  });

  it("reaches the API through the site's /api unless told where it is", () => {
    expect(authConfigFromEnv({}).apiUrl).toBe("http://localhost:5173/api");
    expect(
      authConfigFromEnv({
        SCHMEIDE_PUBLIC_URL: "https://schmeide.app",
        SCHMEIDE_API_URL: "https://api.schmeide.app/",
        SCHMEIDE_AUTH_SECRET: "x".repeat(32),
      }).apiUrl
    ).toBe("https://api.schmeide.app");
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

  it("turns Auth0 on only when its domain is set as well", () => {
    const values = { SCHMEIDE_AUTH0_CLIENT_ID: "id", SCHMEIDE_AUTH0_CLIENT_SECRET: "secret" };
    expect(authConfigFromEnv(values).providers.auth0).toBeUndefined();

    const config = authConfigFromEnv({ ...values, SCHMEIDE_AUTH0_DOMAIN: AUTH0_DOMAIN });
    expect(config.providers.auth0).toEqual({
      clientId: "id",
      clientSecret: "secret",
      domain: AUTH0_DOMAIN,
    });
    expect(enabledProviders(config)).toEqual(["auth0"]);
  });
});

describe("sign-in with Auth0", () => {
  afterEach(() => vi.unstubAllGlobals());

  // Auth0's own description of itself, which the server reads once to find its addresses.
  const discovery = {
    issuer: `https://${AUTH0_DOMAIN}/`,
    authorization_endpoint: `https://${AUTH0_DOMAIN}/authorize`,
    token_endpoint: `https://${AUTH0_DOMAIN}/oauth/token`,
    userinfo_endpoint: `https://${AUTH0_DOMAIN}/userinfo`,
    jwks_uri: `https://${AUTH0_DOMAIN}/.well-known/jwks.json`,
    end_session_endpoint: `https://${AUTH0_DOMAIN}/oidc/logout`,
    id_token_signing_alg_values_supported: ["RS256"],
  };

  const withAuth0 = () => {
    const asked: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      asked.push(String(input instanceof Request ? input.url : input));
      return Response.json(discovery);
    });
    const auth0 = { clientId: "auth0-client", clientSecret: "auth0-secret", domain: AUTH0_DOMAIN };
    const server = buildApp({ ...context, auth: testAuth(db, { providers: { auth0 } }) });
    return { server, asked };
  };

  it("sends the person to the Auth0 tenant, to return to the same address as any provider", async () => {
    const { server, asked } = withAuth0();
    const response = await server.inject({
      method: "POST",
      url: "/auth/sign-in/social",
      headers: { origin: TEST_ORIGIN },
      payload: { provider: "auth0", callbackURL: `${TEST_ORIGIN}/usage` },
    });
    await server.close();

    expect(response.statusCode).toBe(200);
    const url = new URL(response.json().url);
    expect(url.origin + url.pathname).toBe(discovery.authorization_endpoint);
    expect(url.searchParams.get("client_id")).toBe("auth0-client");
    expect(url.searchParams.get("redirect_uri")).toBe(`${TEST_ORIGIN}/api/auth/callback/auth0`);
    expect(url.searchParams.get("scope")?.split(" ")).toEqual(
      expect.arrayContaining(["openid", "email"])
    );
    expect(asked).toEqual([`https://${AUTH0_DOMAIN}/.well-known/openid-configuration`]);
  });

  it("leaves the Auth0 session alone on sign-out, as with every other provider", async () => {
    const { server } = withAuth0();
    const email = await aPerson();
    const [user] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
    await db.insert(accounts).values({
      id: randomUUID(),
      userId: user.id,
      providerId: "auth0",
      accountId: `auth0|${randomUUID()}`,
    });
    const { cookie } = await signInTo(server, email);
    const response = await server.inject({
      method: "POST",
      url: "/auth/sign-out",
      headers: { origin: TEST_ORIGIN, cookie },
    });
    await server.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: true });
    expect(response.headers.location).toBeUndefined();
  });
});
