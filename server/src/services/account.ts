// The signed-in person's own account: their name, how they sign in, where they are signed in,
// a copy of what is held about them, and deleting it all.
import { and, asc, desc, eq, gt, inArray, ne, sql } from "drizzle-orm";
import { APIError } from "better-auth/api";
import type { Db } from "../db/client.ts";
import {
  accounts,
  approvedEmails,
  memberships,
  projects,
  sessions,
  tenants,
  users,
  websiteReads,
} from "../db/schema.ts";
import type { Auth, Person, Provider } from "./auth.ts";
import { BadInputError, ConflictError, NotFoundError } from "./errors.ts";

type Deps = { readonly db: Db; readonly auth: Auth };

export type MethodKind = "password" | Provider;
export type SignInMethod = { readonly id: string; readonly kind: MethodKind; readonly since: Date };
export type Device = {
  readonly id: string;
  readonly current: boolean;
  readonly userAgent: string | null;
  readonly ipAddress: string | null;
  readonly signedInAt: Date;
  readonly lastActive: Date;
};

// What deleting the account does to each of the person's businesses.
// - leave: someone else owns it too, or the person only works in it; it carries on without them.
// - remove: the person is all there is to it, and it holds no apps; it goes with the account.
// - deleteApps: as remove, but it still holds apps, which they delete first.
// - handOver: they are its only owner and others work in it or are invited; someone else must
//   own it first (business settings, #66).
export type OnDelete = "leave" | "remove" | "deleteApps" | "handOver";
export type OwnBusiness = {
  readonly id: number;
  readonly name: string;
  readonly onDelete: OnDelete;
};

const kindOf = (providerId: string): MethodKind =>
  providerId === "credential" ? "password" : (providerId as Provider);

const methodsOf = async (db: Db, userId: string): Promise<SignInMethod[]> =>
  (
    await db
      .select({ id: accounts.id, providerId: accounts.providerId, since: accounts.createdAt })
      .from(accounts)
      .where(eq(accounts.userId, userId))
      .orderBy(asc(accounts.createdAt))
  ).map(({ id, providerId, since }) => ({ id, kind: kindOf(providerId), since }));

const devicesOf = async (deps: Deps, userId: string, headers: Headers): Promise<Device[]> => {
  const current = await deps.auth.api.getSession({ headers });
  const rows = await deps.db
    .select()
    .from(sessions)
    .where(and(eq(sessions.userId, userId), gt(sessions.expiresAt, new Date())))
    .orderBy(desc(sessions.updatedAt));
  return rows.map((row) => ({
    id: row.id,
    current: row.id === current?.session.id,
    userAgent: row.userAgent,
    ipAddress: row.ipAddress,
    signedInAt: row.createdAt,
    lastActive: row.updatedAt,
  }));
};

const count = sql<number>`count(*)::int`;

const businessesOf = async (db: Db, person: Person): Promise<OwnBusiness[]> => {
  const mine = await db
    .select({ id: tenants.id, name: tenants.name, role: memberships.role })
    .from(memberships)
    .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
    .where(eq(memberships.userId, person.id))
    .orderBy(asc(memberships.createdAt), asc(tenants.id));
  return Promise.all(
    mine.map(async ({ id, name, role }): Promise<OwnBusiness> => {
      const others = await db
        .select({ role: memberships.role })
        .from(memberships)
        .where(and(eq(memberships.tenantId, id), ne(memberships.userId, person.id)));
      if (role !== "owner" || others.some((other) => other.role === "owner"))
        return { id, name, onDelete: "leave" };
      const [invited] = await db
        .select({ count })
        .from(approvedEmails)
        .where(and(eq(approvedEmails.tenantId, id), ne(approvedEmails.email, person.email)));
      if (others.length > 0 || invited.count > 0) return { id, name, onDelete: "handOver" };
      const [apps] = await db.select({ count }).from(projects).where(eq(projects.tenantId, id));
      return { id, name, onDelete: apps.count > 0 ? "deleteApps" : "remove" };
    })
  );
};

export const getAccount = async (deps: Deps, person: Person, headers: Headers) => {
  const [user] = await deps.db.select().from(users).where(eq(users.id, person.id));
  return {
    name: user.name,
    email: user.email,
    since: user.createdAt,
    methods: await methodsOf(deps.db, person.id),
    devices: await devicesOf(deps, person.id, headers),
    businesses: await businessesOf(deps.db, person),
  };
};

export const renameAccount = async (
  db: Db,
  person: Person,
  input: { readonly name: string }
): Promise<void> => {
  await db.update(users).set({ name: input.name }).where(eq(users.id, person.id));
};

export const signOutOthers = async (deps: Deps, headers: Headers): Promise<void> => {
  await deps.auth.api.revokeOtherSessions({ headers });
};

// Removes one way of signing in, never the last one, so the person cannot lock themselves out.
export const disconnectMethod = async (
  deps: Deps,
  person: Person,
  input: { readonly id: string },
  headers: Headers
): Promise<void> => {
  const methods = await methodsOf(deps.db, person.id);
  if (!methods.some((method) => method.id === input.id))
    throw new NotFoundError("That sign-in method is not on your account");
  if (methods.length === 1)
    throw new ConflictError("It is your only way to sign in. Connect another one first.");
  try {
    await deps.auth.api.unlinkAccount({ headers, body: { accountId: input.id } });
  } catch (error) {
    if (error instanceof APIError && error.status === "FORBIDDEN")
      throw new ConflictError("Sign out and sign in again, then disconnect it.");
    throw error;
  }
};

// Everything Schmeide holds about the person, for "Download my details". Never a provider token
// or the password hash.
export const exportAccount = async (deps: Deps, person: Person, headers: Headers) => {
  const { db } = deps;
  const [user] = await db.select().from(users).where(eq(users.id, person.id));
  const [approval] = await db
    .select({ since: approvedEmails.createdAt })
    .from(approvedEmails)
    .where(eq(approvedEmails.email, user.email));
  const mine = await db
    .select({
      id: tenants.id,
      name: tenants.name,
      role: memberships.role,
      since: memberships.createdAt,
    })
    .from(memberships)
    .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
    .where(eq(memberships.userId, person.id))
    .orderBy(asc(memberships.createdAt));
  const apps = mine.length
    ? await db
        .select({
          tenantId: projects.tenantId,
          name: projects.name,
          status: projects.status,
          createdAt: projects.createdAt,
        })
        .from(projects)
        .where(
          inArray(
            projects.tenantId,
            mine.map((business) => business.id)
          )
        )
        .orderBy(asc(projects.createdAt))
    : [];
  const devices = await devicesOf(deps, person.id, headers);
  return {
    exportedAt: new Date(),
    person: { name: user.name, email: user.email, since: user.createdAt },
    invitedSince: approval?.since ?? null,
    signInMethods: await methodsOf(db, person.id),
    devices: devices.map(({ ipAddress, userAgent, signedInAt, lastActive }) => ({
      ipAddress,
      userAgent,
      signedInAt,
      lastActive,
    })),
    businesses: mine.map(({ id, name, role, since }) => ({
      name,
      role,
      memberSince: since,
      apps: apps
        .filter((app) => app.tenantId === id)
        .map(({ name: appName, status, createdAt }) => ({ name: appName, status, createdAt })),
    })),
  };
};

// Deletes the person now: their account, sessions, sign-in methods and approval, and any
// business that is only theirs and empty. Refused while a business would be left without an
// owner or with apps nobody can reach.
export const deleteAccount = async (
  db: Db,
  person: Person,
  input: { readonly email: string }
): Promise<void> => {
  if (input.email !== person.email.toLowerCase())
    throw new BadInputError("That is not the email address of this account.");
  const businesses = await businessesOf(db, person);
  const blocked = businesses.find(
    (business) => business.onDelete === "handOver" || business.onDelete === "deleteApps"
  );
  if (blocked)
    throw new ConflictError(
      blocked.onDelete === "deleteApps"
        ? `Delete the apps in ${blocked.name} first.`
        : `You are the only owner of ${blocked.name}. Someone else must own it first.`
    );
  const removed = businesses
    .filter((business) => business.onDelete === "remove")
    .map((business) => business.id);
  await db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    await tx.delete(approvedEmails).where(eq(approvedEmails.email, person.email));
    // Sessions, sign-in methods, memberships and website reads go with the user row.
    await tx.delete(users).where(eq(users.id, person.id));
    if (removed.length) {
      await tx.delete(websiteReads).where(inArray(websiteReads.tenantId, removed));
      await tx.delete(tenants).where(inArray(tenants.id, removed));
    }
  });
};
