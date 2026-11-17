import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.ts";
import { createDb } from "../db/client.ts";
import { projects, tenants } from "../db/schema.ts";
import { BUSINESS_HEADER, type AppContext } from "../router.ts";
import { approveEmail } from "../services/access.ts";
import { findTenantBySlug } from "../services/businesses.ts";
import { approveSpec, createProject, transition } from "../services/projects.ts";
import { finishBuild } from "../services/builds.ts";
import {
  adminPaths,
  aSignedInPerson,
  callApi,
  impersonationPaths,
  procedurePaths,
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
  "projects.list": undefined,
  "projects.create": { name: `walk ${randomUUID()}` },
  "projects.get": { id },
  "projects.setFeatures": { id, features: "Take over" },
  "projects.generateSpec": { id },
  "projects.approveSpec": { id },
  "projects.requestChange": { id, request: "Take over" },
  "projects.setSite": { id, title: "Taken over" },
  "projects.promote": { id },
  "projects.discard": { id },
  "projects.stop": { id },
  "projects.delete": { id },
  "interview.get": { id },
  "interview.start": { id },
  "interview.answer": { id, questionId: 1, answer: { type: "text", value: "Take over" } },
  "interview.addItem": { id, section: "does", text: "Take over" },
  "interview.updateItem": { id, itemId: 1, text: "Take over" },
  "interview.removeItem": { id, itemId: 1 },
  "website.read": { id, address: "https://bakery.example/", whose: "mine" },
  "design.get": { id },
  "design.pick": { id, style: "bold" },
  "files.list": { id },
  "files.rename": { id, fileId: 1, displayName: "Taken over" },
  "files.delete": { id, fileId: 1 },
  "files.read": { id, fileId: 1 },
  // Always the caller's own business, so nothing to aim at another's.
  "usage.time": undefined,
  "builds.events": { buildId },
  "builds.summaries": { buildId },
  "builds.editQueued": { buildId, request: "Take over" },
  "builds.removeQueued": { buildId },
});
const takesAnId = (input: unknown) => typeof input === "object" && input !== null;

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
        (path) => !OPEN.includes(path) && takesAnId(calls[path]) && path !== "projects.create"
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

describe("a business", () => {
  it("is made for a new person, who then sees only what is in it", async () => {
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

  it("is made once when a new person's first requests arrive together", async () => {
    const ada = await aSignedInPerson(app, deps);
    const answers = await Promise.all(
      Array.from({ length: 5 }, () => callApi(app, "session.get", undefined, ada.cookie))
    );
    expect(new Set(answers.map((answer) => answer.data.businesses[0].id)).size).toBe(1);
    expect(answers.every((answer) => answer.data.businesses.length === 1)).toBe(true);
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
