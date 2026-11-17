// Sign-in: Better Auth over our Postgres, with Google, Microsoft, Apple, an Auth0 tenant, and
// email plus password.
// Prelaunch, only an address on the approved list (services/access.ts) gets an account or a
// session.
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin } from "better-auth/plugins/admin";
import { auth0, genericOAuth } from "better-auth/plugins/generic-oauth";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import {
  accounts,
  ADMIN_ROLE,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  rateLimits,
  sessions,
  users,
  verifications,
} from "../db/schema.ts";
import { claimPendingAdmin, isApproved } from "./access.ts";

export const PROVIDERS = ["google", "microsoft", "apple", "auth0"] as const;
export type Provider = (typeof PROVIDERS)[number];
type Credentials = { readonly clientId: string; readonly clientSecret: string };
// Auth0 is a tenant of ours, not one address for everyone: `domain` says which, like
// `schmeide.us.auth0.com`.
type Auth0Credentials = Credentials & { readonly domain: string };
type ProviderCredentials = Readonly<Record<Exclude<Provider, "auth0">, Credentials>> & {
  readonly auth0: Auth0Credentials;
};

export type AuthConfig = {
  // Signs session cookies. At least 32 random characters.
  readonly secret: string;
  // The address people open in a browser, and where a provider sign-in returns them.
  readonly publicUrl: string;
  // Where the API answers, as the browser sees it: `<publicUrl>/api` behind one origin (Vite
  // strips the /api in `make serve`), or the API's own address (https://api.schmeide.app).
  readonly apiUrl: string;
  // A provider is offered only when its credentials are given.
  readonly providers: Partial<ProviderCredentials>;
  // Off only in tests that sign in many times.
  readonly rateLimit?: boolean;
};

// Why a person was refused, as the `error` value on the address a provider sign-in returns to.
export const REFUSED = {
  notApproved: "not_approved",
  emailNotVerified: "email_not_verified",
} as const;

type Candidate = { readonly email?: unknown; readonly emailVerified?: unknown };

// Decides whether an identity may become or stay a user. A provider must vouch for the email:
// Microsoft work accounts can carry any address their own admin typed in.
export const admit = async (
  db: Db,
  user: Candidate,
  method: string
): Promise<{ readonly error: string } | undefined> => {
  if (typeof user.email !== "string" || !(await isApproved(db, user.email)))
    return { error: REFUSED.notApproved };
  if (method === "oauth" && user.emailVerified !== true) return { error: REFUSED.emailNotVerified };
  return undefined;
};

// The admin behind a session that views the app as someone else.
export type Impersonator = { readonly id: string; readonly name: string; readonly email: string };

// The admin `adminId` names, while they still have the role and are approved, and are not the
// person being viewed. Null otherwise: the view is over.
const impersonator = async (
  db: Db,
  adminId: string,
  personId: string
): Promise<Impersonator | null> => {
  const [admin] = await db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .where(and(eq(users.id, adminId), eq(users.role, ADMIN_ROLE)));
  return admin && admin.id !== personId && (await isApproved(db, admin.email)) ? admin : null;
};

// How long an admin may view the app as someone else (docs/auth.md), counted from the start.
export const IMPERSONATION_SECONDS = 3600;

// Where the server answers Better Auth's routes.
export const AUTH_PATH = "/auth";

// The only `/auth` route a session an admin is viewing through answers. Everything else,
// a route a Better Auth upgrade adds included, is refused (app.ts): changing the password or
// email, linking a provider, deleting the account, ending sessions, and signing in or out.
export const AUTH_PATHS_WHILE_IMPERSONATING: readonly string[] = ["/get-session"];

// Better Auth's admin plugin gives the role, bans, and impersonation (the admin behind a session,
// an hour at most). Its own HTTP endpoints are all refused: an admin acts only through the
// `admin` procedures (router.ts), which call `auth.api` on the server.
const adminPlugin = admin({
  adminRoles: [ADMIN_ROLE],
  impersonationSessionDuration: IMPERSONATION_SECONDS,
});
export const ADMIN_PLUGIN_PATHS = Object.values(adminPlugin.endpoints).map(({ path }) => path);

export const createAuth = (db: Db, config: AuthConfig) =>
  betterAuth({
    appName: "Schmeide",
    secret: config.secret,
    // The address the browser and providers use, so provider returns go back the way they came.
    // Better Auth takes a baseURL that has a path as it is, and answers below it.
    baseURL: `${config.apiUrl}${AUTH_PATH}`,
    basePath: AUTH_PATH,
    // Apple answers with a form post from its own origin.
    trustedOrigins: [
      config.publicUrl,
      ...(config.providers.apple ? ["https://appleid.apple.com"] : []),
    ],
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: {
        user: users,
        session: sessions,
        account: accounts,
        verification: verifications,
        rateLimit: rateLimits,
      },
    }),
    // No public sign-up: a password account opens only through an invite link, or anyone could
    // claim an approved address by knowing it.
    disabledPaths: ["/sign-up/email", ...ADMIN_PLUGIN_PATHS],
    plugins: [
      adminPlugin,
      // Auth0 signs in through the same `/sign-in/social` and `/callback/auth0` routes as the
      // providers below, so `validateUserInfo` decides for it too. Signing out here leaves the
      // person signed in at Auth0, as it leaves them signed in at Google.
      ...(config.providers.auth0
        ? [
            genericOAuth({
              config: [auth0({ ...config.providers.auth0, disableProviderLogout: true })],
            }),
          ]
        : []),
    ],
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: MIN_PASSWORD_LENGTH,
      maxPasswordLength: MAX_PASSWORD_LENGTH,
    },
    socialProviders: {
      ...(config.providers.google && { google: config.providers.google }),
      ...(config.providers.microsoft && {
        microsoft: { ...config.providers.microsoft, tenantId: "common", disableProfilePhoto: true },
      }),
      ...(config.providers.apple && { apple: config.providers.apple }),
    },
    user: {
      // Runs before a user is created, a provider is linked, and on every provider sign-in.
      validateUserInfo: ({ user, source }) => admit(db, user, source.method),
    },
    databaseHooks: {
      user: {
        create: {
          // A first provider sign-in makes the account here. It has the admin role only when an
          // admin made the address an admin before it had one; whatever else asks for the role,
          // the admin plugin's default included, is dropped. An invite link makes its account in
          // `acceptInvite` (services/access.ts), which asks the same.
          before: async (user) => ({
            data: { ...user, role: (await claimPendingAdmin(db, user.email)) ? ADMIN_ROLE : null },
          }),
        },
      },
      session: {
        create: {
          // A password sign-in is not re-validated above, so a removed address is stopped here.
          before: async (session) => {
            // A session an admin views through. Only the plugin's server-side
            // `impersonateUser` sets this (it is not an input), and only `admin.impersonation.start`
            // calls that: the admin must still have the role and be approved, the person need not.
            if (session.impersonatedBy) {
              if (!(await impersonator(db, String(session.impersonatedBy), session.userId)))
                throw new APIError("FORBIDDEN", { message: "Only an admin can view as someone" });
              return;
            }
            const [user] = await db
              .select({ email: users.email })
              .from(users)
              .where(eq(users.id, session.userId));
            if (!user || !(await isApproved(db, user.email)))
              throw new APIError("FORBIDDEN", {
                code: REFUSED.notApproved,
                message: "This email is not on the prelaunch list",
              });
          },
        },
      },
    },
    rateLimit: { enabled: config.rateLimit ?? true, storage: "database" },
    // A refused provider sign-in returns to the sign-in page with `?error=<reason>`.
    onAPIError: { errorURL: `${config.publicUrl}/sign-in` },
    advanced: {
      useSecureCookies: config.publicUrl.startsWith("https://"),
      // Said outright, because Better Auth turns both checks off by itself under a test runner:
      // a request that carries cookies must come from one of the trusted origins above.
      disableOriginCheck: false,
      disableCSRFCheck: false,
    },
    telemetry: { enabled: false },
  });

export type Auth = ReturnType<typeof createAuth>;

export type Person = {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  // Has the platform role: may call the `admin` procedures. Never while being viewed as.
  readonly admin: boolean;
  // Set when this is an admin viewing the app as the person.
  readonly impersonatedBy?: Impersonator;
};

// The signed-in, still-approved person behind a request, or null. A session an admin views
// through is the person, approved or not, while the admin still qualifies and within the hour
// from its start. Its expiry is not trusted for that: Better Auth renews a session that is used.
// A view that is over is deleted here, so nothing is left behind to refuse a fresh sign-in.
export const currentPerson = async (
  { auth, db }: { readonly auth: Auth; readonly db: Db },
  headers: Headers,
  now = new Date()
): Promise<Person | null> => {
  const found = await auth.api.getSession({ headers });
  if (!found) return null;
  const { id, name, email, role } = found.user;
  const { impersonatedBy, createdAt } = found.session;
  if (!impersonatedBy)
    return (await isApproved(db, email)) ? { id, name, email, admin: role === ADMIN_ROLE } : null;
  const within = now.getTime() < new Date(createdAt).getTime() + IMPERSONATION_SECONDS * 1000;
  const admin = within ? await impersonator(db, impersonatedBy, id) : null;
  if (!admin) {
    await db.delete(sessions).where(eq(sessions.id, found.session.id));
    return null;
  }
  return { id, name, email, admin: false, impersonatedBy: admin };
};

export const enabledProviders = (config: Pick<AuthConfig, "providers">): readonly Provider[] =>
  PROVIDERS.filter((provider) => config.providers[provider]);

const DEV_SECRET = "schmeide-dev-only-secret-never-use-on-a-public-address";
// Whether the address is this machine. Only there is the dev secret, or a seeded login, allowed.
export const isLocal = (url: string) => /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(url);

// The address people open in a browser, without a trailing slash.
export const publicUrlFromEnv = (env: Readonly<Record<string, string | undefined>>): string =>
  (env.SCHMEIDE_PUBLIC_URL ?? "http://localhost:5173").replace(/\/+$/, "");

// Reads the sign-in settings from the environment (docs/auth.md lists them). Throws with what
// to set when a public address has no secret.
export const authConfigFromEnv = (
  env: Readonly<Record<string, string | undefined>>
): AuthConfig => {
  const publicUrl = publicUrlFromEnv(env);
  const apiUrl = (env.SCHMEIDE_API_URL ?? `${publicUrl}/api`).replace(/\/+$/, "");
  const secret = env.SCHMEIDE_AUTH_SECRET ?? (isLocal(publicUrl) ? DEV_SECRET : undefined);
  if (!secret || secret.length < 32)
    throw new Error(
      "SCHMEIDE_AUTH_SECRET must be set to at least 32 random characters when SCHMEIDE_PUBLIC_URL is not localhost. Make one with: openssl rand -base64 32"
    );
  const credentials = (name: string): Credentials | undefined => {
    const clientId = env[`SCHMEIDE_${name}_CLIENT_ID`];
    const clientSecret = env[`SCHMEIDE_${name}_CLIENT_SECRET`];
    return clientId && clientSecret ? { clientId, clientSecret } : undefined;
  };
  const auth0Credentials = credentials("AUTH0");
  const auth0Domain = env.SCHMEIDE_AUTH0_DOMAIN;
  return {
    secret,
    publicUrl,
    apiUrl,
    providers: {
      google: credentials("GOOGLE"),
      microsoft: credentials("MICROSOFT"),
      apple: credentials("APPLE"),
      auth0:
        auth0Credentials && auth0Domain ? { ...auth0Credentials, domain: auth0Domain } : undefined,
    },
  };
};
