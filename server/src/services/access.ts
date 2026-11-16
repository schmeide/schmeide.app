// The prelaunch approved list and the one-time links that let an approved person set a password.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, asc, eq, gt, isNull } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { approvedEmails, emailSchema, invites, sessions, users } from "../db/schema.ts";
import type { Auth } from "./auth.ts";
import { NotFoundError } from "./errors.ts";

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
export const approveEmail = async (
  db: Db,
  rawEmail: string,
  now = new Date()
): Promise<{ readonly email: string; readonly token: string; readonly expiresAt: Date }> => {
  const email = emailSchema.parse(rawEmail);
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + INVITE_MS);
  await db.transaction(async (tx) => {
    await tx.insert(approvedEmails).values({ email }).onConflictDoNothing();
    await tx.delete(invites).where(and(eq(invites.email, email), isNull(invites.usedAt)));
    await tx.insert(invites).values({ email, tokenHash: hashToken(token), expiresAt });
  });
  return { email, token, expiresAt };
};

// Takes the address off the list and signs the person out everywhere. Their account and what
// they made stay; approving the address again gives it all back.
export const removeApproval = async (db: Db, rawEmail: string): Promise<boolean> => {
  const email = emailSchema.parse(rawEmail);
  return db.transaction(async (tx) => {
    const removed = await tx
      .delete(approvedEmails)
      .where(eq(approvedEmails.email, email))
      .returning();
    const [user] = await tx.select({ id: users.id }).from(users).where(eq(users.email, email));
    if (user) await tx.delete(sessions).where(eq(sessions.userId, user.id));
    return removed.length > 0;
  });
};

export const listApproved = (
  db: Db
): Promise<readonly { readonly email: string; readonly hasAccount: boolean }[]> =>
  db
    .select({ email: approvedEmails.email, userId: users.id })
    .from(approvedEmails)
    .leftJoin(users, eq(users.email, approvedEmails.email))
    .orderBy(asc(approvedEmails.email))
    .then((rows) => rows.map((row) => ({ email: row.email, hasAccount: row.userId !== null })));

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
  await internalAdapter.deleteUserSessions(userId);
  return { email };
};
