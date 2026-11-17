import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createDb } from "../../db/client.ts";
import { interviewQuestions, planItems, usage } from "../../db/schema.ts";
import { ConflictError, InterviewUnavailableError, NotFoundError } from "../errors.ts";
import {
  MAX_QUESTIONS,
  addPlanItem,
  answerQuestion,
  getInterview,
  planBrief,
  removePlanItem,
  startInterview,
  updatePlanItem,
  type Interviewer,
  type Turn,
} from "../interview.ts";
import {
  createProject,
  deleteProjectRows,
  findProject,
  generateSpec,
  transition,
} from "../projects.ts";
import { DEMO_TENANT_ID } from "../../__tests__/testAuth.ts";

// Tests share one database, so they assert only on rows they created.
const db = createDb(process.env.DATABASE_URL ?? "");
afterAll(() => db.$client.end());

const turn = (partial: Partial<Turn> = {}): Turn => ({
  add: [],
  update: [],
  remove: [],
  ready: [],
  question: null,
  ...partial,
});

type Asked = NonNullable<Turn["question"]>;
const WHO: Asked = {
  text: "Who sends the invoices?",
  kind: "pick_one",
  choices: ["Just me", "Me and my staff"],
};
const WHEN: Asked = { text: "Do invoices have a due date?", kind: "yes_no", choices: [] };

// Stands in for the model: hands back the given turns in order, one per call.
const scripted = (...turns: readonly Turn[]) => {
  const interviewer = vi.fn<Interviewer>();
  turns.forEach((next) => interviewer.mockResolvedValueOnce({ turn: next, usage: [] }));
  return { deps: { db, interviewer }, interviewer };
};

const newProject = () =>
  createProject(db, { name: `Invoices ${randomUUID()}`, tenantId: DEMO_TENANT_ID });

describe("startInterview", () => {
  it("asks the first question and stores what the model already put in the plan", async () => {
    const project = await newProject();
    const { deps, interviewer } = scripted(
      turn({
        add: [{ section: "does", text: "Create an invoice", phase: "day_one" }],
        question: WHO,
      })
    );

    const interview = await startInterview(deps, project.id);

    expect(interviewer).toHaveBeenCalledWith({
      project: expect.objectContaining({ id: project.id, name: project.name }),
      items: [],
      trail: [],
    });
    expect(interview.current).toMatchObject({ ...WHO, answer: null });
    expect(interview.questions).toEqual([]);
    expect(interview.items).toEqual([
      expect.objectContaining({
        section: "does",
        text: "Create an invoice",
        phase: "day_one",
        source: "schmeide",
      }),
    ]);
    expect(interview.sections).toEqual({
      who: "not_started",
      does: "sketched",
      screens: "not_started",
      keeps: "not_started",
      replaces: "not_started",
    });
    expect(interview.finished).toBe(false);
    expect(await getInterview(db, project.id)).toEqual(interview);
  });

  it("does not ask the model again while a question is waiting or once it has finished", async () => {
    const waiting = await newProject();
    const first = scripted(turn({ question: WHO }));
    await startInterview(first.deps, waiting.id);
    await startInterview(first.deps, waiting.id);
    expect(first.interviewer).toHaveBeenCalledTimes(1);

    const done = await newProject();
    const second = scripted(turn());
    expect((await startInterview(second.deps, done.id)).finished).toBe(true);
    await startInterview(second.deps, done.id);
    expect(second.interviewer).toHaveBeenCalledTimes(1);
  });

  it("records what the model call cost against the project", async () => {
    const project = await newProject();
    const interviewer = vi.fn<Interviewer>(async ({ project: asked }) => ({
      turn: turn({ question: WHO }),
      usage: [
        {
          projectId: asked.id,
          buildId: null,
          runKind: "interview",
          model: "claude-test",
          inputTokens: 1,
          outputTokens: 2,
          cacheReadTokens: 3,
          cacheCreationTokens: 4,
          costUsd: 0.01,
        },
      ],
    }));

    await startInterview({ db, interviewer }, project.id);

    expect(await db.select().from(usage).where(eq(usage.projectId, project.id))).toEqual([
      expect.objectContaining({ model: "claude-test", buildId: null, costUsd: 0.01 }),
    ]);
  });

  it("reports the interview as unavailable when the model fails, and can be tried again", async () => {
    const project = await newProject();
    const interviewer = vi
      .fn<Interviewer>()
      .mockRejectedValueOnce(new InterviewUnavailableError("no answer"))
      .mockResolvedValueOnce({ turn: turn({ question: WHO }), usage: [] });

    await expect(startInterview({ db, interviewer }, project.id)).rejects.toBeInstanceOf(
      InterviewUnavailableError
    );

    expect((await startInterview({ db, interviewer }, project.id)).current).toMatchObject(WHO);
  });

  it("refuses a project that is being built", async () => {
    const project = await newProject();
    await transition(db, project.id, ["draft"], { status: "building" });
    const { deps, interviewer } = scripted(turn({ question: WHO }));

    await expect(startInterview(deps, project.id)).rejects.toBeInstanceOf(ConflictError);
    expect(interviewer).not.toHaveBeenCalled();
  });

  it("answers not found for a project that does not exist", async () => {
    const { deps } = scripted();

    await expect(startInterview(deps, 2_000_000_000)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("answerQuestion", () => {
  it("stores the answer, changes the plan, and asks the next question", async () => {
    const project = await newProject();
    const { deps, interviewer } = scripted(
      turn({
        add: [
          { section: "does", text: "Create an invoice", phase: "day_one" },
          { section: "does", text: "Print an invoice", phase: "day_one" },
        ],
        question: WHO,
      })
    );
    const started = await startInterview(deps, project.id);
    const [create, print] = started.items;
    interviewer.mockResolvedValueOnce({
      turn: turn({
        add: [{ section: "who", text: "Only the owner", phase: "day_one" }],
        update: [{ id: create.id, text: "Create and send an invoice" }],
        remove: [print.id],
        ready: ["who"],
        question: WHEN,
      }),
      usage: [],
    });

    const interview = await answerQuestion(deps, {
      id: project.id,
      questionId: started.current?.id ?? 0,
      answer: { type: "choices", values: ["Just me"] },
    });

    expect(interviewer).toHaveBeenLastCalledWith({
      project: expect.objectContaining({ id: project.id }),
      items: started.items,
      trail: [
        {
          question: expect.objectContaining(WHO),
          answer: { type: "choices", values: ["Just me"] },
        },
      ],
    });
    expect(interview.questions).toEqual([
      expect.objectContaining({ ...WHO, answer: { type: "choices", values: ["Just me"] } }),
    ]);
    expect(interview.current).toMatchObject(WHEN);
    expect(interview.items.map((item) => [item.section, item.text, item.source])).toEqual([
      ["does", "Create and send an invoice", "schmeide"],
      ["who", "Only the owner", "you"],
    ]);
    expect(interview.sections).toMatchObject({ who: "ready", does: "sketched" });
  });

  it("marks what Schmeide chose when the answer is “you decide”", async () => {
    const project = await newProject();
    const { deps, interviewer } = scripted(turn({ question: WHEN }));
    const started = await startInterview(deps, project.id);
    interviewer.mockResolvedValueOnce({
      turn: turn({ add: [{ section: "keeps", text: "A due date", phase: "day_one" }] }),
      usage: [],
    });

    const interview = await answerQuestion(deps, {
      id: project.id,
      questionId: started.current?.id ?? 0,
      answer: { type: "you_decide" },
    });

    expect(interview.items).toEqual([expect.objectContaining({ source: "schmeide" })]);
    expect(interview.current).toBeNull();
    expect(interview.finished).toBe(true);
  });

  it("refuses an answer that does not fit the question, without asking the model", async () => {
    const project = await newProject();
    const { deps, interviewer } = scripted(turn({ question: WHO }));
    const started = await startInterview(deps, project.id);
    const answer = (value: Parameters<typeof answerQuestion>[1]["answer"]) =>
      answerQuestion(deps, { id: project.id, questionId: started.current?.id ?? 0, answer: value });

    await expect(answer({ type: "choices", values: ["Nobody"] })).rejects.toBeInstanceOf(
      ConflictError
    );
    await expect(
      answer({ type: "choices", values: ["Just me", "Me and my staff"] })
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(answer({ type: "yes_no", value: true })).rejects.toBeInstanceOf(ConflictError);
    expect(interviewer).toHaveBeenCalledTimes(1);
  });

  it("accepts the person's own words on any question", async () => {
    const project = await newProject();
    const { deps, interviewer } = scripted(turn({ question: WHO }));
    const started = await startInterview(deps, project.id);
    interviewer.mockResolvedValueOnce({ turn: turn(), usage: [] });

    const interview = await answerQuestion(deps, {
      id: project.id,
      questionId: started.current?.id ?? 0,
      answer: { type: "text", value: "My bookkeeper" },
    });

    expect(interview.questions[0].answer).toEqual({ type: "text", value: "My bookkeeper" });
  });

  it("answers a question once", async () => {
    const project = await newProject();
    const { deps, interviewer } = scripted(turn({ question: WHO }), turn({ question: WHEN }));
    const started = await startInterview(deps, project.id);
    const input = {
      id: project.id,
      questionId: started.current?.id ?? 0,
      answer: { type: "text", value: "Me" },
    } as const;
    await answerQuestion(deps, input);

    await expect(answerQuestion(deps, input)).rejects.toBeInstanceOf(ConflictError);
    expect(interviewer).toHaveBeenCalledTimes(2);
  });

  it("answers not found for a question of another project", async () => {
    const mine = await newProject();
    const theirs = await newProject();
    const { deps } = scripted(turn({ question: WHO }));
    const started = await startInterview(deps, theirs.id);

    await expect(
      answerQuestion(deps, {
        id: mine.id,
        questionId: started.current?.id ?? 0,
        answer: { type: "text", value: "Me" },
      })
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("leaves the question open when the model fails, so the answer can be sent again", async () => {
    const project = await newProject();
    const { deps, interviewer } = scripted(turn({ question: WHO }));
    const started = await startInterview(deps, project.id);
    interviewer.mockRejectedValueOnce(new InterviewUnavailableError("no answer"));
    const input = {
      id: project.id,
      questionId: started.current?.id ?? 0,
      answer: { type: "text", value: "Me" },
    } as const;

    await expect(answerQuestion(deps, input)).rejects.toBeInstanceOf(InterviewUnavailableError);

    expect((await getInterview(db, project.id)).current).toMatchObject({ answer: null });
    interviewer.mockResolvedValueOnce({ turn: turn(), usage: [] });
    expect((await answerQuestion(deps, input)).questions).toHaveLength(1);
  });

  it("ignores changes the model makes to another project's plan", async () => {
    const mine = await newProject();
    const theirs = await newProject();
    const other = await addPlanItem(db, { id: theirs.id, section: "does", text: "Theirs" });
    const { deps } = scripted(
      turn({ update: [{ id: other.id, text: "Changed" }], remove: [other.id] })
    );

    await startInterview(deps, mine.id);

    expect((await getInterview(db, theirs.id)).items).toEqual([
      expect.objectContaining({ text: "Theirs" }),
    ]);
  });

  it("stops asking after the question limit", async () => {
    const project = await newProject();
    await db.insert(interviewQuestions).values(
      Array.from({ length: MAX_QUESTIONS - 1 }, (_, i) => ({
        projectId: project.id,
        text: `Question ${i + 1}`,
        kind: "text" as const,
        answer: { type: "text" as const, value: "yes" },
        answeredAt: new Date(),
      }))
    );
    const { deps, interviewer } = scripted(turn({ question: WHO }), turn({ question: WHEN }));
    const started = await startInterview(deps, project.id);

    const interview = await answerQuestion(deps, {
      id: project.id,
      questionId: started.current?.id ?? 0,
      answer: { type: "text", value: "Me" },
    });

    expect(interview.questions).toHaveLength(MAX_QUESTIONS);
    expect(interview.current).toBeNull();
    expect(interview.finished).toBe(true);
    expect(interviewer).toHaveBeenCalledTimes(2);
  });

  it("throws the spec away when an answer changes the plan it was written from", async () => {
    const project = await newProject();
    const { deps, interviewer } = scripted(turn({ question: WHO }), turn({ question: WHEN }));
    const started = await startInterview(deps, project.id);
    await transition(db, project.id, ["draft"], { status: "spec_ready", spec: "## Features" });

    await answerQuestion(deps, {
      id: project.id,
      questionId: started.current?.id ?? 0,
      answer: { type: "text", value: "Me" },
    });
    expect(await findProject(db, project.id)).toMatchObject({ status: "spec_ready" });

    interviewer.mockResolvedValueOnce({
      turn: turn({ add: [{ section: "keeps", text: "A due date", phase: "day_one" }] }),
      usage: [],
    });
    const next = await getInterview(db, project.id);
    await answerQuestion(deps, {
      id: project.id,
      questionId: next.current?.id ?? 0,
      answer: { type: "yes_no", value: true },
    });

    expect(await findProject(db, project.id)).toMatchObject({ status: "draft", spec: null });
  });
});

describe("editing the plan directly", () => {
  it("adds, changes, and removes an item as the person's own", async () => {
    const project = await newProject();
    const { deps } = scripted(
      turn({ add: [{ section: "does", text: "Create an invoice", phase: "day_one" }] })
    );
    const [suggested] = (await startInterview(deps, project.id)).items;

    const added = await addPlanItem(db, { id: project.id, section: "screens", text: "  Clients " });
    const changed = await updatePlanItem(db, {
      id: project.id,
      itemId: suggested.id,
      text: "Create an invoice with line items",
      phase: "later",
    });
    await removePlanItem(db, { id: project.id, itemId: added.id });

    expect(added).toMatchObject({ section: "screens", text: "Clients", source: "you" });
    expect(changed).toMatchObject({ source: "you", phase: "later" });
    expect((await getInterview(db, project.id)).items).toEqual([
      expect.objectContaining({ text: "Create an invoice with line items", phase: "later" }),
    ]);
  });

  it("throws the spec away, and refuses once the project is being built", async () => {
    const project = await newProject();
    const item = await addPlanItem(db, { id: project.id, section: "does", text: "One" });
    await transition(db, project.id, ["draft"], { status: "spec_ready", spec: "## Features" });

    await updatePlanItem(db, { id: project.id, itemId: item.id, text: "Two" });

    expect(await findProject(db, project.id)).toMatchObject({ status: "draft", spec: null });
    await transition(db, project.id, ["draft"], { status: "building" });
    await expect(
      addPlanItem(db, { id: project.id, section: "does", text: "Three" })
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(removePlanItem(db, { id: project.id, itemId: item.id })).rejects.toBeInstanceOf(
      ConflictError
    );
    expect((await getInterview(db, project.id)).items).toHaveLength(1);
  });

  it("answers not found for an item of another project", async () => {
    const mine = await newProject();
    const theirs = await newProject();
    const item = await addPlanItem(db, { id: theirs.id, section: "does", text: "Theirs" });

    await expect(
      updatePlanItem(db, { id: mine.id, itemId: item.id, text: "Mine now" })
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(removePlanItem(db, { id: mine.id, itemId: item.id })).rejects.toBeInstanceOf(
      NotFoundError
    );
  });
});

describe("planBrief", () => {
  it("lists day-one items by section and keeps later items apart", () => {
    const item = (section: "who" | "does" | "keeps", text: string, phase = "day_one") =>
      ({ section, text, phase }) as Parameters<typeof planBrief>[0][number];

    expect(
      planBrief([
        item("does", "Create an invoice"),
        item("who", "Only the owner"),
        item("does", "Send reminders", "later"),
        item("keeps", "Clients"),
      ])
    ).toBe(
      [
        "Who uses it:\n- Only the owner",
        "What it does:\n- Create an invoice",
        "What it keeps:\n- Clients",
        "Wanted later, not part of this version:\n- Send reminders",
      ].join("\n\n")
    );
  });
});

describe("a project with a plan", () => {
  it("can have its spec written without any typed requests", async () => {
    const project = await newProject();
    await addPlanItem(db, { id: project.id, section: "does", text: "Create an invoice" });
    const workflows = { start: vi.fn(async () => ({}) as never), getHandle: vi.fn() as never };

    const generating = await generateSpec({ db, workflows, taskQueue: "test" }, project.id);

    expect(generating.status).toBe("spec_generating");
  });

  it("is deleted together with its plan and questions", async () => {
    const project = await newProject();
    const { deps } = scripted(
      turn({
        add: [{ section: "does", text: "Create an invoice", phase: "day_one" }],
        question: WHO,
      })
    );
    await startInterview(deps, project.id);

    await deleteProjectRows(db, project.id);

    expect(await db.select().from(planItems).where(eq(planItems.projectId, project.id))).toEqual(
      []
    );
    await expect(findProject(db, project.id)).rejects.toBeInstanceOf(NotFoundError);
  });
});
