import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.ts";
import { createDb } from "../db/client.ts";
import { projects, tenants } from "../db/schema.ts";
import { BUSINESS_HEADER, type AppContext } from "../router.ts";
import { acceptInvite, approveEmail } from "../services/access.ts";
import { findTenantBySlug } from "../services/businesses.ts";
import { approveSpec, createProject, transition } from "../services/projects.ts";
import { finishBuild } from "../services/builds.ts";
import {
  adminPaths,
  aSignedInPerson,
  anEmail,
  callApi,
  impersonationPaths,
  PASSWORD,
  procedurePaths,
  signIn,
  testAuth,
} from "./testAuth.ts";

const db = createDb(process.env.DATABASE_URL ?? "");
afterAll(() => db.$client.end());

const start = vi.fn(async () => ({}) as never);
const interviewer = vi.fn();
const siteFetcher = vi.fn();
const websiteReader = vi.fn();
const reader = vi.fn();
const stored = { put: vi.fn(), get: vi.fn(), remove: vi.fn(), removeProject: vi.fn() };
const deps: AppContext = {
  db,
  workflows: { start, getHandle: vi.fn() as never },
  taskQueue: "test",
  interviewer,
  siteFetcher,
  websiteReader,
  files: stored,
  resources: {} as never,
  reader,
  auth: testAuth(db),
  providers: [],
};
const app = buildApp(deps);
afterAll(() => app.close());
beforeEach(() => {
  start.mockClear();
  interviewer.mockClear();
  reader.mockClear();
  Object.values(stored).forEach((call) => call.mockClear());
});

// The procedures anyone may call. Everything else needs a signed-in, approved caller.
const OPEN = ["session.get", "invites.get", "invites.accept"];
// Every procedure but the admin ones and stopping a view as someone, which admin.test.ts walks on
// their own.
const customerPaths = procedurePaths.filter(
  (path) => !adminPaths.includes(path) && !impersonationPaths.includes(path)
);

// One call of every customer procedure, aimed at the given project and build. A procedure added
// to the router must be added here, or the first test fails.
const everyCall = (id: number, buildId: number): Readonly<Record<string, unknown>> => ({
  "session.get": undefined,
  "invites.get": { token: "no-such-token" },
  "invites.accept": { token: "no-such-token", name: "Eve", password: "a long password" },
  "account.get": undefined,
  "account.rename": { name: "Taken over" },
  "account.disconnect": { id: "no-such-method" },
  "account.signOutOthers": undefined,
  "account.export": undefined,
  "account.delete": { email: "nobody@example.com" },
  "invites.join": { token: "no-such-token" },
  "setup.createBusiness": { yourName: "Taken over", country: "DE" },
  "business.get": undefined,
  "business.update": { name: "Taken over", country: null },
  "business.invite": { email: "taken-over@example.com" },
  "business.reissueInvitation": { email: "taken-over@example.com" },
  "business.withdrawInvitation": { email: "taken-over@example.com" },
  "business.removeMember": { userId: "no-such-person" },
  "business.leave": undefined,
  "business.setRole": { userId: "no-such-person", role: "owner" },
  "business.transferOwnership": { userId: "no-such-person" },
  "projects.list": undefined,
  "projects.create": { name: `walk ${randomUUID()}` },
  "projects.get": { id },
  "projects.setFeatures": { id, features: "Take over" },
  "projects.generateSpec": { id },
  "projects.approveSpec": { id },
  "projects.checks": { id },
  "projects.acceptance": { id },
  "projects.requestChange": { id, request: "Take over" },
  "projects.setSite": { id, title: "Taken over" },
  "projects.promote": { id },
  "projects.discard": { id },
  "projects.rollBack": { id, version: 1 },
  "projects.buildWaiting": { id },
  "projects.stop": { id },
  "projects.start": { id },
  "projects.rename": { id, name: "Taken over" },
  "projects.delete": { id },
  "interview.get": { id },
  "interview.start": { id },
  "interview.restart": { id, need: "Take over" },
  "interview.setDepth": { id, depth: "quick" },
  "interview.answer": { id, questionId: 1, answer: { type: "text", value: "Take over" } },
  "interview.addItem": { id, section: "does", text: "Take over" },
  "interview.updateItem": { id, itemId: 1, text: "Take over" },
  "interview.removeItem": { id, itemId: 1 },
  "readBack.get": { id },
  "readBack.write": { id },
  "readBack.correct": { id, target: { part: "steps", index: 0 }, answer: "Take over" },
  "website.read": { id, address: "https://bakery.example/", whose: "mine" },
  "design.get": { id },
  "design.pick": { id, style: "bold" },
  "files.list": { id },
  "files.rename": { id, fileId: 1, displayName: "Taken over" },
  "files.delete": { id, fileId: 1 },
  "files.read": { id, fileId: 1 },
  // Always the caller's own business, so nothing to aim at another's.
  "usage.time": undefined,
  "builds.list": { id },
  "builds.events": { buildId },
  "builds.summaries": { buildId },
  "builds.editQueued": { buildId, request: "Take over" },
  "builds.removeQueued": { buildId },
  "builds.picture": { buildId, width: "desktop" },
  "builds.acceptance": { buildId },
});
const takesAnId = (input: unknown) => typeof input === "object" && input !== null;
// The caller's own account: about the person, never a project or build.
const isOwnAccount = (path: string) => path.startsWith("account.");
// These act on the caller's own business and take no project or build; members.test.ts walks them.
const ownBusiness = (path: string) => path.startsWith("business.");

// A project with a spec and a running build, in the given business.
const aBuiltProject = async (tenantId: number) => {
  const project = await createProject(db, { name: `walk ${randomUUID()}`, tenantId });
  await transition(db, project.id, ["draft"], { status: "spec_ready", spec: "## Features" });
  const { build } = await approveSpec(deps, project.id);
  return { project, build };
};

describe("every procedure", () => {
  it("is covered by the walk below", () => {
    expect(Object.keys(everyCall(1, 1)).sort()).toEqual([...customerPaths].sort());
  });

  it("answers UNAUTHORIZED to a signed-out caller, except the three open ones", async () => {
    const owner = await aSignedInPerson(app, deps);
    const { project, build } = await aBuiltProject(owner.tenantId);
    start.mockClear();
    try {
      const calls = everyCall(project.id, build.id);
      const closed = customerPaths.filter((path) => !OPEN.includes(path));
      expect(closed).toHaveLength(customerPaths.length - OPEN.length);
      for (const path of closed)
        expect([path, (await callApi(app, path, calls[path])).code]).toEqual([
          path,
          "UNAUTHORIZED",
        ]);
      for (const path of OPEN)
        expect((await callApi(app, path, calls[path])).code).not.toBe("UNAUTHORIZED");
      expect(start).not.toHaveBeenCalled();
      expect(interviewer).not.toHaveBeenCalled();
      expect(siteFetcher).not.toHaveBeenCalled();
      expect(websiteReader).not.toHaveBeenCalled();
      expect(reader).not.toHaveBeenCalled();
      Object.values(stored).forEach((call) => expect(call).not.toHaveBeenCalled());
    } finally {
      await finishBuild(db, build.id);
    }
  });

  it("answers NOT_FOUND for a project or build in another business, and changes nothing", async () => {
    const owner = await aSignedInPerson(app, deps);
    const other = await aSignedInPerson(app, deps, { name: "Mallory" });
    const { project, build } = await aBuiltProject(owner.tenantId);
    const [before] = await db.select().from(projects).where(eq(projects.id, project.id));
    start.mockClear();
    try {
      const calls = everyCall(project.id, build.id);
      const scoped = customerPaths.filter(
        (path) =>
          !OPEN.includes(path) &&
          !isOwnAccount(path) &&
          takesAnId(calls[path]) &&
          path !== "projects.create" &&
          path !== "setup.createBusiness" &&
          !ownBusiness(path)
      );
      expect(scoped.length).toBeGreaterThan(15);
      for (const path of scoped)
        expect([path, (await callApi(app, path, calls[path], other.cookie)).code]).toEqual([
          path,
          "NOT_FOUND",
        ]);
      const [after] = await db.select().from(projects).where(eq(projects.id, project.id));
      expect(after).toEqual(before);
      expect(start).not.toHaveBeenCalled();
      expect(interviewer).not.toHaveBeenCalled();
      expect(siteFetcher).not.toHaveBeenCalled();
      expect(websiteReader).not.toHaveBeenCalled();
      expect(reader).not.toHaveBeenCalled();
      Object.values(stored).forEach((call) => expect(call).not.toHaveBeenCalled());
    } finally {
      await finishBuild(db, build.id);
    }
  });

  it("says the same thing for another business's project as for one that does not exist", async () => {
    const owner = await aSignedInPerson(app, deps);
    const other = await aSignedInPerson(app, deps, { name: "Mallory" });
    const project = await createProject(db, { name: "Secret", tenantId: owner.tenantId });
    const theirs = await callApi(app, "projects.get", { id: project.id }, other.cookie);
    const missing = await callApi(app, "projects.get", { id: 2_000_000_000 }, other.cookie);
    expect(theirs.message).toBe(missing.message?.replace("2000000000", String(project.id)));
    expect(theirs.message).not.toContain("Secret");
  });
});

// A person approved with no business named, who has set a password and signed in.
const aNewcomer = async (name = "Ada Example") => {
  const { email, token } = await approveEmail(db, anEmail());
  await acceptInvite(deps, { token, name, password: PASSWORD });
  const { cookie } = await signIn(app, email);
  return { email, cookie };
};
const businessesFor = async (cookie: string) =>
  (await callApi(app, "session.get", undefined, cookie)).data.businesses;

describe("first-run setup", () => {
  it("leaves a new person with no business until they set one up", async () => {
    const ada = await aNewcomer();
    expect(await businessesFor(ada.cookie)).toEqual([]);
    expect((await callApi(app, "projects.list", undefined, ada.cookie)).code).toBe("FORBIDDEN");
  });

  it("makes the business with the person as its owner, and saves their name", async () => {
    const ada = await aNewcomer("Ada");
    const made = await callApi(
      app,
      "setup.createBusiness",
      {
        yourName: " Ada Lovelace ",
        name: " Lovelace Engines ",
        country: "GB",
        description: " Analytical engines, made to order ",
      },
      ada.cookie
    );
    expect(made.status).toBe(200);
    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, made.data.id));
    expect(tenant).toMatchObject({
      name: "Lovelace Engines",
      country: "GB",
      description: "Analytical engines, made to order",
    });
    expect(await businessesFor(ada.cookie)).toEqual([
      { id: made.data.id, name: "Lovelace Engines", suspended: false },
    ]);
    const business = await callApi(app, "business.get", undefined, ada.cookie);
    expect(business.data.role).toBe("owner");
    expect(business.data.members).toEqual([
      expect.objectContaining({ email: ada.email, name: "Ada Lovelace", role: "owner" }),
    ]);
  });

  it("names the business after the person, with no description, when those are left empty", async () => {
    const ada = await aNewcomer();
    const made = await callApi(
      app,
      "setup.createBusiness",
      { yourName: "Ada", name: "  ", country: "DE", description: "" },
      ada.cookie
    );
    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, made.data.id));
    expect(tenant).toMatchObject({ name: "Ada’s business", country: "DE", description: null });
  });

  it("refuses a missing name, an unknown country, and a description over one line", async () => {
    const ada = await aNewcomer();
    for (const input of [
      { yourName: " ", country: "DE" },
      { yourName: "Ada", country: "ZZ" },
      { yourName: "Ada" },
      { yourName: "Ada", country: "DE", description: "x".repeat(201) },
      { yourName: "Ada", country: "DE", description: "one\ntwo" },
    ])
      expect((await callApi(app, "setup.createBusiness", input, ada.cookie)).code).toBe(
        "BAD_REQUEST"
      );
    expect(await businessesFor(ada.cookie)).toEqual([]);
  });

  it("makes one business, and refuses a second, for a person who already has one", async () => {
    const ada = await aNewcomer();
    const input = { yourName: "Ada", country: "DE" };
    const answers = await Promise.all(
      [1, 2].map(() => callApi(app, "setup.createBusiness", input, ada.cookie))
    );
    expect(answers.map((answer) => answer.status).sort()).toEqual([200, 409]);
    expect(answers.find((answer) => answer.status === 409)?.message).toContain("already");
    expect(await businessesFor(ada.cookie)).toHaveLength(1);
  });

  it("is skipped by a person whose invitation names a business", async () => {
    const demo = await findTenantBySlug(db, "demo");
    const teammate = await aSignedInPerson(app, deps, { joins: demo });
    expect(teammate.businesses.map(({ id }) => id)).toEqual([demo]);
  });
});

describe("a business", () => {
  it("is made for a new person in setup, who then sees only what is in it", async () => {
    const ada = await aSignedInPerson(app, deps, { name: "Ada Example" });
    const bob = await aSignedInPerson(app, deps, { name: "Bob Example" });
    expect(ada.businesses).toEqual([
      { id: ada.tenantId, name: "Ada Example’s business", suspended: false },
    ]);
    expect(bob.tenantId).not.toBe(ada.tenantId);

    const created = await callApi(app, "projects.create", { name: "Invoices" }, ada.cookie);
    expect(created.data.tenantId).toBe(ada.tenantId);
    const adas = await callApi(app, "projects.list", undefined, ada.cookie);
    const bobs = await callApi(app, "projects.list", undefined, bob.cookie);
    expect(adas.data.map((project: { id: number }) => project.id)).toEqual([created.data.id]);
    expect(bobs.data).toEqual([]);
  });

  it("can be named by an approval, so a teammate joins it instead of getting their own", async () => {
    const demo = await findTenantBySlug(db, "demo");
    const teammate = await aSignedInPerson(app, deps, { joins: demo });
    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, demo));
    expect(teammate.businesses).toEqual([{ id: demo, name: tenant.name, suspended: false }]);
    expect(tenant.name).toBe("Demo business");
  });

  it("is chosen with a header by a person in several, and never one they are not in", async () => {
    const ada = await aSignedInPerson(app, deps);
    const bob = await aSignedInPerson(app, deps, { name: "Bob Example" });
    // Ada is also let into Bob's business.
    await approveEmail(db, ada.email, { tenantId: bob.tenantId });
    const inBobs = { [BUSINESS_HEADER]: String(bob.tenantId) };
    const inAdas = { [BUSINESS_HEADER]: String(ada.tenantId) };

    const shared = await callApi(app, "projects.create", { name: "Shared" }, ada.cookie, inBobs);
    expect(shared.data.tenantId).toBe(bob.tenantId);
    expect((await callApi(app, "projects.list", undefined, ada.cookie)).data).toEqual([]);
    expect(
      (await callApi(app, "projects.get", { id: shared.data.id }, ada.cookie, inBobs)).status
    ).toBe(200);
    expect(
      (await callApi(app, "projects.get", { id: shared.data.id }, ada.cookie, inAdas)).code
    ).toBe("NOT_FOUND");

    // Bob names Ada's business, which he is not in: he stays in his own.
    const bobs = await callApi(app, "projects.list", undefined, bob.cookie, inAdas);
    expect(bobs.data.map((project: { id: number }) => project.id)).toEqual([shared.data.id]);
  });
});

// #56 and #89: an app's name, and bringing it back after "Take the app offline".
describe("an app's settings", () => {
  // An app whose first build passed, taken offline.
  const anOfflineApp = async (tenantId: number) => {
    const { project, build } = await aBuiltProject(tenantId);
    await finishBuild(db, build.id);
    return transition(db, project.id, ["building"], {
      status: "stopped",
      previewUrl: null,
      stagingUrl: null,
    });
  };
  const rowOf = async (id: number) =>
    (await db.select().from(projects).where(eq(projects.id, id)))[0];

  it("renames for a member of the business, keeping its slug and address", async () => {
    const owner = await aSignedInPerson(app, deps);
    const member = await aSignedInPerson(app, deps, { name: "Bob", joins: owner.tenantId });
    const project = await createProject(db, { name: "Invoices", tenantId: owner.tenantId });
    await transition(db, project.id, ["draft"], {
      status: "live",
      previewUrl: "http://localhost:8100",
    });

    const renamed = await callApi(
      app,
      "projects.rename",
      { id: project.id, name: "  Billing  " },
      member.cookie
    );

    expect(renamed.data).toMatchObject({ name: "Billing", slug: project.slug });
    expect(await rowOf(project.id)).toMatchObject({
      name: "Billing",
      slug: project.slug,
      previewUrl: "http://localhost:8100",
      status: "live",
    });
  });

  it("refuses a name a new app could not have, and keeps the old one", async () => {
    const owner = await aSignedInPerson(app, deps);
    const project = await createProject(db, { name: "Invoices", tenantId: owner.tenantId });
    for (const name of ["", "   ", "x".repeat(101)])
      expect(
        (await callApi(app, "projects.rename", { id: project.id, name }, owner.cookie)).code
      ).toBe("BAD_REQUEST");
    expect((await rowOf(project.id)).name).toBe("Invoices");
  });

  it("does not let a person outside the business rename the app or put it back online", async () => {
    const owner = await aSignedInPerson(app, deps);
    const outsider = await aSignedInPerson(app, deps, { name: "Mallory" });
    const project = await anOfflineApp(owner.tenantId);
    start.mockClear();

    for (const [path, input] of [
      ["projects.rename", { id: project.id, name: "Mine now" }],
      ["projects.start", { id: project.id }],
    ] as const)
      expect((await callApi(app, path, input, outsider.cookie)).code).toBe("NOT_FOUND");

    expect(await rowOf(project.id)).toMatchObject({ name: project.name, status: "stopped" });
    expect(start).not.toHaveBeenCalled();
  });

  it("puts an offline app back online for a member, without a new build", async () => {
    const owner = await aSignedInPerson(app, deps);
    const member = await aSignedInPerson(app, deps, { name: "Bob", joins: owner.tenantId });
    const project = await anOfflineApp(owner.tenantId);
    start.mockClear();
    start.mockResolvedValueOnce({ result: async () => undefined } as never);

    const answer = await callApi(app, "projects.start", { id: project.id }, member.cookie);

    expect(answer.status).toBe(200);
    expect(start).toHaveBeenCalledOnce();
    expect(start.mock.calls[0]).toEqual([
      "restartWorkflow",
      expect.objectContaining({ args: [project.id] }),
    ]);
  });

  it("refuses to put back online an app that is not offline, is building, or was never live", async () => {
    const owner = await aSignedInPerson(app, deps);
    const live = await createProject(db, { name: "Live", tenantId: owner.tenantId });
    await transition(db, live.id, ["draft"], { status: "live" });
    const { project: building, build } = await aBuiltProject(owner.tenantId);
    const neverLive = await createProject(db, { name: "Never", tenantId: owner.tenantId });
    await transition(db, neverLive.id, ["draft"], { status: "stopped" });
    start.mockClear();
    try {
      for (const id of [live.id, building.id, neverLive.id])
        expect((await callApi(app, "projects.start", { id }, owner.cookie)).code).toBe("CONFLICT");
      expect(start).not.toHaveBeenCalled();
      expect((await rowOf(building.id)).status).toBe("building");
    } finally {
      await finishBuild(db, build.id);
    }
  });
});
