import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.ts";
import { createDb } from "../db/client.ts";
import { finishBuild } from "../services/builds.ts";
import { approveSpec, createProject, transition, type Deps } from "../services/projects.ts";

const db = createDb(process.env.DATABASE_URL ?? "");
afterAll(() => db.$client.end());

const deps: Deps = {
  db,
  workflows: { start: vi.fn(async () => ({}) as never), getHandle: vi.fn() as never },
  taskQueue: "test",
};

describe("the API", () => {
  it("answers CONFLICT when a running build is edited as if it were queued", async () => {
    const app = buildApp(deps);
    const project = await createProject(db, { name: `api ${randomUUID()}` });
    await transition(db, project.id, ["draft"], { status: "spec_ready", spec: "## Features" });
    const { build } = await approveSpec(deps, project.id);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/trpc/builds.editQueued",
        payload: { json: { buildId: build.id, request: "something else" } },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().error.json.data).toMatchObject({ code: "CONFLICT" });
    } finally {
      await finishBuild(db, build.id);
      await app.close();
    }
  });
});
