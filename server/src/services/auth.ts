// Sign-in: Better Auth over our Postgres, with Google, Microsoft, Apple, and email plus password.
// Prelaunch, only an address on the approved list (services/access.ts) gets an account or a
// session.
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import {
  accounts,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  rateLimits,
  sessions,
  users,
  verifications,
} from "../db/schema.ts";
import { isApproved } from "./access.ts";

export const PROVIDERS = ["google", "microsoft", "apple"] as const;
export type Provider = (typeof PROVIDERS)[number];
type Credentials = { readonly clientId: string; readonly clientSecret: string };

export type AuthConfig = {
  // Signs session cookies. At least 32 random characters.
  readonly secret: string;
  // The address people open in a browser, and where a provider sign-in returns them.
  readonly publicUrl: string;
  // Where `/api/auth` answers, as the browser sees it. The same as publicUrl behind one origin.
  readonly apiUrl: string;
  // A provider is offered only when its credentials are given.
  readonly providers: Partial<Record<Provider, Credentials>>;
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

export const createAuth = (db: Db, config: AuthConfig) =>
  betterAuth({
    appName: "Schmeide",
    secret: config.secret,
    baseURL: config.apiUrl,
    basePath: "/api/auth",
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
    disabledPaths: ["/sign-up/email"],
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
      session: {
        create: {
          // A password sign-in is not re-validated above, so a removed address is stopped here.
          before: async (session) => {
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
    advanced: { useSecureCookies: config.publicUrl.startsWith("https://") },
    telemetry: { enabled: false },
  });

export type Auth = ReturnType<typeof createAuth>;

export type Person = { readonly id: string; readonly name: string; readonly email: string };

// The signed-in, still-approved person behind a request, or null.
export const currentPerson = async (
  { auth, db }: { readonly auth: Auth; readonly db: Db },
  headers: Headers
): Promise<Person | null> => {
  const session = await auth.api.getSession({ headers });
  if (!session || !(await isApproved(db, session.user.email))) return null;
  const { id, name, email } = session.user;
  return { id, name, email };
};

export const enabledProviders = (config: Pick<AuthConfig, "providers">): readonly Provider[] =>
  PROVIDERS.filter((provider) => config.providers[provider]);

const DEV_SECRET = "schmeide-dev-only-secret-never-use-on-a-public-address";
const isLocal = (url: string) => /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(url);

// Reads the sign-in settings from the environment (docs/auth.md lists them). Throws with what
// to set when a public address has no secret.
export const authConfigFromEnv = (
  env: Readonly<Record<string, string | undefined>>
): AuthConfig => {
  const publicUrl = (env.SCHMEIDE_PUBLIC_URL ?? "http://localhost:5173").replace(/\/+$/, "");
  const apiUrl = (env.SCHMEIDE_API_URL ?? publicUrl).replace(/\/+$/, "");
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
  return {
    secret,
    publicUrl,
    apiUrl,
    providers: {
      google: credentials("GOOGLE"),
      microsoft: credentials("MICROSOFT"),
      apple: credentials("APPLE"),
    },
  };
};
