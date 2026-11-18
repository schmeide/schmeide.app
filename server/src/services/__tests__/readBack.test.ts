import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createDb } from "../../db/client.ts";
import { interviewQuestions, planItems, readBacks } from "../../db/schema.ts";
import { InterviewUnavailableError, NotFoundError } from "../errors.ts";
import {
  addPlanItem,
  planBrief,
  updatePlanItem,
  type Interviewer,
  type Turn,
} from "../interview.ts";
import { createProject, deleteProjectRows, findProject, transition } from "../projects.ts";
import {
  correctReadBack,
  getReadBack,
  writeReadBack,
  type ReadBackWriter,
  type Written,
} from "../readBack.ts";
import { DEMO_TENANT_ID } from "../../__tests__/testAuth.ts";

const db = createDb(process.env.DATABASE_URL ?? "");
afterAll(() => db.$client.end());

const written = (partial: Partial<Written> = {}): Written => ({
  business: [{ text: "You run a cleaning company.", ask: "What kind of work do you do?" }],
  steps: [
    { text: "A client calls.", ask: "How does a job usually start?" },
    { text: "You send the invoice.", ask: "How do you get paid?" },
  ],
  open: [],
  ...partial,
});

const turn = (partial: Partial<Turn> = {}): Turn => ({
  add: [],
  update: [],
  remove: [],
  covered: [],
  question: null,
  ...partial,
});

const deps = (accounts: readonly Written[], turns: readonly Turn[] = []) => {
  const readBackWriter = vi.fn<ReadBackWriter>();
  accounts.forEach((output) => readBackWriter.mockResolvedValueOnce({ output, usage: null }));
  const interviewer = vi.fn<Interviewer>();
  turns.forEach((next) => interviewer.mockResolvedValueOnce({ turn: next, usage: null }));
  return { db, readBackWriter, interviewer };
};

const newProject = async () => {
  const project = await createProject(db, {
    name: `Cleaning ${randomUUID()}`,
    tenantId: DEMO_TENANT_ID,
  });
  await addPlanItem(db, { id: project.id, section: "does", text: "Send invoices" });
  await db.insert(planItems).values([
    { projectId: project.id, section: "keeps", text: "Prices per room", source: "schmeide" },
    { projectId: project.id, section: "does", text: "Online booking", phase: "later" },
  ]);
  return project;
};

describe("writeReadBack", () => {
  it("writes the account from the plan, keeps open points as plan items, and lists what Schmeide chose and what waits", async () => {
    const project = await newProject();
    const d = deps([written({ open: [{ section: "does", text: "Invoices are due in 30 days" }] })]);

    const readBack = await writeReadBack(d, project.id);

    expect(d.readBackWriter).toHaveBeenCalledWith({
      project: expect.objectContaining({ id: project.id }),
      items: expect.arrayContaining([expect.objectContaining({ text: "Send invoices" })]),
    });
    expect(readBack.account?.steps.map((step) => step.text)).toEqual([
      "A client calls.",
      "You send the invoice.",
    ]);
    expect(readBack.open.map((item) => item.text)).toEqual(["Invoices are due in 30 days"]);
    expect(readBack.open[0]).toMatchObject({ open: true, source: "schmeide" });
    expect(readBack.chosen.map((item) => item.text)).toEqual(["Prices per room"]);
    expect(readBack.later.map((item) => item.text)).toEqual(["Online booking"]);
  });

  it("returns the account already written without asking again", async () => {
    const project = await newProject();
    const d = deps([written()]);
    await writeReadBack(d, project.id);

    const again = await writeReadBack(d, project.id);

    expect(d.readBackWriter).toHaveBeenCalledTimes(1);
    expect(again.account?.business[0].text).toBe("You run a cleaning company.");
  });

  it("drops the account when the plan changes, so it is written again from the new plan", async () => {
    const project = await newProject();
    await writeReadBack(deps([written()]), project.id);
    const [chosen] = (await getReadBack(db, project.id)).chosen;

    await updatePlanItem(db, { id: project.id, itemId: chosen.id, text: "Prices per hour" });

    const readBack = await getReadBack(db, project.id);
    expect(readBack.account).toBeNull();
    expect(readBack.chosen).toEqual([]);
  });

  it("fails as unavailable when there is no writer, or the model fails", async () => {
    const project = await newProject();
    await expect(writeReadBack({ db, interviewer: vi.fn() }, project.id)).rejects.toThrow(
      InterviewUnavailableError
    );
    const d = deps([]);
    d.readBackWriter.mockRejectedValueOnce(new InterviewUnavailableError("down"));
    await expect(writeReadBack(d, project.id)).rejects.toThrow(InterviewUnavailableError);
    expect((await getReadBack(db, project.id)).account).toBeNull();
  });

  it("discards a written spec when it adds an open point", async () => {
    const project = await newProject();
    await transition(db, project.id, ["draft"], { status: "spec_ready", spec: "# Spec" });

    await writeReadBack(
      deps([written({ open: [{ section: "who", text: "Only you" }] })]),
      project.id
    );

    expect(await findProject(db, project.id)).toMatchObject({ status: "draft", spec: null });
  });
});

describe("correctReadBack", () => {
  it("asks about the marked sentence once, changes the plan from the answer, and writes the account again", async () => {
    const project = await newProject();
    const d = deps(
      [
        written(),
        written({ steps: [{ text: "A client books online.", ask: "How do jobs start?" }] }),
      ],
      [
        turn({
          add: [{ section: "does", text: "Take bookings by email", phase: "day_one" }],
          question: { text: "Anything else?", why: "In case.", kind: "text", choices: [] },
        }),
      ]
    );
    await writeReadBack(d, project.id);

    const readBack = await correctReadBack(d, {
      id: project.id,
      target: { part: "steps", index: 0 },
      answer: "Clients email me",
    });

    const [call] = d.interviewer.mock.calls[0];
    expect(call.trail.at(-1)).toEqual({
      question: expect.objectContaining({
        text: expect.stringContaining("How does a job usually start?"),
      }),
      answer: { type: "text", value: "Clients email me" },
    });
    expect(call.trail.at(-1)?.question.text).toContain("A client calls.");
    expect(readBack.account?.steps[0].text).toBe("A client books online.");
    const items = await db.select().from(planItems).where(eq(planItems.projectId, project.id));
    expect(items).toContainEqual(
      expect.objectContaining({ text: "Take bookings by email", source: "you" })
    );
    // The correction is on record, and nothing is left waiting: it is not a second interview.
    const asked = await db
      .select()
      .from(interviewQuestions)
      .where(eq(interviewQuestions.projectId, project.id));
    expect(asked).toEqual([
      expect.objectContaining({
        text: "How does a job usually start?",
        answer: { type: "text", value: "Clients email me" },
      }),
    ]);
  });

  it("settles an open point from its answer", async () => {
    const project = await newProject();
    const d = deps(
      [written({ open: [{ section: "does", text: "Invoices are due in 30 days" }] }), written()],
      [turn()]
    );
    const { open } = await writeReadBack(d, project.id);

    const readBack = await correctReadBack(d, {
      id: project.id,
      target: { itemId: open[0].id },
      answer: "14 days",
    });

    expect(d.interviewer.mock.calls[0][0].trail.at(-1)?.question.text).toContain(
      "Invoices are due in 30 days"
    );
    expect(readBack.open).toEqual([]);
  });

  it("refuses a sentence or point that is not there", async () => {
    const project = await newProject();
    const d = deps([written()]);
    await writeReadBack(d, project.id);

    await expect(
      correctReadBack(d, { id: project.id, target: { part: "steps", index: 9 }, answer: "No" })
    ).rejects.toThrow(NotFoundError);
    const [chosen] = (await getReadBack(db, project.id)).chosen;
    await expect(
      correctReadBack(d, { id: project.id, target: { itemId: chosen.id }, answer: "No" })
    ).rejects.toThrow(NotFoundError);
    expect(d.interviewer).not.toHaveBeenCalled();
  });
});

describe("a project with a read-back", () => {
  it("is deleted together with it", async () => {
    const project = await newProject();
    await writeReadBack(deps([written()]), project.id);

    await deleteProjectRows(db, project.id);

    expect(await db.select().from(readBacks).where(eq(readBacks.projectId, project.id))).toEqual(
      []
    );
  });
});

describe("planBrief", () => {
  it("states the points left open as assumptions, apart from what was settled", () => {
    expect(
      planBrief([
        { section: "does", text: "Send invoices", phase: "day_one", open: false },
        { section: "does", text: "Invoices are due in 30 days", phase: "day_one", open: true },
      ])
    ).toBe(
      [
        "What it does:\n- Send invoices",
        "Assumed, because the owner left it open (state these in the spec as assumptions):\n- Invoices are due in 30 days",
      ].join("\n\n")
    );
  });
});
