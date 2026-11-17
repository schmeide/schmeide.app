import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.ts";
import { createDb } from "../db/client.ts";
import { builds } from "../db/schema.ts";
import type { AppContext } from "../router.ts";
import { createProject } from "../services/projects.ts";
import {
  copyOf,
  readResources,
  type ResourceReader,
  type RuntimeFigures,
} from "../services/resources.ts";
import { aSignedInAdmin, aSignedInPerson, adminPaths, callApi, testAuth } from "./testAuth.ts";

const db = createDb(process.env.DATABASE_URL ?? "");
afterAll(() => db.$client.end());

// What the container runtime and the disk report, as each test sets it.
const reader = {
  runtime: vi.fn<ResourceReader["runtime"]>(),
  workspaceBytes: vi.fn<ResourceReader["workspaceBytes"]>(),
};

const deps: AppContext = {
  db,
  workflows: { start: vi.fn(), getHandle: vi.fn() as never },
  taskQueue: "test",
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

type ProjectRow = {
  readonly id: number;
  readonly name: string;
  readonly status: string;
  readonly webPort: number;
  readonly business: { readonly id: number; readonly name: string };
  readonly lastBuild: { readonly status: string; readonly startedAt: string } | null;
};
type Page<T> = { readonly entries: readonly T[]; readonly nextCursor: number | null };

const running = (figures: Readonly<Record<string, RuntimeFigures>>) =>
  reader.runtime.mockResolvedValue(new Map(Object.entries(figures)));

describe("the hosting procedures", () => {
  it("are on the admin base, which admin.test.ts walks as an owner and as nobody", () => {
    expect(adminPaths).toEqual(
      expect.arrayContaining(["admin.projects.list", "admin.projects.resources"])
    );
  });
});

describe("listing projects", () => {
  it("includes every business's, with the business, port, and last build", async () => {
    const admin = await aSignedInAdmin(app, deps);
    const owner = await aSignedInPerson(app, deps, { name: "Olive" });
    const name = `Invoices ${randomUUID().slice(0, 8)}`;
    const project = await createProject(db, { name, tenantId: owner.tenantId });
    await db.insert(builds).values([
      { projectId: project.id, kind: "initial", request: "", status: "passed" },
      { projectId: project.id, kind: "change", request: "", status: "failed" },
      // Waiting changes have not run, so they are not the last build.
      { projectId: project.id, kind: "change", request: "", status: "queued" },
    ]);

    const page = (await callApi(app, "admin.projects.list", { search: name }, admin.cookie))
      .data as Page<ProjectRow>;
    expect(page.entries).toEqual([
      {
        id: project.id,
        name,
        slug: project.slug,
        status: "draft",
        webPort: project.webPort,
        stagingWebPort: project.webPort + 10_000,
        business: { id: owner.tenantId, name: "Olive’s business" },
        lastBuild: { kind: "change", status: "failed", startedAt: expect.any(String) },
      },
    ]);
  });

  it("searches by business name too, and shows a project never built", async () => {
    const admin = await aSignedInAdmin(app, deps);
    const marker = randomUUID().slice(0, 8);
    const owner = await aSignedInPerson(app, deps, { name: `Bakery ${marker}` });
    const project = await createProject(db, { name: "Orders", tenantId: owner.tenantId });
    const page = (await callApi(app, "admin.projects.list", { search: marker }, admin.cookie))
      .data as Page<ProjectRow>;
    expect(page.entries).toEqual([expect.objectContaining({ id: project.id, lastBuild: null })]);
  });
});

describe("what a project takes up", () => {
  it("is what the runtime and the disk report, both copies of an app counted together", async () => {
    const admin = await aSignedInAdmin(app, deps);
    const owner = await aSignedInPerson(app, deps);
    const live = await createProject(db, { name: "Live one", tenantId: owner.tenantId });
    const idle = await createProject(db, { name: "Idle one", tenantId: owner.tenantId });
    running({
      [copyOf("", live.slug, "production").composeProject]: {
        containers: 2,
        memoryBytes: 1024,
        cpuPercent: 1.5,
      },
      [copyOf("", live.slug, "staging").composeProject]: {
        containers: 3,
        memoryBytes: 2048,
        cpuPercent: 0.5,
      },
    });
    reader.workspaceBytes.mockImplementation(async (slug) => (slug === live.slug ? 4096 : 0));

    const { data } = await callApi(
      app,
      "admin.projects.resources",
      { ids: [live.id, idle.id] },
      admin.cookie
    );
    expect(data).toEqual([
      { id: live.id, containers: 5, memoryBytes: 3072, cpuPercent: 2, workspaceBytes: 4096 },
      // Nothing running is a known zero, not unknown.
      { id: idle.id, containers: 0, memoryBytes: 0, cpuPercent: 0, workspaceBytes: 0 },
    ]);
  });

  it("is unknown when the runtime or the disk fails, and the answer still comes", async () => {
    const admin = await aSignedInAdmin(app, deps);
    const owner = await aSignedInPerson(app, deps);
    const project = await createProject(db, { name: "Broken", tenantId: owner.tenantId });
    reader.runtime.mockRejectedValue(new Error("Cannot connect to the Docker daemon"));
    reader.workspaceBytes.mockRejectedValue(new Error("EACCES"));

    const { status, data } = await callApi(
      app,
      "admin.projects.resources",
      { ids: [project.id] },
      admin.cookie
    );
    expect(status).toBe(200);
    expect(data).toEqual([
      {
        id: project.id,
        containers: null,
        memoryBytes: null,
        cpuPercent: null,
        workspaceBytes: null,
      },
    ]);
  });

  it("is unknown when the runtime does not answer in time", async () => {
    const hanging: ResourceReader = {
      runtime: () => new Promise(() => undefined),
      workspaceBytes: async () => 10,
    };
    const started = Date.now();
    expect(await readResources(hanging, [{ id: 1, slug: "slow" }], 50)).toEqual([
      { id: 1, containers: null, memoryBytes: null, cpuPercent: null, workspaceBytes: 10 },
    ]);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("tells the reader when to give up", async () => {
    const signals: AbortSignal[] = [];
    const hanging: ResourceReader = {
      runtime: (signal) => {
        signals.push(signal);
        return new Promise(() => undefined);
      },
      workspaceBytes: async () => 0,
    };
    await readResources(hanging, [{ id: 1, slug: "slow" }], 20);
    expect(signals[0].aborted).toBe(true);
  });
});
