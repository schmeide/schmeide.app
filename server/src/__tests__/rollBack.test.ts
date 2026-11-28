import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.ts";
import { createDb } from "../db/client.ts";
import { builds, databaseCopies, projects } from "../db/schema.ts";
import type { AppContext } from "../router.ts";
import { createProject } from "../services/projects.ts";
import { aSignedInPerson, testAuth } from "./testAuth.ts";

const db = createDb(process.env.DATABASE_URL ?? "");
afterAll(() => db.$client.end());

const workflows = { start: vi.fn(), getHandle: vi.fn() };
const deps: AppContext = {
  db,
  workflows: workflows as never,
  taskQueue: "test",
  interviewer: vi.fn(),
  siteFetcher: vi.fn(),
  websiteReader: vi.fn(),
  files: {} as never,
  reader: vi.fn(),
  resources: { runtime: vi.fn(), workspaceBytes: vi.fn() },
  auth: testAuth(db),
  providers: [],
};
const app = buildApp(deps);
afterAll(() => app.close());

const commit = (version: number) => String(version).padStart(40, "0");

describe("projects.rollBack", () => {
  it("answers a refusal with the copies it can go back with instead", async () => {
    const owner = await aSignedInPerson(app, deps);
    const project = await createProject(db, { name: "Orders", tenantId: owner.tenantId });
    await db
      .update(projects)
      .set({ status: "live", productionCommit: commit(2), stagingCommit: commit(2) })
      .where(eq(projects.id, project.id));
    const [, second] = await db
      .insert(builds)
      .values(
        [1, 2].map((version) => ({
          projectId: project.id,
          kind: version === 1 ? ("initial" as const) : ("change" as const),
          request: `version ${version}`,
          status: "passed" as const,
          commit: commit(version),
          baseCommit: version === 1 ? null : commit(version - 1),
          version,
          additive: version === 1,
          release: "promoted" as const,
        }))
      )
      .returning();
    const [copy] = await db
      .insert(databaseCopies)
      .values({
        projectId: project.id,
        buildId: second.id,
        version: 1,
        takenAt: new Date("2026-11-12T14:02:00Z"),
        path: "/nowhere",
        bytes: 1,
      })
      .returning();

    const response = await app.inject({
      method: "POST",
      url: "/trpc/projects.rollBack",
      headers: { cookie: owner.cookie },
      payload: { json: { id: project.id, version: 1 } },
    });

    const { error } = response.json();
    expect(response.statusCode).toBe(409);
    expect(error.json.message).toBe(
      "Version 2 changed how your app stores its information, so version 1 cannot read it. You can go back to version 1 with the information from 12 November, 14:02 UTC."
    );
    expect(error.json.data.reason).toBe(
      "Version 2 changed how your app stores its information, so version 1 cannot read it."
    );
    expect(error.json.data.copies).toEqual([
      { id: copy.id, version: 1, takenAt: "2026-11-12T14:02:00.000Z" },
    ]);
    expect(workflows.start).not.toHaveBeenCalled();
  });
});
