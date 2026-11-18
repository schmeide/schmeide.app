import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTRPC } from "@trpc/server";
import { and, eq, isNull } from "drizzle-orm";
import superjson from "superjson";
import { afterAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.ts";
import { createDb } from "../db/client.ts";
import { adminActions, tenants, users } from "../db/schema.ts";
import { adminMutation, appRouter, type AppContext, type Context } from "../router.ts";
import {
  acceptInvite,
  approveAccess,
  approveEmail,
  grantAdmin,
  removeAccess,
} from "../services/access.ts";
import { COMMAND_LINE, withAudit } from "../services/audit.ts";
import { recordFlaggedRequest } from "../services/review.ts";
import {
  aSignedInAdmin,
  aSignedInPerson,
  adminPaths,
  anEmail,
  callApi,
  PASSWORD,
  testAuth,
} from "./testAuth.ts";

const db = createDb(process.env.DATABASE_URL ?? "");
afterAll(() => db.$client.end());

const dataDir = mkdtempSync(join(tmpdir(), "schmeide-audit-review-"));
const deps: AppContext = {
  db,
  dataDir,
  workflows: { start: vi.fn(), getHandle: vi.fn() as never },
  taskQueue: "test",
  interviewer: vi.fn(),
  siteFetcher: vi.fn(),
  websiteReader: vi.fn(),
  files: {} as never,
  reader: vi.fn(),
  resources: {} as never,
  auth: testAuth(db),
  providers: [],
};
const app = buildApp(deps);
afterAll(() => app.close());

const idOf = async (email: string) => {
  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
  return user.id;
};
const rowsBy = (adminId: string) =>
  db.select().from(adminActions).where(eq(adminActions.adminId, adminId));

// A tree of callable procedures, as `createCaller` returns it.
type Callable = ((input: unknown) => Promise<unknown>) & { readonly [key: string]: Callable };
type Walkable = {
  readonly _def: { readonly procedures: object };
  readonly createCaller: (ctx: Context) => unknown;
};

// The input each admin mutation is called with by the walk below, by path. A new admin mutation
// needs an entry here that makes it succeed.
const walkInputs = async (): Promise<Readonly<Record<string, unknown>>> => {
  const owner = await aSignedInPerson(app, deps);
  const leaving = await aSignedInPerson(app, deps);
  const teammate = await aSignedInPerson(app, deps, { joins: owner.tenantId });
  const leavingAdmin = await aSignedInAdmin(app, deps);
  const reason = "audit walk";
  const review = await recordFlaggedRequest(dataDir, {
    tenantId: owner.tenantId,
    projectId: null,
    requestText: "patient records",
    rule: "health-records",
    outcome: "refused",
  });
  return {
    "admin.impersonation.start": { email: owner.email, reason },
    "admin.access.approve": { email: anEmail(), reason },
    "admin.access.remove": { email: leaving.email, reason },
    "admin.businesses.create": { name: "Audit walk", ownerEmail: anEmail(), reason },
    "admin.businesses.removeMember": { id: owner.tenantId, email: teammate.email, reason },
    // Walked in the router's order: suspended first, then restored.
    "admin.businesses.suspend": { id: owner.tenantId, reason },
    "admin.businesses.restore": { id: owner.tenantId, reason },
    "admin.admins.grant": { email: anEmail(), reason },
    "admin.admins.revoke": { email: leavingAdmin.email, reason },
    "admin.review.close": { id: review.id, disposition: "no_action", reason },
  };
};

// Calls every admin mutation in `router` as a signed-in admin and returns the paths that left no
// audit row by that admin.
const unauditedAdminMutations = async (router: Walkable) => {
  const inputs = await walkInputs();
  const admin = await aSignedInAdmin(app, deps);
  const adminId = await idOf(admin.email);
  const caller = router.createCaller({
    ...deps,
    headers: new Headers({ cookie: admin.cookie }),
    responseCookies: [],
  }) as Callable;
  const procedures = router._def.procedures as Readonly<
    Record<string, { readonly _def: { readonly type: string } }>
  >;
  const mutations = Object.keys(procedures).filter(
    (path) => path.startsWith("admin.") && procedures[path]._def.type === "mutation"
  );
  const unaudited: string[] = [];
  for (const path of mutations) {
    const before = (await rowsBy(adminId)).length;
    const call = path.split(".").reduce((node, key) => node[key], caller);
    await call(inputs[path]).catch(() => undefined);
    if ((await rowsBy(adminId)).length === before) unaudited.push(path);
  }
  return unaudited;
};

describe("every admin write", () => {
  it("leaves an audit row", async () => {
    expect(await unauditedAdminMutations(appRouter)).toEqual([]);
  });

  it("is caught by the walk when it leaves none", async () => {
    // A router of its own, so nothing fake is served: one write declared as an admin action,
    // and one that skips the audit log.
    const t = initTRPC.context<Context>().create({ transformer: superjson });
    const router = t.router({
      admin: t.router({
        audited: adminMutation("test.audited").mutation(() => "done"),
        unaudited: t.procedure.mutation(() => "done"),
      }),
    });
    expect(await unauditedAdminMutations(router)).toEqual(["admin.unaudited"]);
  });

  it("records the admin, the action, and its target", async () => {
    const admin = await aSignedInAdmin(app, deps);
    const adminId = await idOf(admin.email);
    const owner = await aSignedInPerson(app, deps);
    const ownerId = await idOf(owner.email);
    const t = initTRPC.context<Context>().create({ transformer: superjson });
    const router = t.router({
      act: adminMutation("test.target").mutation(({ ctx }) => {
        ctx.audit({ targetUserId: ownerId, targetTenantId: owner.tenantId, detail: "why" });
        return "done";
      }),
    });
    const caller = router.createCaller({
      ...deps,
      headers: new Headers({ cookie: admin.cookie }),
      responseCookies: [],
    });
    expect(await caller.act()).toBe("done");
    expect(await rowsBy(adminId)).toEqual([
      expect.objectContaining({
        adminLabel: admin.email,
        action: "test.target",
        targetUserId: ownerId,
        targetTenantId: owner.tenantId,
        detail: "why",
        createdAt: expect.any(Date),
      }),
    ]);
  });
});

describe("an admin action and its audit row", () => {
  it("are stored together", async () => {
    const [tenant] = await db
      .insert(tenants)
      .values({ slug: `a-${Date.now()}` })
      .returning();
    await withAudit(db, COMMAND_LINE, "test.rename", async (tx, audit) => {
      await tx.update(tenants).set({ name: "Renamed" }).where(eq(tenants.id, tenant.id));
      audit({ targetTenantId: tenant.id });
    });
    const rows = await db
      .select()
      .from(adminActions)
      .where(eq(adminActions.targetTenantId, tenant.id));
    expect(rows).toEqual([expect.objectContaining({ action: "test.rename", adminId: null })]);
  });

  it("are both dropped when the action throws", async () => {
    const [tenant] = await db
      .insert(tenants)
      .values({ slug: `b-${Date.now()}` })
      .returning();
    await expect(
      withAudit(db, COMMAND_LINE, "test.fails", async (tx, audit) => {
        await tx.update(tenants).set({ name: "Renamed" }).where(eq(tenants.id, tenant.id));
        audit({ targetTenantId: tenant.id });
        throw new Error("no");
      })
    ).rejects.toThrow("no");
    const [after] = await db.select().from(tenants).where(eq(tenants.id, tenant.id));
    expect(after.name).toBe("");
    expect(
      await db.select().from(adminActions).where(eq(adminActions.targetTenantId, tenant.id))
    ).toEqual([]);
  });

  it("are both dropped when an admin procedure throws", async () => {
    const admin = await aSignedInAdmin(app, deps);
    const t = initTRPC.context<Context>().create({ transformer: superjson });
    const router = t.router({
      act: adminMutation("test.throws").mutation(() => {
        throw new Error("no");
      }),
    });
    const caller = router.createCaller({
      ...deps,
      headers: new Headers({ cookie: admin.cookie }),
      responseCookies: [],
    });
    await expect(caller.act()).rejects.toThrow("no");
    expect(await rowsBy(await idOf(admin.email))).toEqual([]);
  });
});

describe("granting the admin role from the command line", () => {
  it("is recorded with the command line as the admin", async () => {
    const { email, token } = await approveEmail(db, anEmail());
    await acceptInvite(deps, { token, name: "Ada", password: PASSWORD });
    await grantAdmin(db, email, COMMAND_LINE);
    const userId = await idOf(email);
    const rows = await db
      .select()
      .from(adminActions)
      .where(and(eq(adminActions.targetUserId, userId), eq(adminActions.action, "admin.grant")));
    expect(rows).toEqual([
      expect.objectContaining({ adminId: null, adminLabel: COMMAND_LINE.label, detail: email }),
    ]);
  });
});

describe("approving and removing from the command line", () => {
  it("is recorded with the command line as the admin, through the screen's own functions", async () => {
    const email = anEmail();
    // What `make access/approve` and `make access/remove` run (cli/access.ts).
    const approved = await withAudit(db, COMMAND_LINE, "access.approve", (tx, audit) =>
      approveAccess(tx, audit, email)
    );
    await withAudit(db, COMMAND_LINE, "access.remove", (tx, audit) =>
      removeAccess(tx, audit, email)
    );
    const rows = await db
      .select()
      .from(adminActions)
      .where(and(isNull(adminActions.adminId), eq(adminActions.detail, email)));
    expect(rows.map(({ action, adminLabel }) => [action, adminLabel])).toEqual([
      ["access.approve", COMMAND_LINE.label],
      ["access.remove", COMMAND_LINE.label],
    ]);
    expect(JSON.stringify(rows)).not.toContain(approved.token);
  });
});

describe("the audit log", () => {
  it("is only found by admins", () => {
    // admin.test.ts walks every admin path as an owner and as nobody.
    expect(adminPaths).toEqual(expect.arrayContaining(["admin.audit.list", "admin.audit.filters"]));
  });

  it("lists newest first, filtered by admin and by business, a page at a time", async () => {
    const admin = await aSignedInAdmin(app, deps);
    const other = await aSignedInAdmin(app, deps);
    const owner = await aSignedInPerson(app, deps);
    const actor = (email: string) => ({ id: null, label: email });
    await withAudit(db, actor(admin.email), "test.first", async (_tx, audit) =>
      audit({ targetTenantId: owner.tenantId })
    );
    await withAudit(db, actor(other.email), "test.second", async (_tx, audit) =>
      audit({ targetTenantId: owner.tenantId })
    );
    await withAudit(db, actor(admin.email), "test.third", async () => undefined);

    const list = async (input: object) =>
      (await callApi(app, "admin.audit.list", input, admin.cookie)).data as {
        readonly entries: readonly { readonly action: string }[];
        readonly nextCursor: number | null;
      };
    const actions = async (input: object) =>
      (await list(input)).entries.map((entry) => entry.action);

    expect(await actions({ tenantId: owner.tenantId })).toEqual(["test.second", "test.first"]);
    expect(await actions({ admin: admin.email })).toEqual(["test.third", "test.first"]);
    expect(await actions({ admin: admin.email, tenantId: owner.tenantId })).toEqual(["test.first"]);
    const first = await list({ tenantId: owner.tenantId, limit: 1 });
    expect(first.entries.map((entry) => entry.action)).toEqual(["test.second"]);
    const second = await list({ tenantId: owner.tenantId, limit: 1, cursor: first.nextCursor });
    expect(second.entries.map((entry) => entry.action)).toEqual(["test.first"]);
    expect(second.nextCursor).toBeNull();

    const filters = (await callApi(app, "admin.audit.filters", undefined, admin.cookie)).data as {
      readonly admins: readonly string[];
      readonly businesses: readonly { readonly id: number }[];
    };
    expect(filters.admins).toEqual(expect.arrayContaining([admin.email, other.email]));
    expect(filters.businesses.map(({ id }) => id)).toContain(owner.tenantId);
  });
});
