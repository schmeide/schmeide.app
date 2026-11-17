// The prelaunch approved list and the one-time links that let an approved person set a password.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, asc, eq, exists, gt, isNull, or, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import {
  ADMIN_ROLE,
  approvedEmails,
  emailSchema,
  invites,
  memberships,
  sessions,
  tenants,
  users,
} from "../db/schema.ts";
import { COMMAND_LINE, withAudit, type AuditTarget } from "./audit.ts";
import type { Auth } from "./auth.ts";
import { joinBusiness } from "./businesses.ts";
import { ConflictError, NotFoundError } from "./errors.ts";
import { slugify } from "./projects.ts";

export const INVITE_DAYS = 7;
const INVITE_MS = INVITE_DAYS * 24 * 60 * 60 * 1000;

// One message for an unknown, used, expired, or withdrawn link, so a link reveals nothing.
const DEAD_LINK = "This link is not valid any more";

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export const isApproved = async (db: Db, email: string): Promise<boolean> => {
  const [row] = await db
    .select({ email: approvedEmails.email })
    .from(approvedEmails)
    .where(eq(approvedEmails.email, email.trim().toLowerCase()));
  return Boolean(row);
};

// Approves the address (again is fine) and returns a fresh one-time token for its link. Earlier
// unused links for the address stop working, so only the newest one is live.
// `tenantId` makes the person a member of that business instead of giving them a new one: now if
// they already have an account, on first sign-in otherwise.
export const approveEmail = async (
  db: Db,
  rawEmail: string,
  { tenantId, now = new Date() }: { readonly tenantId?: number; readonly now?: Date } = {}
): Promise<{ readonly email: string; readonly token: string; readonly expiresAt: Date }> => {
  const email = emailSchema.parse(rawEmail);
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + INVITE_MS);
  await db.transaction(async (tx) => {
    await tx
      .insert(approvedEmails)
      .values({ email, tenantId })
      .onConflictDoUpdate({
        target: approvedEmails.email,
        set: tenantId ? { tenantId } : { email },
      });
    const [user] = await tx.select({ id: users.id }).from(users).where(eq(users.email, email));
    if (user && tenantId) await joinBusiness(tx as unknown as Db, user.id, tenantId);
    await tx.delete(invites).where(and(eq(invites.email, email), isNull(invites.usedAt)));
    await tx.insert(invites).values({ email, tokenHash: hashToken(token), expiresAt });
  });
  return { email, token, expiresAt };
};

// Ends every view of the app as someone else that the admin has open, and answers how many.
// Taking the admin role away (#136) must call this; currentPerson (auth.ts) also stops honoring
// such a view the moment its admin loses the role or their approval, whatever removed it.
export const endImpersonationsBy = async (db: Db, adminId: string): Promise<number> =>
  (await db.delete(sessions).where(eq(sessions.impersonatedBy, adminId)).returning()).length;

// Takes the address off the list and signs the person out everywhere. Their account and what
// they made stay; approving the address again gives it all back. An admin viewing the app as
// them keeps that view ("I cannot get in" is worth seeing from their side); the views a removed
// admin has open end with their own sessions.
export const removeApproval = async (db: Db, rawEmail: string): Promise<boolean> => {
  const email = emailSchema.parse(rawEmail);
  return db.transaction(async (tx) => {
    const removed = await tx
      .delete(approvedEmails)
      .where(eq(approvedEmails.email, email))
      .returning();
    const [user] = await tx.select({ id: users.id }).from(users).where(eq(users.email, email));
    if (user) {
      await tx
        .delete(sessions)
        .where(and(eq(sessions.userId, user.id), isNull(sessions.impersonatedBy)));
      await endImpersonationsBy(tx as unknown as Db, user.id);
    }
    return removed.length > 0;
  });
};

export const listApproved = (
  db: Db
): Promise<
  readonly { readonly email: string; readonly hasAccount: boolean; readonly admin: boolean }[]
> =>
  db
    .select({ email: approvedEmails.email, userId: users.id, role: users.role })
    .from(approvedEmails)
    .leftJoin(users, eq(users.email, approvedEmails.email))
    .orderBy(asc(approvedEmails.email))
    .then((rows) =>
      rows.map((row) => ({
        email: row.email,
        hasAccount: row.userId !== null,
        admin: row.role === ADMIN_ROLE,
      }))
    );

// Gives an approved person who has an account the platform admin role, recorded in the audit log
// as done from the command line. Throws with what to run next when the address is not approved
// or has no account yet.
export const grantAdmin = async (db: Db, rawEmail: string): Promise<{ readonly email: string }> => {
  const email = emailSchema.parse(rawEmail);
  if (!(await isApproved(db, email)))
    throw new Error(
      `${email} is not approved. Run \`make access/approve EMAIL=${email}\` first, then this again once they have signed in.`
    );
  return withAudit(db, COMMAND_LINE, "admin.grant", async (tx, audit) => {
    const [granted] = await tx
      .update(users)
      .set({ role: ADMIN_ROLE })
      .where(eq(users.email, email))
      .returning({ id: users.id });
    if (!granted)
      throw new Error(
        `${email} has not signed in yet. Send them the link \`make access/approve EMAIL=${email}\` prints, then run this again once they have signed in.`
      );
    audit({ targetUserId: granted.id, detail: email });
    return { email };
  });
};

type Audit = (target: AuditTarget) => void;

const userIdOf = async (db: Db, email: string): Promise<string | undefined> =>
  (await db.select({ id: users.id }).from(users).where(eq(users.email, email)))[0]?.id;

// Who an access change was about and why, for the audit log: the address names a person who has
// no account yet. Never the link's token.
const detailOf = (email: string, reason?: string) => (reason ? `${email}: ${reason}` : email);

// Approves the address as `approveEmail` does, recording it with `audit`: `make access/approve`
// (cli/access.ts) and the admin area both run this inside `withAudit`. Answers the link's token for
// the one answer that shows it, and whether the person already has an account.
export const approveAccess = async (
  db: Db,
  audit: Audit,
  rawEmail: string,
  { tenantId, reason }: { readonly tenantId?: number; readonly reason?: string } = {}
): Promise<{
  readonly email: string;
  readonly token: string;
  readonly expiresAt: Date;
  readonly hasAccount: boolean;
}> => {
  const approved = await approveEmail(db, rawEmail, { tenantId });
  const userId = await userIdOf(db, approved.email);
  audit({
    targetUserId: userId,
    targetTenantId: tenantId,
    detail: detailOf(approved.email, reason),
  });
  return { ...approved, hasAccount: userId !== undefined };
};

// Takes the address off the list and signs the person out, as `removeApproval` does, recording it
// with `audit`: `make access/remove` and the admin area both run this inside `withAudit`.
export const removeAccess = async (
  db: Db,
  audit: Audit,
  rawEmail: string,
  reason?: string
): Promise<{ readonly removed: boolean }> => {
  const email = emailSchema.parse(rawEmail);
  const removed = await removeApproval(db, email);
  audit({ targetUserId: await userIdOf(db, email), detail: detailOf(email, reason) });
  return { removed };
};

// A new business with a first owner, whose address is approved naming it: an owner with an account
// is its owner at once, anyone else on first sign-in. Asked again for the same name (ignoring case)
// and owner, it answers the business already made: that pair is the key. Two such requests at
// once wait for each other on a lock taken on the owner's address.
export const createBusiness = async (
  db: Db,
  audit: Audit,
  input: { readonly name: string; readonly ownerEmail: string; readonly reason: string }
) => {
  const email = emailSchema.parse(input.ownerEmail);
  const name = input.name.trim();
  await db.execute(sql`select pg_advisory_xact_lock(hashtext(${`business.create ${email}`}))`);
  const [existing] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(
      and(
        sql`lower(${tenants.name}) = lower(${name})`,
        or(
          exists(
            db
              .select({ one: sql`1` })
              .from(memberships)
              .innerJoin(users, eq(users.id, memberships.userId))
              .where(
                and(
                  eq(memberships.tenantId, tenants.id),
                  eq(memberships.role, "owner"),
                  eq(users.email, email)
                )
              )
          ),
          exists(
            db
              .select({ one: sql`1` })
              .from(approvedEmails)
              .where(and(eq(approvedEmails.email, email), eq(approvedEmails.tenantId, tenants.id)))
          )
        )
      )
    )
    .orderBy(asc(tenants.id))
    .limit(1);
  const id = existing?.id ?? (await insertTenant(db, name));
  const approved = await approveAccess(db, audit, email, { tenantId: id, reason: input.reason });
  return { id, created: !existing, ...approved };
};

// A slug from the name, as a project's is made (services/projects.ts); a taken one gets a random
// ending. Slugs are unique in the table, so two at once cannot both take one.
const insertTenant = async (db: Db, name: string): Promise<number> => {
  const base = slugify(name);
  for (const slug of [base, `${base}-${randomBytes(3).toString("hex")}`]) {
    const [tenant] = await db
      .insert(tenants)
      .values({ slug, name })
      .onConflictDoNothing({ target: tenants.slug })
      .returning({ id: tenants.id });
    if (tenant) return tenant.id;
  }
  throw new ConflictError("No free slug for that name. Try again.");
};

const liveInvite = async (db: Db, token: string, now: Date) => {
  // The join drops a link whose address was taken off the list (the row cascades away anyway).
  const [invite] = await db
    .select({ id: invites.id, email: invites.email })
    .from(invites)
    .innerJoin(approvedEmails, eq(approvedEmails.email, invites.email))
    .where(
      and(
        eq(invites.tokenHash, hashToken(token)),
        isNull(invites.usedAt),
        gt(invites.expiresAt, now)
      )
    );
  if (!invite) throw new NotFoundError(DEAD_LINK);
  return invite;
};

// What the set-password page shows: whose link this is, and whether they already have an account.
export const getInvite = async (
  db: Db,
  token: string,
  now = new Date()
): Promise<{ readonly email: string; readonly hasAccount: boolean }> => {
  const invite = await liveInvite(db, token, now);
  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.email, invite.email));
  return { email: invite.email, hasAccount: Boolean(user) };
};

// Sets the password for the link's address: a new account for a new person, a reset (ending
// every session) for an existing one. The link is spent first, so two uses cannot both win.
export const acceptInvite = async (
  { auth, db }: { readonly auth: Auth; readonly db: Db },
  input: { readonly token: string; readonly name?: string; readonly password: string },
  now = new Date()
): Promise<{ readonly email: string }> => {
  const { id, email } = await liveInvite(db, input.token, now);
  const { internalAdapter, password } = await auth.$context;
  const existing = await internalAdapter.findUserByEmail(email);
  // Checked before the link is spent, so a new person who left the name out can try again.
  if (!existing && !input.name) throw new NotFoundError("A name is needed to open an account");
  const spent = await db
    .update(invites)
    .set({ usedAt: now })
    .where(and(eq(invites.id, id), isNull(invites.usedAt)))
    .returning();
  if (spent.length === 0) throw new NotFoundError(DEAD_LINK);

  const hash = await password.hash(input.password);
  if (!existing) {
    // Inserted here, not through Better Auth: its own create runs only inside one of its
    // endpoints, and public sign-up is off. The live link is the proof that this address is
    // approved, and that the person reads mail sent to it.
    const [user] = await db
      .insert(users)
      .values({ id: randomUUID(), email, name: input.name ?? email, emailVerified: true })
      .returning();
    await internalAdapter.linkAccount({
      userId: user.id,
      providerId: "credential",
      accountId: user.id,
      password: hash,
    });
    return { email };
  }
  const userId = existing.user.id;
  if (await internalAdapter.findCredentialAccount(userId))
    await internalAdapter.updatePassword(userId, hash);
  else
    await internalAdapter.linkAccount({
      userId,
      providerId: "credential",
      accountId: userId,
      password: hash,
    });
  await internalAdapter.updateUser(userId, { emailVerified: true });
  // The person's own sessions; an admin viewing as them is left alone, as in removeApproval.
  await db
    .delete(sessions)
    .where(and(eq(sessions.userId, userId), isNull(sessions.impersonatedBy)));
  return { email };
};
