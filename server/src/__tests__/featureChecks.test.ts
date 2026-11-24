import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.ts";
import { createDb } from "../db/client.ts";
import { buildAcceptance, builds, projectAcceptance, projects } from "../db/schema.ts";
import type { AppRouter, AppContext } from "../router.ts";
import type { inferRouterOutputs } from "@trpc/server";
import { planFrom, specHash, SPEC_BUILD } from "../services/acceptance.ts";
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

type Outputs = inferRouterOutputs<AppRouter>;

const SPEC = "## Features\n- Photo carousel\n- Messages";
const check = (expect: string) => ({
  given: "A profile with three photos.",
  steps: ["Open the profile.", "Tap Next photo."],
  expect,
});
const PLAN = planFrom(
  {
    features: [
      { name: "Photo carousel", checks: [check("The second photo shows."), check("It wraps.")] },
      { name: "Messages", checks: [check("The message is in the thread.")] },
    ],
  },
  SPEC_BUILD
);

const aProjectWithChecks = async () => {
  const owner = await aSignedInPerson(app, deps, { name: "Ida" });
  const project = await createProject(db, { name: "Checks", tenantId: owner.tenantId });
  await db
    .update(projects)
    .set({ status: "spec_ready", spec: SPEC })
    .where(eq(projects.id, project.id));
  await db
    .insert(projectAcceptance)
    .values({ projectId: project.id, specHash: specHash(SPEC), plan: PLAN });
  return { cookie: owner.cookie, project };
};

// A passed build whose version staging runs, with what the tester found.
const aTestedVersion = async (projectId: number, commit: string) => {
  const [build] = await db
    .insert(builds)
    .values({ projectId, kind: "initial", request: "spec", status: "passed", commit })
    .returning();
  await db.insert(buildAcceptance).values([
    {
      buildId: build.id,
      checkId: "F1.1",
      feature: "Photo carousel",
      verdict: "works",
      saw: "It showed.",
      round: 2,
    },
    {
      buildId: build.id,
      checkId: "F1.2",
      feature: "Photo carousel",
      verdict: "broken",
      saw: "Tapped Next on the last photo; nothing happened.",
      round: 2,
    },
    {
      buildId: build.id,
      checkId: "F2.1",
      feature: "Messages",
      verdict: "works",
      saw: "It was there.",
      round: 2,
    },
  ]);
  await db
    .update(projects)
    .set({ status: "live", stagingCommit: commit })
    .where(eq(projects.id, projectId));
  return build;
};

describe("projects.checks", () => {
  it("answers how each feature of the spec will be checked", async () => {
    const { cookie, project } = await aProjectWithChecks();

    const answer = await callApi(app, "projects.checks", { id: project.id }, cookie);
    const features = answer.data as Outputs["projects"]["checks"];

    expect(features.map(({ name, checks }) => [name, checks.map(({ id }) => id)])).toEqual([
      ["Photo carousel", ["F1.1", "F1.2"]],
      ["Messages", ["F2.1"]],
    ]);
    expect(features[0].checks[0]).toEqual({ id: "F1.1", ...check("The second photo shows.") });
  });

  it("answers none for checks written from a spec that has since been written again", async () => {
    const { cookie, project } = await aProjectWithChecks();
    await db
      .update(projects)
      .set({ spec: "## Features\n- Orders" })
      .where(eq(projects.id, project.id));

    const answer = await callApi(app, "projects.checks", { id: project.id }, cookie);

    expect(answer.data).toEqual([]);
  });
});

describe("projects.acceptance", () => {
  it("answers which features work in the version being worked on", async () => {
    const { cookie, project } = await aProjectWithChecks();
    // An older version, then the one staging runs.
    await aTestedVersion(project.id, "a".repeat(40));
    const build = await aTestedVersion(project.id, "b".repeat(40));

    const answer = await callApi(app, "projects.acceptance", { id: project.id }, cookie);
    const staging = answer.data as Outputs["projects"]["acceptance"];

    expect(staging.buildId).toBe(build.id);
    expect(staging.features.map(({ name, state }) => [name, state])).toEqual([
      ["Photo carousel", "broken"],
      ["Messages", "works"],
    ]);
    expect(staging.features[0].checks[1]).toMatchObject({
      expect: "It wraps.",
      verdict: "broken",
      saw: "Tapped Next on the last photo; nothing happened.",
    });
  });

  it("answers nothing when the version being worked on was not followed by the tester", async () => {
    const { cookie, project } = await aProjectWithChecks();
    await aTestedVersion(project.id, "a".repeat(40));
    await db
      .update(projects)
      .set({ stagingCommit: "c".repeat(40) })
      .where(eq(projects.id, project.id));

    const answer = await callApi(app, "projects.acceptance", { id: project.id }, cookie);

    expect(answer.data).toEqual({ buildId: null, features: [] });
  });
});

describe("builds.acceptance", () => {
  it("answers which features work in a build's version", async () => {
    const { cookie, project } = await aProjectWithChecks();
    const build = await aTestedVersion(project.id, "a".repeat(40));

    const answer = await callApi(app, "builds.acceptance", { buildId: build.id }, cookie);
    const features = answer.data as Outputs["builds"]["acceptance"];

    expect(features.map(({ name, state }) => [name, state])).toEqual([
      ["Photo carousel", "broken"],
      ["Messages", "works"],
    ]);
  });

  it("refuses a build in another business", async () => {
    const { project } = await aProjectWithChecks();
    const build = await aTestedVersion(project.id, "a".repeat(40));
    const stranger = await aSignedInPerson(app, deps, { name: "Eve" });

    const answer = await callApi(app, "builds.acceptance", { buildId: build.id }, stranger.cookie);

    expect(answer.code).toBe("NOT_FOUND");
  });
});
