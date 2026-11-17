// `make db/seed`: two logins with a known password for working on this machine, made the way real
// accounts are made. Only ever on localhost, so the password never reaches a deployed database.
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { ADMIN_ROLE, users } from "../db/schema.ts";
import { acceptInvite, approveEmail, grantAdmin } from "./access.ts";
import { COMMAND_LINE } from "./audit.ts";
import { isLocal, type Auth } from "./auth.ts";
import { findTenantBySlug, joinBusiness } from "./businesses.ts";

export const DEV_PASSWORD = "schmeide-local-only";
export const DEV_LOGINS = {
  admin: { email: "admin@schmeide.localhost", name: "Local Admin" },
  owner: { email: "owner@schmeide.localhost", name: "Local Owner" },
} as const;

// Throws, before anything is written, unless the public address is this machine.
export const refuseUnlessLocal = (publicUrl: string): void => {
  if (!isLocal(publicUrl))
    throw new Error(
      `make db/seed only runs when SCHMEIDE_PUBLIC_URL is localhost (it is ${publicUrl}): it makes logins with a known password. For a real environment, run \`make access/approve EMAIL=you@example.com\`, set a password through the link it prints, then \`make access/admin EMAIL=you@example.com\`.`
    );
};

const userByEmail = async (db: Db, email: string) => {
  const [user] = await db
    .select({ id: users.id, role: users.role })
    .from(users)
    .where(eq(users.email, email));
  return user;
};

// Opens the account when the address has none. An existing account, its password and its
// sessions are left alone.
const ensureLogin = async (
  deps: { readonly auth: Auth; readonly db: Db },
  { email, name }: { readonly email: string; readonly name: string },
  tenantId?: number
) => {
  const existing = await userByEmail(deps.db, email);
  if (existing) return existing;
  const { token } = await approveEmail(deps.db, email, { tenantId });
  await acceptInvite(deps, { token, name, password: DEV_PASSWORD });
  return (await userByEmail(deps.db, email))!;
};

// The admin (in no business) and the owner of `demo`. Adds only what is missing.
export const seedDevLogins = async (
  deps: { readonly auth: Auth; readonly db: Db },
  publicUrl: string
): Promise<void> => {
  refuseUnlessLocal(publicUrl);
  const admin = await ensureLogin(deps, DEV_LOGINS.admin);
  if (admin.role !== ADMIN_ROLE) await grantAdmin(deps.db, DEV_LOGINS.admin.email, COMMAND_LINE);
  const demo = await findTenantBySlug(deps.db, "demo");
  const owner = await ensureLogin(deps, DEV_LOGINS.owner, demo);
  await joinBusiness(deps.db, owner.id, demo, "owner");
};
