import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.ts";
import {
  ITEM_MAX,
  interviewQuestions,
  planItems,
  planSection,
  projectIdSchema,
  readBacks,
  type PlanItem,
  type Project,
  type ReadBackSentence,
} from "../db/schema.ts";
import { recordUsage, type RunUsage } from "./builds.ts";
import { InterviewUnavailableError, NotFoundError } from "./errors.ts";
import {
  applyPlanChanges,
  editableProject,
  getInterview,
  lockProject,
  planChanged,
  planItemsOf,
  trailOf,
  type Interviewer,
} from "./interview.ts";

// Open points are a short list to answer or leave, not a second interview.
export const MAX_OPEN = 5;

const sentence = z.object({
  text: z.string().trim().min(1).max(ITEM_MAX),
  ask: z.string().trim().min(1).max(ITEM_MAX),
});

// What the model returns: the account, and points the plan leaves unsettled, each worded as what
// will be assumed if it is left.
export const writtenSchema = z.object({
  business: z.array(sentence).min(1).max(5),
  steps: z.array(sentence).min(1).max(12),
  open: z
    .array(
      z.object({
        section: z.enum(planSection.enumValues),
        text: z.string().trim().min(1).max(ITEM_MAX),
      })
    )
    .max(MAX_OPEN),
});
export type Written = z.infer<typeof writtenSchema>;

// Writes the account from the plan. Throws InterviewUnavailableError when it cannot.
export type ReadBackWriter = (input: {
  readonly project: Pick<Project, "id" | "name" | "need" | "features">;
  readonly items: readonly PlanItem[];
}) => Promise<{ readonly output: Written; readonly usage: RunUsage | null }>;

export type ReadBackDeps = {
  readonly db: Db;
  readonly interviewer: Interviewer;
  // Absent, the read-back cannot be written and the person goes on to the spec without it.
  readonly readBackWriter?: ReadBackWriter;
};

export type ReadBack = {
  // Null until written, and again after every change to the plan.
  readonly account: {
    readonly business: readonly ReadBackSentence[];
    readonly steps: readonly ReadBackSentence[];
  } | null;
  // Day-one items Schmeide chose: "You decide" answers and defaults nobody was asked about.
  readonly chosen: readonly PlanItem[];
  readonly open: readonly PlanItem[];
  readonly later: readonly PlanItem[];
};

export const getReadBack = async (db: Db, id: number): Promise<ReadBack> => {
  const items = await planItemsOf(db, id);
  const [row] = await db.select().from(readBacks).where(eq(readBacks.projectId, id));
  return {
    account: row ? { business: row.business, steps: row.steps } : null,
    chosen: items.filter(
      (item) => item.source === "schmeide" && item.phase === "day_one" && !item.open
    ),
    open: items.filter((item) => item.open),
    later: items.filter((item) => item.phase === "later" && !item.open),
  };
};

// Writes the account if there is none. Open points it finds go into the plan first, so the
// account never says what the plan does not hold.
export const writeReadBack = async (deps: ReadBackDeps, id: number): Promise<ReadBack> => {
  const { db, readBackWriter } = deps;
  const project = await editableProject(db, id);
  const current = await getReadBack(db, id);
  if (current.account) return current;
  if (!readBackWriter) throw new InterviewUnavailableError("No read-back writer is configured");
  const items = await planItemsOf(db, id);
  const { output, usage } = await readBackWriter({ project, items });
  await recordUsage(db, usage);
  await db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    await lockProject(tx, id);
    const [written] = await tx.select().from(readBacks).where(eq(readBacks.projectId, id));
    // Another call wrote it while the model was working; keep that one.
    if (written) return;
    const known = new Set(items.map((item) => item.text));
    const room = MAX_OPEN - current.open.length;
    const open = output.open.filter((point) => !known.has(point.text)).slice(0, Math.max(room, 0));
    if (open.length) {
      await tx
        .insert(planItems)
        .values(
          open.map((point) => ({
            ...point,
            projectId: id,
            source: "schmeide" as const,
            open: true,
          }))
        );
      await planChanged(tx, id);
    }
    await tx
      .insert(readBacks)
      .values({ projectId: id, business: output.business, steps: output.steps });
  });
  return getReadBack(db, id);
};

export const correctReadBackSchema = projectIdSchema.extend({
  // A sentence marked "That's not right", or an open point being answered.
  target: z.union([
    z.object({ part: z.enum(["business", "steps"]), index: z.number().int().min(0) }),
    z.object({ itemId: z.number().int() }),
  ]),
  answer: z.string().trim().min(1).max(2000),
});

// One answer about one sentence or open point: the plan changes from it first, then the account
// is written again from the plan. The model's next question is not asked; this is not a second
// interview.
export const correctReadBack = async (
  deps: ReadBackDeps,
  input: z.infer<typeof correctReadBackSchema>
): Promise<ReadBack> => {
  const { db, interviewer } = deps;
  const project = await editableProject(db, input.id);
  const current = await getReadBack(db, input.id);
  const { target } = input;
  const about =
    "itemId" in target
      ? current.open.find((item) => item.id === target.itemId)
      : current.account?.[target.part][target.index];
  if (!about) throw new NotFoundError("That point is not in the read-back any more");
  const { asked, prompt } =
    "ask" in about
      ? {
          asked: about.ask,
          prompt: `We read back to them: "${about.text}" They said that is not right. ${about.ask}`,
        }
      : {
          asked: about.text,
          prompt: `We assumed: "${about.text}" How should it work instead?`,
        };
  const answer = { type: "text", value: input.answer } as const;
  const interview = await getInterview(db, input.id);
  const { turn, usage } = await interviewer({
    project,
    items: interview.items,
    trail: [
      ...trailOf(interview),
      { question: { text: prompt, kind: "text", choices: [] }, answer },
    ],
  });
  await recordUsage(db, usage);
  await db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    await lockProject(tx, input.id);
    await tx.insert(interviewQuestions).values({
      projectId: input.id,
      text: asked,
      kind: "text",
      answer,
      answeredAt: new Date(),
    });
    await applyPlanChanges(tx, input.id, turn, "you");
    if ("itemId" in target) {
      await tx
        .update(planItems)
        .set({ open: false, source: "you" })
        .where(and(eq(planItems.id, target.itemId), eq(planItems.projectId, input.id)));
    }
    // Even with no change to the plan, the account is written again: the person said it was wrong.
    await planChanged(tx, input.id);
  });
  return writeReadBack(deps, input.id);
};
