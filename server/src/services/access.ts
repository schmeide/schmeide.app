// The prelaunch approved list and the one-time links that let an approved person set a password.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, asc, eq, exists, gt, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import {
  ADMIN_ROLE,
  accessRequests,
  approvedEmails,
  emailSchema,
  invites,
  memberships,
  sessions,
  tenants,
  users,
} from "../db/schema.ts";
import { withAudit, type Actor, type AuditTarget } from "./audit.ts";
import type { Auth, Person } from "./auth.ts";
import { joinBusiness } from "./businesses.ts";
import { ConflictError, ForbiddenError, NotFoundError } from "./errors.ts";
import { slugify } from "./projects.ts";

export const INVITE_DAYS = 7;
const INVITE_MS = INVITE_DAYS * 24 * 60 * 60 * 1000;

// One message for an unknown, used, expired, or withdrawn link, so a link reveals nothing.
const DEAD_LINK = "This link is not valid any more";

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export const newLink = (now: Date) => {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashToken(token), expiresAt: new Date(now.getTime() + INVITE_MS) };
};

export const HAS_ACCOUNT =
  "This address already has an account. Sign in with it, then open the link again to join.";

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
  const { token, tokenHash, expiresAt } = newLink(now);
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
    await tx
      .delete(invites)
      .where(and(eq(invites.email, email), isNull(invites.usedAt), isNull(invites.tenantId)));
    await tx.insert(invites).values({ email, tokenHash, expiresAt });
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

// Gives the platform admin role, recorded against `actor`: `make access/admin` passes the command
// line. Only to an approved person who already has an account; it throws with what to run next
// otherwise. Needs no admin to exist, so it makes the first one, or rescues a deployment that has
// none left. The admin area grants through `grantAdminRole` inside its own audited transaction.
export const grantAdmin = (
  db: Db,
  rawEmail: string,
  actor: Actor
): Promise<{ readonly email: string }> =>
  withAudit(db, actor, "admin.grant", async (tx, audit) => {
    const { email } = await grantAdminRole(tx, audit, rawEmail);
    return { email };
  });

// Gives the role to an approved person with an account now. With `invite`, as the admin area asks,
// someone with no account yet is approved instead, with the role waiting on their approval
// (`approved_emails.admin`) until their account is made, and their link's token is answered.
// Nothing the invitee sends or holds carries the role: only that row, which only this sets.
export const grantAdminRole = async (
  db: Db,
  audit: Audit,
  rawEmail: string,
  { reason, invite = false }: { readonly reason?: string; readonly invite?: boolean } = {}
): Promise<{
  readonly email: string;
  readonly pending: boolean;
  readonly token: string | null;
}> => {
  const email = emailSchema.parse(rawEmail);
  const approved = await isApproved(db, email);
  const userId = await userIdOf(db, email);
  if (userId === undefined && invite) {
    const { token } = await approveEmail(db, email);
    await db.update(approvedEmails).set({ admin: true }).where(eq(approvedEmails.email, email));
    audit({ detail: detailOf(email, reason) });
    return { email, pending: true, token };
  }
  if (!approved)
    throw invite
      ? new ConflictError(
          `${email} has no access. Give them access first, then make them an admin.`
        )
      : new Error(
          `${email} is not approved. Run \`make access/approve EMAIL=${email}\` first, then this again once they have signed in.`
        );
  if (userId === undefined)
    throw new Error(
      `${email} has not signed in yet. Send them the link \`make access/approve EMAIL=${email}\` prints, then run this again once they have signed in.`
    );
  await db.update(users).set({ role: ADMIN_ROLE }).where(eq(users.id, userId));
  // An admin cannot be viewed as: a view of them that is open ends.
  await db
    .delete(sessions)
    .where(and(eq(sessions.userId, userId), isNotNull(sessions.impersonatedBy)));
  audit({ targetUserId: userId, detail: detailOf(email, reason) });
  return { email, pending: false, token: null };
};

// Takes the role away, in the caller's transaction: ends every session of the person and every
// view as someone they have open, so the admin area is gone on their very next call. A grant still
// waiting for a first sign-in is withdrawn. Refused for the caller (`byId`, null from the command
// line) themselves, for a caller who is no longer an admin, and for the last admin. Every admin is
// locked first, so two admins taking each other's role at once take turns, and the second sees
// that it would leave none.
export const revokeAdmin = async (
  db: Db,
  audit: Audit,
  {
    email,
    reason,
    byId,
  }: { readonly email: string; readonly reason?: string; readonly byId: string | null }
): Promise<{ readonly email: string }> => {
  const admins = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.role, ADMIN_ROLE))
    .orderBy(asc(users.id))
    .for("update");
  const target = admins.find((admin) => admin.email === email);
  if (!target) {
    const withdrawn = await db
      .update(approvedEmails)
      .set({ admin: false })
      .where(and(eq(approvedEmails.email, email), eq(approvedEmails.admin, true)))
      .returning();
    if (withdrawn.length === 0) throw new NotFoundError(`${email} is not an admin`);
    audit({ detail: detailOf(email, reason) });
    return { email };
  }
  if (target.id === byId) throw new ForbiddenError("You cannot take away your own admin role");
  if (byId !== null && !admins.some(({ id }) => id === byId))
    throw new ForbiddenError("You are no longer an admin");
  if (admins.length <= 1)
    throw new ConflictError(
      "The last admin cannot lose the role, since nobody would be left to manage access. Choose “Make admin” for someone else first."
    );
  await db.update(users).set({ role: null }).where(eq(users.id, target.id));
  await db.delete(sessions).where(eq(sessions.userId, target.id));
  await endImpersonationsBy(db, target.id);
  audit({ targetUserId: target.id, detail: detailOf(email, reason) });
  return { email };
};

// Whether the address was made an admin before it had an account, claimed once: the flag is
// cleared as it is read, so the role is given to the account made now and never again. Called as
// an account is made, by an invite link (`acceptInvite`) or a first provider sign-in (auth.ts).
// When making the account then fails, the role is lost, not left lying around.
export const claimPendingAdmin = async (db: Db, email: string): Promise<boolean> =>
  (
    await db
      .update(approvedEmails)
      .set({ admin: false })
      .where(and(eq(approvedEmails.email, email.toLowerCase()), eq(approvedEmails.admin, true)))
      .returning()
  ).length > 0;

// The admins, and the people made admins who have not signed in yet (`pending`), by email.
export const listAdmins = async (db: Db) => {
  const active = await db
    .select({
      name: users.name,
      email: users.email,
      approved: sql<boolean>`${approvedEmails.email} is not null`,
    })
    .from(users)
    .leftJoin(approvedEmails, eq(approvedEmails.email, users.email))
    .where(eq(users.role, ADMIN_ROLE));
  const pending = await db
    .select({ email: approvedEmails.email })
    .from(approvedEmails)
    .leftJoin(users, eq(users.email, approvedEmails.email))
    .where(and(eq(approvedEmails.admin, true), isNull(users.id)));
  return [
    ...active.map((admin) => ({ ...admin, pending: false })),
    ...pending.map(({ email }) => ({ name: null, email, pending: true, approved: true })),
  ].sort((a, b) => a.email.localeCompare(b.email));
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
  // A request from schmeide.com for this address is decided. No row is fine: the address was
  // approved without one, and the link is still printed.
  await db
    .update(accessRequests)
    .set({ state: "approved" })
    .where(eq(accessRequests.email, approved.email));
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
  throw new ConflictError(
    "Schmeide could not find a free web address for that name. Try again, or use a slightly different name."
  );
};

const liveInvite = async (db: Db, token: string, now: Date) => {
  // The join drops a link whose address was taken off the list (the row cascades away anyway).
  const [invite] = await db
    .select({ id: invites.id, email: invites.email, tenantId: invites.tenantId })
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

// What the set-password page shows: whose link this is, whether they already have an account,
// and the business an owner invited them to (null for a plain set-password link).
export const getInvite = async (
  db: Db,
  token: string,
  now = new Date()
): Promise<{
  readonly email: string;
  readonly hasAccount: boolean;
  readonly business: string | null;
}> => {
  const invite = await liveInvite(db, token, now);
  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.email, invite.email));
  const [tenant] = invite.tenantId
    ? await db.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, invite.tenantId))
    : [];
  return { email: invite.email, hasAccount: Boolean(user), business: tenant?.name ?? null };
};

const spend = async (db: Db, id: number, now: Date): Promise<void> => {
  const spent = await db
    .update(invites)
    .set({ usedAt: now })
    .where(and(eq(invites.id, id), isNull(invites.usedAt)))
    .returning();
  if (spent.length === 0) throw new NotFoundError(DEAD_LINK);
};

export const joinByInvite = async (
  db: Db,
  person: Person,
  token: string,
  now = new Date()
): Promise<{ readonly businessId: number }> => {
  const { id, email, tenantId } = await liveInvite(db, token, now);
  if (!tenantId || email !== person.email) throw new NotFoundError(DEAD_LINK);
  await spend(db, id, now);
  await joinBusiness(db, person.id, tenantId);
  return { businessId: tenantId };
};

// Sets the password for the link's address: a new account for a new person, a reset (ending
// every session) for an existing one. The link is spent first, so two uses cannot both win.
export const acceptInvite = async (
  { auth, db }: { readonly auth: Auth; readonly db: Db },
  input: { readonly token: string; readonly name?: string; readonly password: string },
  now = new Date()
): Promise<{ readonly email: string }> => {
  const { id, email, tenantId } = await liveInvite(db, input.token, now);
  const { internalAdapter, password } = await auth.$context;
  const existing = await internalAdapter.findUserByEmail(email);
  // Checked before the link is spent, so a new person who left the name out can try again.
  if (!existing && !input.name) throw new NotFoundError("A name is needed to open an account");
  if (existing && tenantId) throw new ConflictError(HAS_ACCOUNT);
  await spend(db, id, now);

  const hash = await password.hash(input.password);
  if (!existing) {
    // Inserted here, not through Better Auth: its own create runs only inside one of its
    // endpoints, and public sign-up is off. The live link is the proof that this address is
    // approved, and that the person reads mail sent to it.
    // The role only when an admin made this address an admin before it had an account.
    const admin = await claimPendingAdmin(db, email);
    const [user] = await db
      .insert(users)
      .values({
        id: randomUUID(),
        email,
        name: input.name ?? email,
        emailVerified: true,
        role: admin ? ADMIN_ROLE : null,
      })
      .returning();
    await internalAdapter.linkAccount({
      userId: user.id,
      providerId: "credential",
      accountId: user.id,
      password: hash,
    });
    if (tenantId) await joinBusiness(db, user.id, tenantId);
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
