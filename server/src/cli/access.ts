// `make access/approve|list|remove|admin`: manages the prelaunch approved list and who has the
// platform admin role. The admin area (/admin) does the same; this is how the first admin is made,
// and how access is managed with no admin able to sign in. Every change is in the audit log.
// `make db/seed` (`seed`) makes the two local logins.
import { createDb } from "../db/client.ts";
import {
  approveAccess,
  grantAdmin,
  INVITE_DAYS,
  listApproved,
  removeAccess,
} from "../services/access.ts";
import { COMMAND_LINE, withAudit } from "../services/audit.ts";
import { authConfigFromEnv, createAuth, publicUrlFromEnv } from "../services/auth.ts";
import { findTenantBySlug } from "../services/businesses.ts";
import { DEV_LOGINS, DEV_PASSWORD, refuseUnlessLocal, seedDevLogins } from "../services/seed.ts";

const [command, email, tenant] = process.argv.slice(2);
const db = createDb(
  process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5440/schmeide"
);

const needEmail = (): string => {
  if (!email) throw new Error(`Usage: make access/${command} EMAIL=person@example.com`);
  return email;
};

try {
  if (command === "approve") {
    const { publicUrl } = authConfigFromEnv(process.env);
    const tenantId = tenant ? await findTenantBySlug(db, tenant) : undefined;
    // Recorded in the audit log as done from the command line, as the admin area records its own.
    const approved = await withAudit(db, COMMAND_LINE, "access.approve", (tx, audit) =>
      approveAccess(tx, audit, needEmail(), { tenantId })
    );
    console.log(
      `${approved.email} is approved. They can sign in with Google, Microsoft, or Apple.`
    );
    console.log(
      tenant
        ? `They work in the "${tenant}" business.`
        : "They get a business of their own the first time they sign in."
    );
    console.log(`To set a password, send them this link (one use, ${INVITE_DAYS} days):`);
    console.log(`${publicUrl}/set-password?token=${approved.token}`);
  } else if (command === "remove") {
    const { removed } = await withAudit(db, COMMAND_LINE, "access.remove", (tx, audit) =>
      removeAccess(tx, audit, needEmail())
    );
    console.log(
      removed ? `${email} is removed and signed out.` : `${email} was not on the approved list.`
    );
  } else if (command === "admin") {
    // Works with no admin at all, to make the first one or to rescue a deployment that lost its last.
    const granted = await grantAdmin(db, needEmail(), COMMAND_LINE);
    console.log(
      `${granted.email} is an admin. They see the admin area at /admin from their next page load.`
    );
  } else if (command === "seed") {
    const publicUrl = publicUrlFromEnv(process.env);
    // First, so a deployed address is refused for what it is, not for a missing secret.
    refuseUnlessLocal(publicUrl);
    await seedDevLogins({ db, auth: createAuth(db, authConfigFromEnv(process.env)) }, publicUrl);
    console.log(`Local logins at ${publicUrl}/sign-in, password ${DEV_PASSWORD}:`);
    console.log(`  ${DEV_LOGINS.admin.email}  admin, in no business`);
    console.log(`  ${DEV_LOGINS.owner.email}  owner of the demo business`);
  } else if (command === "list") {
    const approved = await listApproved(db);
    if (approved.length === 0) console.log("Nobody is approved yet.");
    for (const { email: address, hasAccount, admin } of approved)
      console.log(
        `${address}\t${hasAccount ? "has an account" : "has not signed in yet"}${admin ? "\tadmin" : ""}`
      );
  } else {
    throw new Error("Use one of: approve, list, remove, admin, seed");
  }
} catch (error) {
  console.error(`Error: ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  await db.$client.end();
}
