import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createDb } from "../../db/client.ts";
import { builds, projectDesigns } from "../../db/schema.ts";
import { DEMO_TENANT_ID } from "../../__tests__/testAuth.ts";
import { designBrief } from "../designBrief.ts";
import { STYLES } from "../designStyles.ts";
import { getDesign, pickLook, pickLookSchema, restyleRequest } from "../designs.ts";
import { ConflictError } from "../errors.ts";
import { createProject, transition, type Deps } from "../projects.ts";

const db = createDb(process.env.DATABASE_URL ?? "");
afterAll(() => db.$client.end());

const setup = (designTeam = true) => {
  const workflows = {
    start: vi.fn(async () => ({}) as never),
    getHandle: vi.fn() as never,
  } satisfies Deps["workflows"];
  return { deps: { db, workflows, taskQueue: "test", designTeam }, workflows };
};

const aProject = async (status: "spec_ready" | "live" | "building") => {
  const project = await createProject(db, {
    name: `look ${randomUUID()}`,
    tenantId: DEMO_TENANT_ID,
  });
  return transition(db, project.id, ["draft"], { status, spec: "## Features\n- orders" });
};

const LEAD = {
  style: "ledger",
  reason: "Staff work through many orders a day.",
  screens: [{ name: "Orders", layout: "A table of open orders." }],
};

const withBrief = async (projectId: number) =>
  db.insert(projectDesigns).values({
    projectId,
    style: "ledger",
    chosenBy: "lead",
    brief: designBrief(LEAD, []),
  });

const buildsOf = (projectId: number) =>
  db.select().from(builds).where(eq(builds.projectId, projectId));

describe("getDesign", () => {
  it("says in plain words which look the app has and why, and lists the others", async () => {
    const { deps } = setup();
    const project = await aProject("live");
    await withBrief(project.id);

    const design = await getDesign(deps, project.id);

    expect(design).toEqual({
      enabled: true,
      current: {
        style: "ledger",
        name: "Ledger",
        summary: STYLES.find(({ id }) => id === "ledger")?.summary,
        chosenBy: "lead",
        reason: LEAD.reason,
      },
      styles: STYLES.map(({ id, name, summary }) => ({ id, name, summary })),
    });
  });

  it("has no look to show for an app without a brief, or with the design team off", async () => {
    const project = await aProject("live");

    expect((await getDesign(setup().deps, project.id)).current).toBeNull();
    expect((await getDesign(setup(false).deps, project.id)).enabled).toBe(false);
  });
});

describe("pickLook", () => {
  it("stores the pick for the first build, and starts nothing before it", async () => {
    const { deps, workflows } = setup();
    const project = await aProject("spec_ready");

    await pickLook(deps, { id: project.id, style: "friendly" });

    const [row] = await db
      .select()
      .from(projectDesigns)
      .where(eq(projectDesigns.projectId, project.id));
    expect(row).toMatchObject({ style: "friendly", chosenBy: "person" });
    expect(workflows.start).not.toHaveBeenCalled();
    expect(await buildsOf(project.id)).toEqual([]);
  });

  it("restyles a built app as a change, keeping the screens the lead laid out", async () => {
    const { deps, workflows } = setup();
    const project = await aProject("live");
    await withBrief(project.id);

    await pickLook(deps, { id: project.id, style: "bold" });

    const [row] = await db
      .select()
      .from(projectDesigns)
      .where(eq(projectDesigns.projectId, project.id));
    expect(row).toMatchObject({ style: "bold", chosenBy: "person" });
    expect(row.brief.screens).toEqual(LEAD.screens);
    expect(await buildsOf(project.id)).toEqual([
      expect.objectContaining({
        kind: "change",
        request: restyleRequest("bold"),
        status: "running",
      }),
    ]);
    expect(workflows.start).toHaveBeenCalledTimes(1);
  });

  it("gives an app built without a brief its first one, as a change", async () => {
    const { deps } = setup();
    const project = await aProject("live");

    await pickLook(deps, { id: project.id, style: "calm" });

    expect(await buildsOf(project.id)).toEqual([
      expect.objectContaining({ request: restyleRequest("calm") }),
    ]);
  });

  it("queues the restyle behind a build that is running", async () => {
    const { deps } = setup();
    const project = await aProject("building");
    await withBrief(project.id);

    await pickLook(deps, { id: project.id, style: "editorial" });

    expect(await buildsOf(project.id)).toEqual([
      expect.objectContaining({ request: restyleRequest("editorial"), status: "queued" }),
    ]);
  });

  it("does nothing when the look picked is the one the app has", async () => {
    const { deps, workflows } = setup();
    const project = await aProject("live");
    await withBrief(project.id);

    await pickLook(deps, { id: project.id, style: "ledger" });

    expect(workflows.start).not.toHaveBeenCalled();
    expect(await buildsOf(project.id)).toEqual([]);
  });

  it("refuses with the design team off", async () => {
    const { deps } = setup(false);
    const project = await aProject("live");

    await expect(pickLook(deps, { id: project.id, style: "calm" })).rejects.toThrow(ConflictError);
  });

  it("takes only a style in the library", () => {
    expect(pickLookSchema.safeParse({ id: 1, style: "calm" }).success).toBe(true);
    expect(pickLookSchema.safeParse({ id: 1, style: "neon" }).success).toBe(false);
  });
});
