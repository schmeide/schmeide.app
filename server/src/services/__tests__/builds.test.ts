import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createDb } from "../../db/client.ts";
import { builds } from "../../db/schema.ts";
import { appendEvent, finishBuild, listEvents } from "../builds.ts";
import { createProject } from "../projects.ts";
import { DEMO_TENANT_ID } from "../../__tests__/testAuth.ts";

const db = createDb(process.env.DATABASE_URL ?? "");
afterAll(() => db.$client.end());

// Status "passed" so this build never counts as the one running build.
const newBuild = async () => {
  const project = await createProject(db, { name: `b ${randomUUID()}`, tenantId: DEMO_TENANT_ID });
  const [build] = await db
    .insert(builds)
    .values({ projectId: project.id, kind: "initial", request: "spec", status: "passed" })
    .returning();
  return build;
};

describe("build events", () => {
  it("pages forward from the last id seen", async () => {
    const build = await newBuild();
    const first = await appendEvent(db, build.id, "step", "one");
    await appendEvent(db, build.id, "agent", "two");
    await appendEvent(db, build.id, "check", "three");

    const all = await listEvents(db, build.id, 0);
    const rest = await listEvents(db, build.id, first.id);

    expect(all.map((event) => event.message)).toEqual(["one", "two", "three"]);
    expect(rest.map((event) => event.message)).toEqual(["two", "three"]);
    expect(await listEvents(db, build.id, all[2].id)).toEqual([]);
  });

  it("finishes a build as failed with its error", async () => {
    const build = await newBuild();

    const finished = await finishBuild(db, build.id, "make test failed");

    expect(finished).toMatchObject({ status: "failed", error: "make test failed" });
    expect(finished.finishedAt).toBeInstanceOf(Date);
  });
});
