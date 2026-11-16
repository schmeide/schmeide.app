import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createDb } from "../../db/client.ts";
import { finishBuild } from "../builds.ts";
import { ConflictError } from "../errors.ts";
import {
  approveSpec,
  createProject,
  generateSpec,
  requestChange,
  setFeatures,
  slugify,
  stopProject,
  testDbPort,
  transition,
  type Deps,
} from "../projects.ts";

// Tests share one database, so they assert only on rows they created.
const db = createDb(process.env.DATABASE_URL ?? "");
afterAll(() => db.$client.end());

const fakeWorkflows = () => {
  const cancel = vi.fn(async () => undefined);
  const workflows = {
    start: vi.fn(async () => ({}) as never),
    getHandle: vi.fn(() => ({ cancel }) as never),
  } satisfies Deps["workflows"];
  return { deps: { db, workflows } satisfies Deps, workflows, cancel };
};

const startArgs = (workflows: ReturnType<typeof fakeWorkflows>["workflows"]) =>
  workflows.start.mock.calls.map((call: readonly unknown[]) => call[0]);

const specReady = async () => {
  const project = await createProject(db, { name: `p ${randomUUID()}` });
  await setFeatures(db, { id: project.id, features: "a list of to-dos" });
  return transition(db, project.id, ["draft"], { status: "spec_ready", spec: "## Features" });
};

describe("slugify", () => {
  it.each([
    ["Invoice Tracker", "invoice-tracker"],
    ["  Hello, World!  ", "hello-world"],
    ["Ünïcode Café", "unicode-cafe"],
    ["!!!", "project"],
    ["x".repeat(60), "x".repeat(40)],
  ])("turns %j into %j", (name, slug) => {
    expect(slugify(name)).toBe(slug);
  });
});

describe("createProject", () => {
  it("gives repeated names distinct slugs and each project its own ports", async () => {
    const name = `Same ${randomUUID()}`;

    const first = await createProject(db, { name });
    const second = await createProject(db, { name });

    expect(first.slug).toBe(slugify(name));
    expect(second.slug).toBe(`${slugify(name)}-2`);
    expect(first.status).toBe("draft");
    expect(second.webPort).toBeGreaterThan(first.webPort);
    expect(first.webPort).toBeGreaterThanOrEqual(8100);
    expect(testDbPort(first)).toBe(5600 + first.webPort - 8100);
  });

  it("survives concurrent creates racing for the same slug and port", async () => {
    const name = `Race ${randomUUID()}`;

    const created = await Promise.all(Array.from({ length: 4 }, () => createProject(db, { name })));

    expect(new Set(created.map((project) => project.slug)).size).toBe(4);
    expect(new Set(created.map((project) => project.webPort)).size).toBe(4);
  });
});

describe("project state machine", () => {
  it("generates a spec only from features", async () => {
    const { deps, workflows } = fakeWorkflows();
    const project = await createProject(db, { name: `p ${randomUUID()}` });

    await expect(generateSpec(deps, project.id)).rejects.toBeInstanceOf(ConflictError);
    await setFeatures(db, { id: project.id, features: "a list of to-dos" });
    const generating = await generateSpec(deps, project.id);

    expect(generating.status).toBe("spec_generating");
    expect(startArgs(workflows)).toEqual(["specWorkflow"]);
    await expect(
      setFeatures(db, { id: project.id, features: "changed my mind" })
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("editing features after the spec drops the spec", async () => {
    const project = await specReady();

    const edited = await setFeatures(db, { id: project.id, features: "something else" });

    expect(edited).toMatchObject({ status: "draft", spec: null, features: "something else" });
  });

  it("approves only a ready spec, starts a build, and allows one build at a time", async () => {
    const { deps, workflows } = fakeWorkflows();
    const draft = await createProject(db, { name: `p ${randomUUID()}` });
    await expect(approveSpec(deps, draft.id)).rejects.toBeInstanceOf(ConflictError);

    const ready = await specReady();
    const other = await specReady();
    const { project, build } = await approveSpec(deps, ready.id);
    try {
      expect(project.status).toBe("building");
      expect(build).toMatchObject({ kind: "initial", status: "running", request: "## Features" });
      expect(workflows.start).toHaveBeenCalledWith(
        "buildWorkflow",
        expect.objectContaining({ workflowId: `build-${build.id}`, args: [ready.id, build.id] })
      );
      await expect(approveSpec(deps, other.id)).rejects.toThrow(/still running/);
    } finally {
      await finishBuild(db, build.id);
    }
  });

  it("takes change requests on live, failed, and stopped projects only", async () => {
    const { deps } = fakeWorkflows();
    const ready = await specReady();
    await expect(
      requestChange(deps, { id: ready.id, request: "add due dates" })
    ).rejects.toBeInstanceOf(ConflictError);

    await transition(db, ready.id, ["spec_ready"], { status: "live" });
    const { build } = await requestChange(deps, { id: ready.id, request: "add due dates" });
    await finishBuild(db, build.id);

    expect(build).toMatchObject({ kind: "change", request: "add due dates" });
  });

  it("stop cancels a running build, or takes a deployment down", async () => {
    const { deps, workflows, cancel } = fakeWorkflows();
    const ready = await specReady();
    const { build } = await approveSpec(deps, ready.id);
    try {
      await stopProject(deps, ready.id);
      expect(workflows.getHandle).toHaveBeenCalledWith(`build-${build.id}`);
      expect(cancel).toHaveBeenCalled();
    } finally {
      await finishBuild(db, build.id);
    }

    await transition(db, ready.id, ["building"], { status: "live" });
    await stopProject(deps, ready.id);
    expect(startArgs(workflows)).toContain("stopWorkflow");

    const draft = await createProject(db, { name: `p ${randomUUID()}` });
    await expect(stopProject(deps, draft.id)).rejects.toBeInstanceOf(ConflictError);
  });
});
