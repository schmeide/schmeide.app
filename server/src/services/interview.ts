import { and, asc, count, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.ts";
import {
  INTERVIEW_DEPTHS,
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
  type InterviewDepth,
  type PlanItem,
  type PlanSection,
  type Project,
  type Question,
} from "../db/schema.ts";
import { recordUsage, type RunUsage } from "./builds.ts";
import { ConflictError, NotFoundError } from "./errors.ts";
import { findProject, statusWord, transition } from "./projects.ts";

// After this many questions the interview ends whatever the model says, so it cannot run on. The
// person picks the depth: a quick sketch of about five minutes, or the thorough interview of about
// twenty.
export const QUESTION_LIMITS: Readonly<Record<InterviewDepth, number>> = {
  quick: 10,
  thorough: 30,
};
export const MAX_QUESTIONS = QUESTION_LIMITS.thorough;

// The interview's stages, in order, each with the points that must be settled before it is done.
// A plan section is ready when every point of every stage that fills it is settled, so readiness
// comes from this checklist, not from the model's feeling. The model reports which points an answer
// settled; the stage it is in is the first with a point still open.
export const STAGES = [
  {
    stage: "business",
    sections: ["business"],
    points: {
      offer: "what they sell, and to whom",
      flow: "how one piece of work goes from first contact to being paid",
      volume: "how much work there is in a week, and how many people take part",
      pain: "what goes wrong or takes too long today",
      aim: "what would save them the most time each week, and what they want to see at a glance on a Monday morning",
    },
  },
  {
    stage: "jobs",
    sections: ["does", "screens"],
    points: {
      steps:
        "each step of the work, in the order it happens, has a decision: in the app, later, or stays as it is",
    },
  },
  {
    stage: "rules",
    sections: ["rules"],
    points: {
      money:
        "how money works for this business, as far as the app touches it: prices, tax, invoice numbers, deposits and part-payments, late payers",
      changes: "what happens when a piece of work changes or is canceled after it was agreed",
      mistakes: "what must never happen, and what costs them money when it goes wrong",
      exceptions:
        "the awkward cases that break a simple version for this kind of business, each one asked",
    },
  },
  {
    stage: "people",
    sections: ["who"],
    points: {
      roles: "everyone who would use it",
      access: "what each of them may see and do",
    },
  },
  {
    stage: "information",
    sections: ["keeps"],
    points: {
      records: "what is kept about each thing",
      existing: "what they already have written down, and where it is",
    },
  },
  {
    stage: "day_one",
    sections: ["does"],
    points: {
      first:
        "what goes in the first version and what waits, chosen knowing roughly what each choice costs",
    },
  },
] as const satisfies readonly {
  readonly stage: string;
  readonly sections: readonly PlanSection[];
  readonly points: Readonly<Record<string, string>>;
}[];
export type Stage = (typeof STAGES)[number]["stage"];

// Every checklist point as "<stage>.<point>", which is how the model names them.
export const CHECKLIST: readonly {
  readonly id: string;
  readonly stage: Stage;
  readonly text: string;
}[] = STAGES.flatMap(({ stage, points }) =>
  Object.entries(points).map(([point, text]) => ({ id: `${stage}.${point}`, stage, text }))
);

// The stage the interview is in: the first with a point not yet settled, or null once all are.
export const currentStage = (covered: readonly string[]): Stage | null =>
  CHECKLIST.find((point) => !covered.includes(point.id))?.stage ?? null;

const sectionReady = (section: PlanSection, covered: readonly string[]): boolean =>
  STAGES.some((stage) => stage.sections.some((each) => each === section)) &&
  CHECKLIST.filter((point) =>
    STAGES.some(
      (stage) => stage.stage === point.stage && stage.sections.some((each) => each === section)
    )
  ).every((point) => covered.includes(point.id));
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
  // Checklist points ("<stage>.<point>") the answers so far have settled.
  covered: z.array(z.string()).max(CHECKLIST.length),
  question: z
    .object({
      text: z.string().trim().min(1).max(ITEM_MAX),
      why: z.string().trim().min(1).max(ITEM_MAX),
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
// Something the person added on their own, outside any question.
export type Note = { readonly note: string };
export type TrailEntry = AnsweredQuestion | Note;

// Asks the model for the next turn. Throws InterviewUnavailableError when it cannot.
export type Interviewer = (input: {
  readonly project: Pick<Project, "id" | "name" | "need" | "features">;
  readonly items: readonly PlanItem[];
  // Answers and notes, oldest first.
  readonly trail: readonly TrailEntry[];
  readonly depth: InterviewDepth;
  // Checklist points already settled.
  readonly covered: readonly string[];
  // Given only for a note: the question waiting for an answer, which the note may settle.
  readonly waiting?: Pick<Question, "text" | "kind" | "choices"> | null;
}) => Promise<{ readonly turn: Turn; readonly usage: RunUsage | null }>;

export type InterviewDeps = { readonly db: Db; readonly interviewer: Interviewer };

export type SectionStatus = "not_started" | "sketched" | "ready";

export type Interview = {
  readonly items: readonly PlanItem[];
  // Answered questions and the person's notes (`note`), oldest first.
  readonly questions: readonly Question[];
  // The question waiting for an answer, if any.
  readonly current: Question | null;
  readonly sections: Readonly<Record<PlanSection, SectionStatus>>;
  readonly depth: InterviewDepth;
  // The most questions this depth asks.
  readonly limit: number;
  readonly covered: readonly string[];
  // The stage the next question belongs to; null once the checklist is settled.
  readonly stage: Stage | null;
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
  const covered = state?.covered ?? [];
  const depth = state?.depth ?? "thorough";
  const sectionStatus = (section: PlanSection): SectionStatus => {
    if (!items.some((item) => item.section === section)) return "not_started";
    return sectionReady(section, covered) ? "ready" : "sketched";
  };
  return {
    items,
    questions: asked.filter((question) => question.answer !== null),
    current: asked.find((question) => question.answer === null) ?? null,
    sections: Object.fromEntries(
      PLAN_SECTIONS.map((section) => [section, sectionStatus(section)])
    ) as Record<PlanSection, SectionStatus>,
    depth,
    limit: QUESTION_LIMITS[depth],
    covered,
    stage: currentStage(covered),
    finished: state?.finished ?? false,
  };
};

export const trailOf = (interview: Interview): readonly TrailEntry[] =>
  interview.questions.flatMap((question): TrailEntry[] => {
    const { answer } = question;
    if (!answer) return [];
    return question.note && answer.type === "text"
      ? [{ note: answer.value }]
      : [{ question, answer }];
  });

// Questions asked so far, waiting one included. Notes are not questions.
const questionsAsked = async (db: Db, projectId: number): Promise<number> => {
  const [{ asked }] = await db
    .select({ asked: count() })
    .from(interviewQuestions)
    .where(and(eq(interviewQuestions.projectId, projectId), eq(interviewQuestions.note, false)));
  return asked;
};

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
// items that follow from something the person said are theirs. After a note, a question still
// waiting is replaced only by a new one the turn asks, which takes its place rather than adding to
// the count; a note that asks nothing leaves the interview waiting, paused or finished as it was.
const applyTurn = async (
  tx: Db,
  projectId: number,
  turn: Turn,
  source: PlanItem["source"],
  afterNote = false
): Promise<void> => {
  const changed = await applyPlanChanges(tx, projectId, turn, source);
  const asked = await questionsAsked(tx, projectId);
  const [current] = await tx
    .select({ depth: interviews.depth, covered: interviews.covered, finished: interviews.finished })
    .from(interviews)
    .where(eq(interviews.projectId, projectId));
  const [waiting] = await tx
    .select({ id: interviewQuestions.id })
    .from(interviewQuestions)
    .where(and(eq(interviewQuestions.projectId, projectId), isNull(interviewQuestions.answer)));
  const next =
    waiting || asked < QUESTION_LIMITS[current?.depth ?? "thorough"] ? turn.question : null;
  if (next && waiting)
    await tx.delete(interviewQuestions).where(eq(interviewQuestions.id, waiting.id));
  if (next) await tx.insert(interviewQuestions).values({ ...next, projectId });
  // Points stay settled once they are; only names on the checklist are kept.
  const covered = CHECKLIST.map((point) => point.id).filter(
    (id) => current?.covered.includes(id) || turn.covered.includes(id)
  );
  const finished = next === null && (afterNote ? !waiting && (current?.finished ?? false) : true);
  const state = { covered, finished };
  await tx
    .insert(interviews)
    .values({ projectId, ...state })
    .onConflictDoUpdate({ target: interviews.projectId, set: state });
  if (changed) await planChanged(tx, projectId);
};

export const lockProject = (tx: Db, id: number) =>
  tx.select({ id: projects.id }).from(projects).where(eq(projects.id, id)).for("update");

export const depthSchema = projectIdSchema.extend({ depth: z.enum(INTERVIEW_DEPTHS) });
export const startInterviewSchema = projectIdSchema.extend({
  depth: z.enum(INTERVIEW_DEPTHS).optional(),
});

// Sets how far the questions go. It can change at any time: a deeper interview that had stopped
// at the shorter limit can carry on, and a shorter one stops once its limit is reached.
export const setInterviewDepth = async (
  db: Db,
  input: { readonly id: number; readonly depth: InterviewDepth }
): Promise<Interview> => {
  await editableProject(db, input.id);
  const asked = await questionsAsked(db, input.id);
  const [state] = await db.select().from(interviews).where(eq(interviews.projectId, input.id));
  const finished = (state?.finished ?? false) && asked >= QUESTION_LIMITS[input.depth];
  await db
    .insert(interviews)
    .values({ projectId: input.id, depth: input.depth, finished })
    .onConflictDoUpdate({
      target: interviews.projectId,
      set: { depth: input.depth, finished },
    });
  return getInterview(db, input.id);
};

// Asks the first question, or the next one after a turn that failed. Does nothing while a question
// is waiting or once the interview has finished. A depth given here is set first.
export const startInterview = async (
  { db, interviewer }: InterviewDeps,
  id: number,
  depth?: InterviewDepth
): Promise<Interview> => {
  const project = await editableProject(db, id);
  if (depth) await setInterviewDepth(db, { id, depth });
  const interview = await getInterview(db, id);
  if (interview.current || interview.finished) return interview;
  const { turn, usage } = await interviewer({
    project,
    items: interview.items,
    trail: trailOf(interview),
    depth: interview.depth,
    covered: interview.covered,
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
    // The depth they chose stays; what was settled goes with the answers.
    await tx
      .update(interviews)
      .set({ covered: [], finished: false })
      .where(eq(interviews.projectId, input.id));
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

// One more entry of the trail, an answer or a note. The model is asked first and the entry stored
// (by `store`) with its turn in one step, so a failed model call stores nothing and the same words
// can be sent again.
const takeTurn = async (
  { db, interviewer }: InterviewDeps,
  project: Project,
  interview: Interview,
  entry: TrailEntry,
  source: PlanItem["source"],
  store: (tx: Db) => Promise<void>
): Promise<Interview> => {
  const afterNote = "note" in entry;
  const { turn, usage } = await interviewer({
    project,
    items: interview.items,
    trail: [...trailOf(interview), entry],
    depth: interview.depth,
    covered: interview.covered,
    ...(afterNote ? { waiting: interview.current } : {}),
  });
  await recordUsage(db, usage);
  await db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    await lockProject(tx, project.id);
    await store(tx);
    await applyTurn(tx, project.id, turn, source, afterNote);
  });
  return getInterview(db, project.id);
};

export const answerQuestion = async (
  deps: InterviewDeps,
  input: { readonly id: number; readonly questionId: number; readonly answer: Answer }
): Promise<Interview> => {
  const { db } = deps;
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
  const source = input.answer.type === "you_decide" ? "schmeide" : "you";
  return takeTurn(
    deps,
    project,
    interview,
    { question, answer: input.answer },
    source,
    async (tx) => {
      const [answered] = await tx
        .update(interviewQuestions)
        .set({ answer: input.answer, answeredAt: new Date() })
        .where(and(eq(interviewQuestions.id, question.id), isNull(interviewQuestions.answer)))
        .returning({ id: interviewQuestions.id });
      if (!answered) throw new ConflictError("That question has already been answered");
    }
  );
};

// Something the person adds on their own, outside the question waiting. It does not answer or skip
// that question; the model turns it into plan changes, all of them the person's, and may replace
// the waiting question if the note settles it. It works once the questions are finished too.
export const addNote = async (
  deps: InterviewDeps,
  input: { readonly id: number; readonly text: string }
): Promise<Interview> => {
  const project = await editableProject(deps.db, input.id);
  const interview = await getInterview(deps.db, input.id);
  const note = input.text.trim();
  return takeTurn(deps, project, interview, { note }, "you", async (tx) => {
    await tx.insert(interviewQuestions).values({
      projectId: input.id,
      text: "",
      kind: "text",
      note: true,
      answer: { type: "text", value: note },
      answeredAt: new Date(),
    });
  });
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
  business: "The business, and what the app is for",
  rules: "Rules: the cases a simple version would get wrong",
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
