import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.ts";
import { createDb } from "../db/client.ts";
import { builds } from "../db/schema.ts";
import type { AppContext } from "../router.ts";
import { BUILDS_OFF } from "../services/errors.ts";
import { createProject, transition } from "../services/projects.ts";
import type { ResourceReader } from "../services/resources.ts";
import { aSignedInAdmin, aSignedInPerson, callApi, testAuth } from "./testAuth.ts";

const db = createDb(process.env.DATABASE_URL ?? "");
afterAll(() => db.$client.end());

const reader = {
  runtime: vi.fn<ResourceReader["runtime"]>(),
  workspaceBytes: vi.fn<ResourceReader["workspaceBytes"]>(),
};
const workflows = { start: vi.fn(), getHandle: vi.fn() };

// A server started with SCHMEIDE_BUILDS=off: Stage 1 on AKS, which builds and hosts nothing.
const deps: AppContext = {
  db,
  workflows: workflows as never,
  taskQueue: "test",
  buildsOff: true,
  interviewer: vi.fn(),
  siteFetcher: vi.fn(),
  websiteReader: vi.fn(),
  files: {} as never,
  reader: vi.fn(),
  resources: reader,
  auth: testAuth(db),
  providers: [],
};
const app = buildApp(deps);
afterAll(() => app.close());

describe("with builds off", () => {
  it("tells the client so with the session", async () => {
    const owner = await aSignedInPerson(app, deps);
    const { data } = await callApi(app, "session.get", undefined, owner.cookie);
    expect(data).toMatchObject({ buildsOff: true, canBuild: false });
  });

  it("refuses to build an approved spec and starts nothing", async () => {
    const owner = await aSignedInPerson(app, deps);
    const project = await createProject(db, { name: "Orders", tenantId: owner.tenantId });
    await transition(db, project.id, ["draft"], { status: "spec_ready", spec: "## Features" });

    const answer = await callApi(app, "projects.approveSpec", { id: project.id }, owner.cookie);

    expect(answer).toMatchObject({ code: "CONFLICT", message: BUILDS_OFF });
    expect(workflows.start).not.toHaveBeenCalled();
    const { data } = await callApi(app, "projects.get", { id: project.id }, owner.cookie);
    expect(data.project.status).toBe("spec_ready");
    expect(await db.select().from(builds).where(eq(builds.projectId, project.id))).toEqual([]);
  });

  it("refuses a change and a stop", async () => {
    const owner = await aSignedInPerson(app, deps);
    const project = await createProject(db, { name: "Stopped", tenantId: owner.tenantId });
    await transition(db, project.id, ["draft"], { status: "stopped" });

    expect(
      await callApi(app, "projects.requestChange", { id: project.id, request: "x" }, owner.cookie)
    ).toMatchObject({ code: "CONFLICT", message: BUILDS_OFF });
    expect(await callApi(app, "projects.stop", { id: project.id }, owner.cookie)).toMatchObject({
      code: "CONFLICT",
      message: BUILDS_OFF,
    });
    expect(workflows.start).not.toHaveBeenCalled();
  });

  it("refuses to put staging live or throw it away, before anything else is checked", async () => {
    const owner = await aSignedInPerson(app, deps);
    const project = await createProject(db, { name: "Released", tenantId: owner.tenantId });
    await transition(db, project.id, ["draft"], { status: "live" });

    for (const procedure of ["projects.promote", "projects.discard"])
      expect(await callApi(app, procedure, { id: project.id }, owner.cookie)).toMatchObject({
        code: "CONFLICT",
        message: BUILDS_OFF,
      });
    expect(workflows.start).not.toHaveBeenCalled();
    expect(await db.select().from(builds).where(eq(builds.projectId, project.id))).toEqual([]);
  });

  it("answers unknown resources without asking the runtime or the disk", async () => {
    const admin = await aSignedInAdmin(app, deps);
    const owner = await aSignedInPerson(app, deps);
    const project = await createProject(db, { name: "Idle", tenantId: owner.tenantId });

    const { data } = await callApi(
      app,
      "admin.projects.resources",
      { ids: [project.id] },
      admin.cookie
    );

    expect(data).toEqual([
      {
        id: project.id,
        containers: null,
        memoryBytes: null,
        cpuPercent: null,
        workspaceBytes: null,
      },
    ]);
    expect(reader.runtime).not.toHaveBeenCalled();
    expect(reader.workspaceBytes).not.toHaveBeenCalled();
  });
});
