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

const specReady = async () => {
  const project = await createProject(db, { name: `api ${randomUUID()}` });
  return transition(db, project.id, ["draft"], { status: "spec_ready", spec: "## Features" });
};

describe("the API", () => {
  it("marks a build refused because another one runs with reason buildRunning", async () => {
    const app = buildApp(deps);
    const approve = (id: number) =>
      app.inject({
        method: "POST",
        url: "/api/trpc/projects.approveSpec",
        payload: { json: { id } },
      });
    const { build } = await approveSpec(deps, (await specReady()).id);
    const other = await specReady();
    try {
      const busy = await approve(other.id);

      expect(busy.statusCode).toBe(409);
      expect(busy.json().error.json.data).toMatchObject({
        code: "CONFLICT",
        reason: "buildRunning",
      });
    } finally {
      await finishBuild(db, build.id);
    }
    const draft = await createProject(db, { name: `api ${randomUUID()}` });
    const conflict = await approve(draft.id);
    await app.close();

    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.json.data).not.toHaveProperty("reason");
  });
});
