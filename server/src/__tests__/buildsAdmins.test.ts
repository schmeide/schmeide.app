import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.ts";
import { createDb } from "../db/client.ts";
import type { AppContext } from "../router.ts";
import { grantAdmin } from "../services/access.ts";
import { COMMAND_LINE } from "../services/audit.ts";
import { BUILDS_OFF } from "../services/errors.ts";
import { createProject, transition } from "../services/projects.ts";
import { aSignedInAdmin, aSignedInPerson, callApi, TEST_ORIGIN, testAuth } from "./testAuth.ts";

const db = createDb(process.env.DATABASE_URL ?? "");
afterAll(() => db.$client.end());

const workflows = { start: vi.fn(async () => ({}) as never), getHandle: vi.fn() };
beforeEach(() => workflows.start.mockClear());

// A server started with SCHMEIDE_BUILDS=admins: slice 1 of docs/stage2.md, where only admins build.
const deps: AppContext = {
  db,
  workflows: workflows as never,
  taskQueue: "test",
  buildsAdminsOnly: true,
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

// An admin who is also a member of a business of their own, so they have projects to build.
const anAdminWithABusiness = async () => {
  const admin = await aSignedInPerson(app, deps, { name: "Grace Admin" });
  await grantAdmin(db, admin.email, COMMAND_LINE);
  return admin;
};

const aReadySpec = async (tenantId: number) => {
  const project = await createProject(db, { name: "Orders", tenantId });
  await transition(db, project.id, ["draft"], { status: "spec_ready", spec: "## Features" });
  return project;
};

describe("with builds for admins only", () => {
  it("lets an admin build, and says so with the session", async () => {
    const admin = await anAdminWithABusiness();
    const project = await aReadySpec(admin.tenantId);

    const session = await callApi(app, "session.get", undefined, admin.cookie);
    expect(session.data).toMatchObject({ buildsOff: false, canBuild: true });

    const { data } = await callApi(app, "projects.approveSpec", { id: project.id }, admin.cookie);
    expect(data.project.status).toBe("building");
    expect(workflows.start).toHaveBeenCalledOnce();
  });

  it("refuses everyone else exactly as builds off does", async () => {
    const owner = await aSignedInPerson(app, deps);
    const project = await aReadySpec(owner.tenantId);

    const session = await callApi(app, "session.get", undefined, owner.cookie);
    expect(session.data).toMatchObject({ buildsOff: false, canBuild: false });

    expect(
      await callApi(app, "projects.approveSpec", { id: project.id }, owner.cookie)
    ).toMatchObject({ code: "CONFLICT", message: BUILDS_OFF });
    const live = await createProject(db, { name: "Live", tenantId: owner.tenantId });
    await transition(db, live.id, ["draft"], { status: "live" });
    for (const [procedure, input] of [
      ["projects.requestChange", { id: live.id, request: "x" }],
      ["projects.setSite", { id: live.id, title: "Shop" }],
      ["projects.promote", { id: live.id }],
      ["projects.discard", { id: live.id }],
      ["projects.rollBack", { id: live.id, version: 1 }],
      ["projects.stop", { id: live.id }],
    ] as const)
      expect(await callApi(app, procedure, input, owner.cookie)).toMatchObject({
        code: "CONFLICT",
        message: BUILDS_OFF,
      });
    expect(workflows.start).not.toHaveBeenCalled();
    const { data } = await callApi(app, "projects.get", { id: project.id }, owner.cookie);
    expect(data.project.status).toBe("spec_ready");
  });

  it("refuses a member's change while an admin's build runs, rather than queue it", async () => {
    const admin = await anAdminWithABusiness();
    const member = await aSignedInPerson(app, deps, { joins: admin.tenantId });
    const project = await aReadySpec(admin.tenantId);
    await callApi(app, "projects.approveSpec", { id: project.id }, admin.cookie);
    const queued = await callApi(
      app,
      "projects.requestChange",
      { id: project.id, request: "Add a due date" },
      admin.cookie
    );
    expect(queued.data.build.status).toBe("queued");

    expect(
      await callApi(app, "projects.requestChange", { id: project.id, request: "x" }, member.cookie)
    ).toMatchObject({ code: "CONFLICT", message: BUILDS_OFF });
    expect(
      await callApi(
        app,
        "builds.editQueued",
        { buildId: queued.data.build.id, request: "x" },
        member.cookie
      )
    ).toMatchObject({ code: "CONFLICT", message: BUILDS_OFF });
  });

  // docs/auth.md, "Viewing as a customer": while viewing, the admin is not an admin.
  it("does not let an admin viewing as a customer build as them", async () => {
    const admin = await aSignedInAdmin(app, deps);
    const owner = await aSignedInPerson(app, deps, { name: "Olive Owner" });
    const project = await aReadySpec(owner.tenantId);
    const started = await app.inject({
      method: "POST",
      url: "/trpc/admin.impersonation.start",
      headers: { cookie: admin.cookie, origin: TEST_ORIGIN },
      payload: { json: { email: owner.email, reason: "Reproducing a stuck build" } },
    });
    // The answer clears the admin's cookies, then sets the view's: the browser keeps the last.
    const viewing = [...new Map(started.cookies.map(({ name, value }) => [name, value]))]
      .filter(([, value]) => value)
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");

    const session = await callApi(app, "session.get", undefined, viewing);
    expect(session.data.impersonatedBy).not.toBeNull();
    expect(session.data.canBuild).toBe(false);
    expect(await callApi(app, "projects.approveSpec", { id: project.id }, viewing)).toMatchObject({
      code: "CONFLICT",
      message: BUILDS_OFF,
    });
    expect(workflows.start).not.toHaveBeenCalled();
  });
});
