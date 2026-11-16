// `make access/approve|list|remove`: manages the prelaunch approved list. There is no operator
// console, so this is how a person is let in and how their set-password link is made.
import { createDb } from "../db/client.ts";
import { approveEmail, INVITE_DAYS, listApproved, removeApproval } from "../services/access.ts";
import { authConfigFromEnv } from "../services/auth.ts";
import { findTenantBySlug } from "../services/businesses.ts";

const [command, email, tenant] = process.argv.slice(2);
const db = createDb(
  process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5440/schmeide"
);

const needEmail = (): string => {
  if (!email) throw new Error("An email address is needed: EMAIL=person@example.com");
  return email;
};

try {
  if (command === "approve") {
    const { publicUrl } = authConfigFromEnv(process.env);
    const tenantId = tenant ? await findTenantBySlug(db, tenant) : undefined;
    const approved = await approveEmail(db, needEmail(), { tenantId });
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
    const removed = await removeApproval(db, needEmail());
    console.log(
      removed ? `${email} is removed and signed out.` : `${email} was not on the approved list.`
    );
  } else if (command === "list") {
    const approved = await listApproved(db);
    if (approved.length === 0) console.log("Nobody is approved yet.");
    for (const { email: address, hasAccount } of approved)
      console.log(`${address}\t${hasAccount ? "has an account" : "has not signed in yet"}`);
  } else {
    throw new Error("Use one of: approve, list, remove");
  }
} catch (error) {
  console.error(`Error: ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  await db.$client.end();
}
