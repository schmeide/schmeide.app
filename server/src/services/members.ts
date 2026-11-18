import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { countryCodes } from "../../../data/countries.ts";
import type { Db } from "../db/client.ts";
import {
  approvedEmails,
  emailSchema,
  invites,
  memberRole,
  memberships,
  tenants,
  users,
  type MemberRole,
} from "../db/schema.ts";
import { newLink } from "./access.ts";
import { ConflictError, NotFoundError } from "./errors.ts";

export const updateBusinessSchema = z.object({
  name: z.string().trim().min(1).max(120),
  country: z
    .string()
    .refine((code) => countryCodes.includes(code))
    .nullable(),
});
export const invitationSchema = z.object({ email: emailSchema });
export const memberSchema = z.object({ userId: z.string().min(1).max(100) });
export const memberRoleSchema = memberSchema.extend({ role: z.enum(memberRole.enumValues) });

export const LAST_OWNER =
  "This business has no other owner. Make someone else an owner first, then try again.";
export const NOT_A_MEMBER =
  "That person is not a member of this business. Reload the page to see who is.";
export const ALREADY_A_MEMBER =
  "That person is already a member of this business, so there is nothing to invite. Reload the page to see the members.";
export const ALREADY_INVITED =
  "That address already has an invitation waiting. Make a new link for it in the list of invitations.";
export const NO_INVITATION =
  "There is no invitation waiting for that address. Reload the page to see the list.";
export const CANNOT_INVITE =
  "That address cannot be invited from here. Get in touch and we will look into it.";
export const ALREADY_YOU =
  "You are already an owner of this business, so there is nothing to change. Choose someone else to make an owner.";

type Link = { readonly email: string; readonly token: string; readonly expiresAt: Date };

const locked = <Result>(
  db: Db,
  tenantId: number,
  work: (tx: Db) => Promise<Result>
): Promise<Result> =>
  db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    await tx.execute(sql`select 1 from ${tenants} where ${tenants.id} = ${tenantId} for update`);
    return work(tx);
  });

const membersOf = (db: Db, tenantId: number) =>
  db
    .select({
      userId: users.id,
      name: users.name,
      email: users.email,
      role: memberships.role,
      joinedAt: memberships.createdAt,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(eq(memberships.tenantId, tenantId))
    .orderBy(asc(memberships.createdAt), asc(users.email));

const waiting = (tenantId: number, email: string) =>
  and(eq(invites.tenantId, tenantId), eq(invites.email, email), isNull(invites.usedAt));

export const getBusiness = async (db: Db, tenantId: number, personId: string, now = new Date()) => {
  const [business] = await db
    .select({ id: tenants.id, name: tenants.name, country: tenants.country })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  const members = await membersOf(db, tenantId);
  const role: MemberRole = members.find(({ userId }) => userId === personId)?.role ?? "editor";
  const invitations =
    role === "owner"
      ? await db
          .select({
            email: invites.email,
            invitedAt: invites.createdAt,
            expiresAt: invites.expiresAt,
          })
          .from(invites)
          .where(and(eq(invites.tenantId, tenantId), isNull(invites.usedAt)))
          .orderBy(asc(invites.createdAt), asc(invites.email))
      : [];
  return {
    ...business,
    role,
    members: members.map((member) => ({ ...member, isYou: member.userId === personId })),
    invitations: invitations.map((invitation) => ({
      ...invitation,
      expired: invitation.expiresAt <= now,
    })),
  };
};

export const updateBusiness = async (
  db: Db,
  tenantId: number,
  input: z.infer<typeof updateBusinessSchema>
) => {
  const [business] = await db
    .update(tenants)
    .set({ name: input.name, country: input.country })
    .where(eq(tenants.id, tenantId))
    .returning({ id: tenants.id, name: tenants.name, country: tenants.country });
  return business;
};

export const inviteToBusiness = (
  db: Db,
  tenantId: number,
  rawEmail: string,
  now = new Date()
): Promise<Link> => {
  const email = emailSchema.parse(rawEmail);
  const { token, tokenHash, expiresAt } = newLink(now);
  return locked(db, tenantId, async (tx) => {
    const members = await membersOf(tx, tenantId);
    if (members.some((member) => member.email === email)) throw new ConflictError(ALREADY_A_MEMBER);
    const [user] = await tx.select({ id: users.id }).from(users).where(eq(users.email, email));
    const [approval] = await tx
      .select({ email: approvedEmails.email })
      .from(approvedEmails)
      .where(eq(approvedEmails.email, email));
    if (user && !approval) throw new ConflictError(CANNOT_INVITE);
    await tx.insert(approvedEmails).values({ email, tenantId }).onConflictDoNothing();
    const created = await tx
      .insert(invites)
      .values({ email, tenantId, tokenHash, expiresAt, createdAt: now })
      .onConflictDoNothing()
      .returning({ id: invites.id });
    if (created.length === 0) throw new ConflictError(ALREADY_INVITED);
    return { email, token, expiresAt };
  });
};

export const reissueInvitation = async (
  db: Db,
  tenantId: number,
  rawEmail: string,
  now = new Date()
): Promise<Link> => {
  const email = emailSchema.parse(rawEmail);
  const { token, tokenHash, expiresAt } = newLink(now);
  const renewed = await db
    .update(invites)
    .set({ tokenHash, expiresAt })
    .where(waiting(tenantId, email))
    .returning({ id: invites.id });
  if (renewed.length === 0) throw new NotFoundError(NO_INVITATION);
  return { email, token, expiresAt };
};

export const withdrawInvitation = async (
  db: Db,
  tenantId: number,
  rawEmail: string
): Promise<void> => {
  const email = emailSchema.parse(rawEmail);
  await db.transaction(async (tx) => {
    const withdrawn = await tx
      .delete(invites)
      .where(waiting(tenantId, email))
      .returning({ id: invites.id });
    if (withdrawn.length === 0) throw new NotFoundError(NO_INVITATION);
    const [user] = await tx.select({ id: users.id }).from(users).where(eq(users.email, email));
    const ours = and(eq(approvedEmails.email, email), eq(approvedEmails.tenantId, tenantId));
    if (user) {
      await tx.update(approvedEmails).set({ tenantId: null }).where(ours);
      return;
    }
    const [next] = await tx
      .select({ tenantId: invites.tenantId })
      .from(invites)
      .where(and(eq(invites.email, email), isNull(invites.usedAt)))
      .orderBy(asc(invites.createdAt), asc(invites.id))
      .limit(1);
    if (next) await tx.update(approvedEmails).set({ tenantId: next.tenantId }).where(ours);
    else await tx.delete(approvedEmails).where(ours);
  });
};

const ownersOtherThan = (
  members: readonly { readonly userId: string; readonly role: MemberRole }[],
  userId: string
) => members.filter((member) => member.role === "owner" && member.userId !== userId);

export const removeMember = (db: Db, tenantId: number, userId: string): Promise<void> =>
  locked(db, tenantId, async (tx) => {
    const members = await membersOf(tx, tenantId);
    const member = members.find((candidate) => candidate.userId === userId);
    if (!member) throw new NotFoundError(NOT_A_MEMBER);
    if (ownersOtherThan(members, userId).length === 0) throw new ConflictError(LAST_OWNER);
    await tx
      .delete(memberships)
      .where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, userId)));
    await tx
      .update(approvedEmails)
      .set({ tenantId: null })
      .where(and(eq(approvedEmails.email, member.email), eq(approvedEmails.tenantId, tenantId)));
  });

export const setMemberRole = (
  db: Db,
  tenantId: number,
  input: { readonly userId: string; readonly role: MemberRole }
): Promise<void> =>
  locked(db, tenantId, async (tx) => {
    const members = await membersOf(tx, tenantId);
    if (!members.some((member) => member.userId === input.userId))
      throw new NotFoundError(NOT_A_MEMBER);
    if (input.role !== "owner" && ownersOtherThan(members, input.userId).length === 0)
      throw new ConflictError(LAST_OWNER);
    await tx
      .update(memberships)
      .set({ role: input.role })
      .where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, input.userId)));
  });

export const transferOwnership = (
  db: Db,
  tenantId: number,
  fromUserId: string,
  toUserId: string
): Promise<void> =>
  locked(db, tenantId, async (tx) => {
    if (fromUserId === toUserId) throw new ConflictError(ALREADY_YOU);
    const members = await membersOf(tx, tenantId);
    if (!members.some((member) => member.userId === toUserId))
      throw new NotFoundError(NOT_A_MEMBER);
    const inBusiness = (userId: string) =>
      and(eq(memberships.tenantId, tenantId), eq(memberships.userId, userId));
    await tx.update(memberships).set({ role: "owner" }).where(inBusiness(toUserId));
    await tx.update(memberships).set({ role: "editor" }).where(inBusiness(fromUserId));
  });
