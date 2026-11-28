import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.ts";
import { createDb } from "../db/client.ts";
import { builds, usage, users, versionPictures, type NewUsage } from "../db/schema.ts";
import type { AppContext } from "../router.ts";
import { createProject } from "../services/projects.ts";
import { aSignedInPerson, callApi, testAuth } from "./testAuth.ts";

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
  providers: [],
};
const app = buildApp(deps);
afterAll(() => app.close());

type Listed = {
  readonly id: number;
  readonly kind: string;
  readonly request: string;
  readonly status: string;
  readonly error: string | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly costUsd: number;
  readonly version: number | null;
  readonly movedTo: number | null;
  readonly by: string | null;
};
type Page = { readonly builds: readonly Listed[]; readonly nextCursor: number | null };

const spend = (projectId: number, buildId: number, costUsd: number, runKind: NewUsage["runKind"]) =>
  db.insert(usage).values({
    projectId,
    buildId,
    runKind,
    model: "claude-sonnet",
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd,
  });

const aProjectWithBuilds = async () => {
  const owner = await aSignedInPerson(app, deps, { name: "Hal" });
  const project = await createProject(db, { name: "History", tenantId: owner.tenantId });
  const rows = await db
    .insert(builds)
    .values([
      {
        projectId: project.id,
        kind: "initial",
        request: "spec",
        status: "passed",
        finishedAt: new Date(),
      },
      {
        projectId: project.id,
        kind: "change",
        request: "Add a menu",
        status: "failed",
        error: "Tests failed",
      },
      { projectId: project.id, kind: "site", request: "title", status: "passed" },
      { projectId: project.id, kind: "change", request: "Later", status: "queued" },
    ])
    .returning();
  return { cookie: owner.cookie, project, rows };
};

describe("builds.list", () => {
  it("lists a project's builds newest first, without waiting ones, with each one's cost", async () => {
    const { cookie, project, rows } = await aProjectWithBuilds();
    const [initial, change, site] = rows;
    await spend(project.id, initial.id, 0.5, "initial");
    await spend(project.id, initial.id, 0.25, "initial");
    // Schmeide's own summaries are not the customer's cost.
    await spend(project.id, initial.id, 9, "summary");
    await spend(project.id, change.id, 0.1, "change");

    const answer = await callApi(app, "builds.list", { id: project.id }, cookie);
    const page = answer.data as Page;

    expect(page.builds.map((build) => build.id)).toEqual([site.id, change.id, initial.id]);
    expect(page.builds.map((build) => build.costUsd)).toEqual([0, 0.1, 0.75]);
    expect(page.builds[1]).toMatchObject({
      kind: "change",
      request: "Add a menu",
      status: "failed",
      error: "Tests failed",
      finishedAt: null,
    });
    expect(page.nextCursor).toBeNull();
  });

  it("pages with the cursor it answers", async () => {
    const { cookie, project, rows } = await aProjectWithBuilds();
    const [initial, change, site] = rows;

    const first = (await callApi(app, "builds.list", { id: project.id, limit: 2 }, cookie))
      .data as Page;
    expect(first.builds.map((build) => build.id)).toEqual([site.id, change.id]);
    expect(first.nextCursor).toBe(change.id);

    const second = (
      await callApi(
        app,
        "builds.list",
        { id: project.id, limit: 2, cursor: first.nextCursor },
        cookie
      )
    ).data as Page;
    expect(second.builds.map((build) => build.id)).toEqual([initial.id]);
    expect(second.nextCursor).toBeNull();
  });

  it("names each version, the version a release put live, and who asked", async () => {
    const owner = await aSignedInPerson(app, deps, { name: "Ann" });
    const [ann] = await db.select({ id: users.id }).from(users).where(eq(users.email, owner.email));
    const project = await createProject(db, { name: "Versions", tenantId: owner.tenantId });
    const commit = (n: number) => String(n).padStart(40, "0");
    await db.insert(builds).values([
      { projectId: project.id, kind: "initial", request: "spec", status: "passed" },
      {
        projectId: project.id,
        kind: "change",
        request: "Add a menu",
        status: "passed",
        commit: commit(2),
        version: 2,
        byUserId: ann.id,
      },
      {
        projectId: project.id,
        kind: "promote",
        request: "Put the version being worked on live",
        status: "passed",
        commit: commit(2),
        byUserId: ann.id,
      },
    ]);

    const page = (await callApi(app, "builds.list", { id: project.id }, owner.cookie)).data as Page;

    expect(
      page.builds.map(({ kind, version, movedTo, by }) => ({ kind, version, movedTo, by }))
    ).toEqual([
      { kind: "promote", version: null, movedTo: 2, by: "Ann" },
      { kind: "change", version: 2, movedTo: 2, by: "Ann" },
      { kind: "initial", version: null, movedTo: null, by: null },
    ]);
  });

  it("answers NOT_FOUND for another business's project", async () => {
    const { project } = await aProjectWithBuilds();
    const stranger = await aSignedInPerson(app, deps, { name: "Eve" });
    const answer = await callApi(app, "builds.list", { id: project.id }, stranger.cookie);
    expect(answer.code).toBe("NOT_FOUND");
  });
});

describe("builds.picture", () => {
  it("answers a version's picture as a WebP data URL, and null for a width it has none of", async () => {
    const { cookie, rows } = await aProjectWithBuilds();
    const [initial] = rows;
    await db
      .insert(versionPictures)
      .values({ buildId: initial.id, width: "desktop", data: "UklGRg==" });

    const desktop = await callApi(
      app,
      "builds.picture",
      { buildId: initial.id, width: "desktop" },
      cookie
    );
    expect(desktop.data).toBe("data:image/webp;base64,UklGRg==");
    const phone = await callApi(
      app,
      "builds.picture",
      { buildId: initial.id, width: "phone" },
      cookie
    );
    expect(phone.data).toBeNull();
  });

  it("refuses a build in another business", async () => {
    const { rows } = await aProjectWithBuilds();
    await db
      .insert(versionPictures)
      .values({ buildId: rows[0].id, width: "desktop", data: "UklGRg==" });
    const stranger = await aSignedInPerson(app, deps, { name: "Eve" });
    const answer = await callApi(
      app,
      "builds.picture",
      { buildId: rows[0].id, width: "desktop" },
      stranger.cookie
    );
    expect(answer.code).toBe("NOT_FOUND");
  });
});
