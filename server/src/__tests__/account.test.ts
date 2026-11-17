import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.ts";
import { createDb } from "../db/client.ts";
import { accounts, approvedEmails, memberships, sessions, tenants, users } from "../db/schema.ts";
import type { AppContext } from "../router.ts";
import { approveEmail } from "../services/access.ts";
import { createProject } from "../services/projects.ts";
import { aSignedInPerson, callApi, PASSWORD, signIn, testAuth } from "./testAuth.ts";

const db = createDb(process.env.DATABASE_URL ?? "");
afterAll(() => db.$client.end());

const deps: AppContext = {
  db,
  workflows: { start: vi.fn(), getHandle: vi.fn() as never },
  taskQueue: "test",
  interviewer: vi.fn(),
  siteFetcher: vi.fn(),
  websiteReader: vi.fn(),
  files: {} as never,
  reader: vi.fn(),
  resources: {} as never,
  auth: testAuth(db),
  providers: ["google"],
};
const app = buildApp(deps);
afterAll(() => app.close());

const trpc = (path: string, input: unknown, cookie: string) => callApi(app, path, input, cookie);

const userIdOf = async (email: string) => {
  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
  return user.id;
};

// A Google sign-in method on the person's account, as if they had connected it.
const connectGoogle = async (email: string) =>
  db.insert(accounts).values({
    id: randomUUID(),
    userId: await userIdOf(email),
    accountId: `google-${randomUUID()}`,
    providerId: "google",
    accessToken: "secret-access-token",
    refreshToken: "secret-refresh-token",
  });

describe("the account", () => {
  it("shows the person, how they sign in, and this device", async () => {
    const ada = await aSignedInPerson(app, deps, { name: "Ada Example" });
    const { data } = await trpc("account.get", undefined, ada.cookie);
    expect(data).toMatchObject({ name: "Ada Example", email: ada.email });
    expect(data.methods).toEqual([
      { id: expect.any(String), kind: "password", since: expect.any(String) },
    ]);
    expect(data.devices).toHaveLength(1);
    expect(data.devices[0]).toMatchObject({ current: true });
    expect(data.businesses).toEqual([
      { id: ada.tenantId, name: "Ada Example’s business", onDelete: "remove" },
    ]);
  });

  it("renames the person and nobody else", async () => {
    const ada = await aSignedInPerson(app, deps, { name: "Ada Example" });
    const bob = await aSignedInPerson(app, deps, { name: "Bob Example" });
    expect((await trpc("account.rename", { name: "  Ada Lovelace " }, ada.cookie)).status).toBe(
      200
    );
    expect((await trpc("account.get", undefined, ada.cookie)).data.name).toBe("Ada Lovelace");
    expect((await trpc("account.get", undefined, bob.cookie)).data.name).toBe("Bob Example");
    expect((await trpc("account.rename", { name: "   " }, ada.cookie)).code).toBe("BAD_REQUEST");
  });

  it("lists every device and signs out all but this one", async () => {
    const ada = await aSignedInPerson(app, deps);
    const laptop = await signIn(app, ada.email);
    expect((await trpc("account.get", undefined, ada.cookie)).data.devices).toHaveLength(2);

    await trpc("account.signOutOthers", undefined, ada.cookie);
    const { data } = await trpc("account.get", undefined, ada.cookie);
    expect(data.devices).toHaveLength(1);
    expect(data.devices[0].current).toBe(true);
    expect((await trpc("account.get", undefined, laptop.cookie)).code).toBe("UNAUTHORIZED");
  });

  it("disconnects a sign-in method only while another way in remains", async () => {
    const ada = await aSignedInPerson(app, deps);
    const only = (await trpc("account.get", undefined, ada.cookie)).data.methods[0];
    const refused = await trpc("account.disconnect", { id: only.id }, ada.cookie);
    expect(refused.code).toBe("CONFLICT");

    await connectGoogle(ada.email);
    const { methods } = (await trpc("account.get", undefined, ada.cookie)).data;
    expect(methods.map((method: { kind: string }) => method.kind).sort()).toEqual([
      "google",
      "password",
    ]);
    const google = methods.find((method: { kind: string }) => method.kind === "google");
    expect((await trpc("account.disconnect", { id: google.id }, ada.cookie)).status).toBe(200);
    const after = (await trpc("account.get", undefined, ada.cookie)).data.methods;
    expect(after.map((method: { kind: string }) => method.kind)).toEqual(["password"]);
  });

  it("cannot disconnect another person's sign-in method", async () => {
    const ada = await aSignedInPerson(app, deps);
    const bob = await aSignedInPerson(app, deps);
    await connectGoogle(bob.email);
    await connectGoogle(ada.email);
    const bobs = (await trpc("account.get", undefined, bob.cookie)).data.methods;
    const answer = await trpc("account.disconnect", { id: bobs[0].id }, ada.cookie);
    expect(answer.code).toBe("NOT_FOUND");
    expect((await trpc("account.get", undefined, bob.cookie)).data.methods).toHaveLength(2);
  });

  it("downloads what is held about the person, without tokens or the password", async () => {
    const ada = await aSignedInPerson(app, deps, { name: "Ada Example" });
    await connectGoogle(ada.email);
    await createProject(db, { name: "Invoices", tenantId: ada.tenantId });
    const { data } = await trpc("account.export", undefined, ada.cookie);
    expect(data.person).toMatchObject({ name: "Ada Example", email: ada.email });
    expect(data.signInMethods.map((method: { kind: string }) => method.kind).sort()).toEqual([
      "google",
      "password",
    ]);
    expect(data.businesses).toEqual([
      expect.objectContaining({
        name: "Ada Example’s business",
        role: "owner",
        apps: [expect.objectContaining({ name: "Invoices" })],
      }),
    ]);
    expect(data.devices).toHaveLength(1);
    const text = JSON.stringify(data);
    for (const secret of ["secret-access-token", "secret-refresh-token", "token", 'password":'])
      expect(text).not.toContain(secret);
    const [credential] = await db
      .select({ password: accounts.password })
      .from(accounts)
      .where(eq(accounts.providerId, "credential"))
      .limit(1);
    expect(text).not.toContain(String(credential.password));
  });
});

describe("deleting the account", () => {
  it("needs the person's own email typed", async () => {
    const ada = await aSignedInPerson(app, deps);
    const answer = await trpc("account.delete", { email: "someone@example.com" }, ada.cookie);
    expect(answer.code).toBe("BAD_REQUEST");
    expect(await userIdOf(ada.email)).toBeTruthy();
  });

  it("removes the person, their approval, and their empty business, and signs them out", async () => {
    const ada = await aSignedInPerson(app, deps);
    const userId = await userIdOf(ada.email);
    const answer = await trpc("account.delete", { email: ada.email.toUpperCase() }, ada.cookie);
    expect(answer.status).toBe(200);

    expect(await db.select().from(users).where(eq(users.id, userId))).toEqual([]);
    expect(await db.select().from(sessions).where(eq(sessions.userId, userId))).toEqual([]);
    expect(await db.select().from(accounts).where(eq(accounts.userId, userId))).toEqual([]);
    expect(
      await db.select().from(approvedEmails).where(eq(approvedEmails.email, ada.email))
    ).toEqual([]);
    expect(await db.select().from(tenants).where(eq(tenants.id, ada.tenantId))).toEqual([]);
    expect((await trpc("account.get", undefined, ada.cookie)).code).toBe("UNAUTHORIZED");
    expect((await signIn(app, ada.email, PASSWORD)).status).not.toBe(200);
  });

  it("is refused while the person's own business still has apps", async () => {
    const ada = await aSignedInPerson(app, deps);
    await createProject(db, { name: "Invoices", tenantId: ada.tenantId });
    const { data } = await trpc("account.get", undefined, ada.cookie);
    expect(data.businesses[0].onDelete).toBe("deleteApps");
    expect((await trpc("account.delete", { email: ada.email }, ada.cookie)).code).toBe("CONFLICT");
    expect(await userIdOf(ada.email)).toBeTruthy();
  });

  it("is refused for the only owner of a business other people work in", async () => {
    const ada = await aSignedInPerson(app, deps);
    await aSignedInPerson(app, deps, { joins: ada.tenantId });
    const { data } = await trpc("account.get", undefined, ada.cookie);
    expect(data.businesses[0].onDelete).toBe("handOver");
    expect((await trpc("account.delete", { email: ada.email }, ada.cookie)).code).toBe("CONFLICT");
  });

  it("leaves a business the person only works in, with its apps", async () => {
    const ada = await aSignedInPerson(app, deps);
    await createProject(db, { name: "Invoices", tenantId: ada.tenantId });
    const bob = await aSignedInPerson(app, deps, { joins: ada.tenantId });
    expect((await trpc("account.get", undefined, bob.cookie)).data.businesses).toEqual([
      expect.objectContaining({ id: ada.tenantId, onDelete: "leave" }),
    ]);
    expect((await trpc("account.delete", { email: bob.email }, bob.cookie)).status).toBe(200);
    expect(await db.select().from(tenants).where(eq(tenants.id, ada.tenantId))).toHaveLength(1);
    const left = await db.select().from(memberships).where(eq(memberships.tenantId, ada.tenantId));
    expect(left).toHaveLength(1);
    expect((await trpc("projects.list", undefined, ada.cookie)).data).toHaveLength(1);
  });

  it("keeps an empty business someone else has been invited into", async () => {
    const ada = await aSignedInPerson(app, deps);
    await approveEmail(db, `invited-${randomUUID()}@example.com`, { tenantId: ada.tenantId });
    const { data } = await trpc("account.get", undefined, ada.cookie);
    expect(data.businesses[0].onDelete).toBe("handOver");
  });
});
