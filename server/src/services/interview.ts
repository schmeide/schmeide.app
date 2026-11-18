import { and, asc, count, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.ts";
import {
  ITEM_MAX,
  NEED_MAX,
  PLAN_SECTIONS,
  interviewQuestions,
  interviews,
  planItems,
  planPhase,
  planSection,
  projectIdSchema,
  projects,
  questionKind,
  readBacks,
  type Answer,
  type PlanItem,
  type PlanSection,
  type Project,
  type Question,
} from "../db/schema.ts";
import { recordUsage, type RunUsage } from "./builds.ts";
import { ConflictError, NotFoundError } from "./errors.ts";
import { findProject, statusWord, transition } from "./projects.ts";

// After this many questions the interview ends whatever the model says, so it cannot run on.
export const MAX_QUESTIONS = 30;
const MAX_CHANGES = 20;
const MAX_CHOICES = 6;

// What the model returns for one step of the interview: changes to the plan, which sections it now
// considers complete, and the next question (null when it has none left).
export const turnSchema = z.object({
  add: z
    .array(
      z.object({
        section: z.enum(planSection.enumValues),
        text: z.string().trim().min(1).max(ITEM_MAX),
        phase: z.enum(planPhase.enumValues),
      })
    )
    .max(MAX_CHANGES),
  update: z
    .array(z.object({ id: z.number().int(), text: z.string().trim().min(1).max(ITEM_MAX) }))
    .max(MAX_CHANGES),
  remove: z.array(z.number().int()).max(MAX_CHANGES),
  ready: z.array(z.enum(planSection.enumValues)).max(PLAN_SECTIONS.length),
  question: z
    .object({
      text: z.string().trim().min(1).max(ITEM_MAX),
      kind: z.enum(questionKind.enumValues),
      choices: z.array(z.string().trim().min(1).max(120)).max(MAX_CHOICES),
    })
    .nullable(),
});
export type Turn = z.infer<typeof turnSchema>;

export type AnsweredQuestion = {
  readonly question: Pick<Question, "text" | "kind" | "choices">;
  readonly answer: Answer;
};

// Asks the model for the next turn. Throws InterviewUnavailableError when it cannot.
export type Interviewer = (input: {
  readonly project: Pick<Project, "id" | "name" | "need" | "features">;
  readonly items: readonly PlanItem[];
  readonly trail: readonly AnsweredQuestion[];
}) => Promise<{ readonly turn: Turn; readonly usage: RunUsage | null }>;

export type InterviewDeps = { readonly db: Db; readonly interviewer: Interviewer };

export type SectionStatus = "not_started" | "sketched" | "ready";

export type Interview = {
  readonly items: readonly PlanItem[];
  // Answered questions, oldest first.
  readonly questions: readonly Question[];
  // The question waiting for an answer, if any.
  readonly current: Question | null;
  readonly sections: Readonly<Record<PlanSection, SectionStatus>>;
  readonly finished: boolean;
};

// The plan can change until the build starts; changing it after the spec was written discards the spec.
const EDITABLE = ["draft", "spec_ready"] as const;

export const editableProject = async (db: Db, id: number): Promise<Project> => {
  const project = await findProject(db, id);
  if (!EDITABLE.some((status) => status === project.status)) {
    throw new ConflictError(
      `The plan can only change before the app is built, and it is ${statusWord(project.status)} now.`
    );
  }
  return project;
};

// The read-back is written from the plan, so it goes with any change to it.
export const planChanged = async (db: Db, id: number): Promise<Project> => {
  await db.delete(readBacks).where(eq(readBacks.projectId, id));
  return transition(db, id, EDITABLE, { status: "draft", spec: null });
};

export const planItemsOf = (db: Db, projectId: number): Promise<readonly PlanItem[]> =>
  db.select().from(planItems).where(eq(planItems.projectId, projectId)).orderBy(asc(planItems.id));

export const getInterview = async (db: Db, id: number): Promise<Interview> => {
  await findProject(db, id);
  const items = await planItemsOf(db, id);
  const asked = await db
    .select()
    .from(interviewQuestions)
    .where(eq(interviewQuestions.projectId, id))
    .orderBy(asc(interviewQuestions.id));
  const [state] = await db.select().from(interviews).where(eq(interviews.projectId, id));
  const sectionStatus = (section: PlanSection): SectionStatus => {
    if (!items.some((item) => item.section === section)) return "not_started";
    return state?.ready.includes(section) ? "ready" : "sketched";
  };
  return {
    items,
    questions: asked.filter((question) => question.answer !== null),
    current: asked.find((question) => question.answer === null) ?? null,
    sections: {
      who: sectionStatus("who"),
      does: sectionStatus("does"),
      screens: sectionStatus("screens"),
      keeps: sectionStatus("keeps"),
      replaces: sectionStatus("replaces"),
    },
    finished: state?.finished ?? false,
  };
};

export const trailOf = (interview: Interview): readonly AnsweredQuestion[] =>
  interview.questions.flatMap((question) =>
    question.answer ? [{ question, answer: question.answer }] : []
  );

// Applies a turn's changes to the plan inside `tx`, and says whether anything changed.
export const applyPlanChanges = async (
  tx: Db,
  projectId: number,
  turn: Pick<Turn, "add" | "update" | "remove">,
  source: PlanItem["source"]
): Promise<boolean> => {
  const mine = eq(planItems.projectId, projectId);
  const removed = turn.remove.length
    ? await tx
        .delete(planItems)
        .where(and(mine, inArray(planItems.id, turn.remove)))
        .returning({ id: planItems.id })
    : [];
  const updated = (
    await Promise.all(
      turn.update.map((change) =>
        tx
          .update(planItems)
          .set({ text: change.text })
          .where(and(mine, eq(planItems.id, change.id)))
          .returning({ id: planItems.id })
      )
    )
  ).flat();
  if (turn.add.length) {
    await tx.insert(planItems).values(turn.add.map((item) => ({ ...item, projectId, source })));
  }
  return removed.length + updated.length + turn.add.length > 0;
};

// Applies one model turn inside `tx`. Items the model adds on its own are marked as Schmeide's;
// items that follow from something the person said are theirs.
const applyTurn = async (
  tx: Db,
  projectId: number,
  turn: Turn,
  source: PlanItem["source"]
): Promise<void> => {
  const changed = await applyPlanChanges(tx, projectId, turn, source);
  const [{ asked }] = await tx
    .select({ asked: count() })
    .from(interviewQuestions)
    .where(eq(interviewQuestions.projectId, projectId));
  const next = asked < MAX_QUESTIONS ? turn.question : null;
  if (next) await tx.insert(interviewQuestions).values({ ...next, projectId });
  const state = { ready: turn.ready, finished: next === null };
  await tx
    .insert(interviews)
    .values({ projectId, ...state })
    .onConflictDoUpdate({ target: interviews.projectId, set: state });
  if (changed) await planChanged(tx, projectId);
};

export const lockProject = (tx: Db, id: number) =>
  tx.select({ id: projects.id }).from(projects).where(eq(projects.id, id)).for("update");

// Asks the first question, or the next one after a turn that failed. Does nothing while a question
// is waiting or once the interview has finished.
export const startInterview = async (
  { db, interviewer }: InterviewDeps,
  id: number
): Promise<Interview> => {
  const project = await editableProject(db, id);
  const interview = await getInterview(db, id);
  if (interview.current || interview.finished) return interview;
  const { turn, usage } = await interviewer({
    project,
    items: interview.items,
    trail: trailOf(interview),
  });
  await recordUsage(db, usage);
  await db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    await lockProject(tx, id);
    // Another call may have asked a question while the model was working; keep that one.
    const [open] = await tx
      .select({ id: interviewQuestions.id })
      .from(interviewQuestions)
      .where(and(eq(interviewQuestions.projectId, id), isNull(interviewQuestions.answer)));
    if (!open) await applyTurn(tx, id, turn, "schmeide");
  });
  return getInterview(db, id);
};

export const restartInterviewSchema = projectIdSchema.extend({
  need: z.string().trim().min(1).max(NEED_MAX),
});

// Starts the questions over from new wording of the prompt: the old questions, and the plan drawn
// from their answers, are cleared and the first question is asked again. Only while describing;
// once a spec is written the plan is changed through it instead.
export const restartInterview = async (
  deps: InterviewDeps,
  input: { readonly id: number; readonly need: string }
): Promise<Interview> => {
  await deps.db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    const [project] = await tx
      .update(projects)
      .set({ need: input.need.trim() })
      .where(and(eq(projects.id, input.id), eq(projects.status, "draft")))
      .returning({ id: projects.id });
    if (!project) {
      const current = await findProject(tx, input.id);
      throw new ConflictError(
        `The questions can only start over while the app is ${statusWord("draft")}, and it is ${statusWord(current.status)} now. Start a new project to describe it from the beginning.`
      );
    }
    await tx.delete(interviewQuestions).where(eq(interviewQuestions.projectId, input.id));
    await tx.delete(interviews).where(eq(interviews.projectId, input.id));
    await tx.delete(readBacks).where(eq(readBacks.projectId, input.id));
    await tx.delete(planItems).where(eq(planItems.projectId, input.id));
  });
  return startInterview(deps, input.id);
};

const fits = (question: Question, answer: Answer): boolean => {
  switch (answer.type) {
    case "choices":
      return (
        (question.kind === "pick_one" || question.kind === "pick_many") &&
        (question.kind === "pick_many" || answer.values.length === 1) &&
        answer.values.every((value) => question.choices.includes(value))
      );
    case "yes_no":
      return question.kind === "yes_no";
    case "text":
    case "you_decide":
      return true;
  }
};

// The model is asked first and the answer stored with its turn in one step, so a failed model call
// leaves the question open and the same answer can be sent again.
export const answerQuestion = async (
  { db, interviewer }: InterviewDeps,
  input: { readonly id: number; readonly questionId: number; readonly answer: Answer }
): Promise<Interview> => {
  const project = await editableProject(db, input.id);
  const interview = await getInterview(db, input.id);
  const [question] = await db
    .select()
    .from(interviewQuestions)
    .where(
      and(eq(interviewQuestions.id, input.questionId), eq(interviewQuestions.projectId, input.id))
    );
  if (!question) throw new NotFoundError(`Question ${input.questionId} not found`);
  if (question.answer) throw new ConflictError("That question has already been answered");
  if (!fits(question, input.answer)) {
    throw new ConflictError("That answer does not fit the question");
  }
  const { turn, usage } = await interviewer({
    project,
    items: interview.items,
    trail: [...trailOf(interview), { question, answer: input.answer }],
  });
  await recordUsage(db, usage);
  await db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    await lockProject(tx, input.id);
    const [answered] = await tx
      .update(interviewQuestions)
      .set({ answer: input.answer, answeredAt: new Date() })
      .where(and(eq(interviewQuestions.id, question.id), isNull(interviewQuestions.answer)))
      .returning({ id: interviewQuestions.id });
    if (!answered) throw new ConflictError("That question has already been answered");
    await applyTurn(tx, input.id, turn, input.answer.type === "you_decide" ? "schmeide" : "you");
  });
  return getInterview(db, input.id);
};

// Direct edits to the plan. An item the person adds or changes is theirs from then on.

export const addPlanItem = (
  db: Db,
  input: {
    readonly id: number;
    readonly section: PlanSection;
    readonly text: string;
    readonly phase?: PlanItem["phase"];
  }
): Promise<PlanItem> =>
  db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    await planChanged(tx, input.id);
    const [item] = await tx
      .insert(planItems)
      .values({
        projectId: input.id,
        section: input.section,
        text: input.text.trim(),
        phase: input.phase,
        source: "you",
      })
      .returning();
    return item;
  });

export const updatePlanItem = (
  db: Db,
  input: {
    readonly id: number;
    readonly itemId: number;
    readonly section?: PlanSection;
    readonly text?: string;
    readonly phase?: PlanItem["phase"];
  }
): Promise<PlanItem> =>
  db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    const [item] = await tx
      .update(planItems)
      .set({
        section: input.section,
        text: input.text?.trim(),
        phase: input.phase,
        source: "you",
      })
      .where(and(eq(planItems.id, input.itemId), eq(planItems.projectId, input.id)))
      .returning();
    if (!item) throw new NotFoundError(`Plan item ${input.itemId} not found`);
    await planChanged(tx, input.id);
    return item;
  });

export const removePlanItem = (
  db: Db,
  input: { readonly id: number; readonly itemId: number }
): Promise<PlanItem> =>
  db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    const [item] = await tx
      .delete(planItems)
      .where(and(eq(planItems.id, input.itemId), eq(planItems.projectId, input.id)))
      .returning();
    if (!item) throw new NotFoundError(`Plan item ${input.itemId} not found`);
    await planChanged(tx, input.id);
    return item;
  });

const SECTION_TITLES: Readonly<Record<PlanSection, string>> = {
  who: "Who uses it",
  does: "What it does",
  screens: "Its screens",
  keeps: "What it keeps",
  replaces: "What it replaces, which they use today",
};

const bullets = (title: string, items: readonly Pick<PlanItem, "text">[]): readonly string[] =>
  items.length ? [`${title}:\n${items.map((item) => `- ${item.text}`).join("\n")}`] : [];

// The plan as text for the spec writer: day-one items by section, then what was put off, then
// what the owner left open and will be assumed.
export const planBrief = (
  items: readonly (Pick<PlanItem, "section" | "text" | "phase"> & { readonly open?: boolean })[]
): string =>
  [
    ...PLAN_SECTIONS.flatMap((section) =>
      bullets(
        SECTION_TITLES[section],
        items.filter((item) => item.section === section && item.phase === "day_one" && !item.open)
      )
    ),
    ...bullets(
      "Wanted later, not part of this version",
      items.filter((item) => item.phase === "later" && !item.open)
    ),
    ...bullets(
      "Assumed, because the owner left it open (state these in the spec as assumptions)",
      items.filter((item) => item.open)
    ),
  ].join("\n\n");
