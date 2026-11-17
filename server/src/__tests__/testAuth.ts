import { randomUUID } from "node:crypto";
import type { buildApp } from "../app.ts";
import type { Db } from "../db/client.ts";
import { appRouter } from "../router.ts";
import { acceptInvite, approveEmail, grantAdmin } from "../services/access.ts";
import { COMMAND_LINE } from "../services/audit.ts";
import { createAuth, type Auth, type AuthConfig } from "../services/auth.ts";

type App = ReturnType<typeof buildApp>;

// The tenant the migrations seed (`demo`), for tests below the API that only need some business.
export const DEMO_TENANT_ID = 1;

export const TEST_ORIGIN = "http://localhost:5173";
export const PASSWORD = "correct horse battery";
export const anEmail = () => `person-${randomUUID()}@example.com`;

// Sign-in as the tests use it: no providers and no rate limit unless a test asks.
export const testAuth = (db: Db, overrides: Partial<AuthConfig> = {}) =>
  createAuth(db, {
    secret: "test-secret-test-secret-test-secret-test",
    publicUrl: TEST_ORIGIN,
    apiUrl: TEST_ORIGIN,
    providers: {},
    rateLimit: false,
    ...overrides,
  });

// At run time the keys are the dotted paths ("projects.get"), whatever the nested type says.
const procedures = appRouter._def.procedures as unknown as Readonly<
  Record<string, { readonly _def: { readonly type: string } }>
>;
export const procedurePaths = Object.keys(procedures);
// The procedures on the admin base (router.ts): everything under `admin`.
export const adminPaths = procedurePaths.filter((path) => path.startsWith("admin."));
// The procedures only a session an admin views the app through can call (router.ts).
export const impersonationPaths = procedurePaths.filter((path) =>
  path.startsWith("impersonation.")
);
export const mutationPaths = procedurePaths.filter(
  (path) => procedures[path]._def.type === "mutation"
);

// Calls one procedure over HTTP as the browser would, with the session cookie when given.
export const callApi = async (
  app: App,
  path: string,
  input?: unknown,
  cookie = "",
  headers: Readonly<Record<string, string>> = {}
) => {
  // A path with no procedure is asked as a query, as a link to it would be.
  const isQuery = (procedures[path]?._def.type ?? "query") === "query";
  const query = `?input=${encodeURIComponent(JSON.stringify({ json: input }))}`;
  const response = await app.inject({
    method: isQuery ? "GET" : "POST",
    url: `/api/trpc/${path}${isQuery ? query : ""}`,
    headers: { cookie, ...headers },
    ...(isQuery ? {} : { payload: { json: input } }),
  });
  const body = response.json();
  return {
    status: response.statusCode,
    data: body.result?.data.json,
    code: body.error?.json.data.code as string | undefined,
    message: body.error?.json.message as string | undefined,
  };
};

// Signs in with a password; answers the status and the session cookie to send back.
export const signIn = async (app: App, email: string, password = PASSWORD) => {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/sign-in/email",
    headers: { origin: TEST_ORIGIN },
    payload: { email, password },
  });
  const cookie = response.cookies.map(({ name, value }) => `${name}=${value}`).join("; ");
  return { status: response.statusCode, cookie, body: response.json(), cookies: response.cookies };
};

// An approved person who has set a password through their link and signed in. `tenantId` is the
// business they work in: their own unless the approval named one.
export const aSignedInPerson = async (
  app: App,
  deps: { readonly auth: Auth; readonly db: Db },
  { name = "Ada Example", joins }: { readonly name?: string; readonly joins?: number } = {}
) => {
  const { email, token } = await approveEmail(deps.db, anEmail(), { tenantId: joins });
  await acceptInvite(deps, { token, name, password: PASSWORD });
  const { cookie } = await signIn(app, email);
  const session = await callApi(app, "session.get", undefined, cookie);
  const businesses: readonly { readonly id: number; readonly name: string }[] =
    session.data.businesses;
  return { email, cookie, tenantId: businesses[0].id, businesses };
};

// An approved person with the platform admin role, signed in, and in no business.
export const aSignedInAdmin = async (app: App, deps: { readonly auth: Auth; readonly db: Db }) => {
  const { email, token } = await approveEmail(deps.db, anEmail());
  await acceptInvite(deps, { token, name: "Grace Admin", password: PASSWORD });
  await grantAdmin(deps.db, email, COMMAND_LINE);
  const { cookie } = await signIn(app, email);
  return { email, cookie };
};
