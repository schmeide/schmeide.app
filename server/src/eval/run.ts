// `make interview/eval`: runs the interview against the scripted owners in owners.ts and writes each
// transcript, with its measures, to docs/interview-transcripts/<depth>/. Real model calls: the
// interviewer asks, and a second model plays the owner from their fact sheet. No database.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { INTERVIEW_DEPTHS, type Answer, type InterviewDepth, type PlanItem } from "../db/schema.ts";
import { claudeEnv } from "../services/claudeEnv.ts";
import {
  CHECKLIST,
  QUESTION_LIMITS,
  type AnsweredQuestion,
  type Turn,
} from "../services/interview.ts";
import { createInterviewer } from "../services/interviewer.ts";
import {
  measure,
  raisedBlindSpots,
  quotesEarlier,
  type Exchange,
  type Metrics,
} from "./metrics.ts";
import { OWNERS, type Owner } from "./owners.ts";

const USAGE = `Usage: node src/eval/run.ts [--owner <id>] [--depth quick|thorough] [--model <model>]

Runs the interview against scripted owners (${OWNERS.map((owner) => owner.id).join(", ")}) and writes
transcripts to docs/interview-transcripts/<depth>/. Makes real model calls: needs \`claude\` signed in
(run \`make doctor\` to check). --model defaults to SCHMEIDE_INTERVIEW_MODEL, then "sonnet"; the owner
is played by --owner-model (default "haiku").`;

const { values } = parseArgs({
  options: {
    owner: { type: "string" },
    depth: { type: "string", default: "thorough" },
    model: { type: "string", default: process.env.SCHMEIDE_INTERVIEW_MODEL ?? "sonnet" },
    "owner-model": { type: "string", default: "haiku" },
    help: { type: "boolean", short: "h" },
  },
});
if (values.help) {
  console.log(USAGE);
  process.exit(0);
}
const depth = INTERVIEW_DEPTHS.find((each) => each === values.depth);
const owners = values.owner ? OWNERS.filter((owner) => owner.id === values.owner) : OWNERS;
if (!depth || owners.length === 0) {
  console.error(`Unknown --depth or --owner.\n\n${USAGE}`);
  process.exit(2);
}

const dataDir = mkdtempSync(join(tmpdir(), "schmeide-interview-eval-"));
const claudeBin = process.env.SCHMEIDE_CLAUDE_BIN;
const interviewer = createInterviewer({ dataDir, claudeBin, model: values.model });

const replySchema = z.object({
  leaveToYou: z.boolean(),
  picked: z.array(z.string()),
  words: z.string(),
});
type Reply = z.infer<typeof replySchema>;

const ownerPrompt = (
  owner: Owner,
  question: NonNullable<Turn["question"]>
): string => `You are a small business owner answering a question about an app being made for your business. Answer only from these facts about you. Answer briefly, the way a busy owner would, in a sentence or two at most. Never bring up a topic the question does not ask about. When the facts do not cover the question, say you are not sure, or pick what seems sensible for you.

Facts about you:
${owner.facts}

The question: ${question.text}
${question.choices.length ? `Choices: ${question.choices.map((choice) => `"${choice}"`).join(", ")}` : question.kind === "yes_no" ? 'Choices: "yes", "no"' : "Answer in your own words."}

Return "picked": the choices you pick, copied exactly (empty when you answer in words). "words": your answer in your own words when no choice fits, otherwise empty. "leaveToYou": true only when you genuinely do not care and want them to decide.`;

const ownerReply = async (
  owner: Owner,
  question: NonNullable<Turn["question"]>
): Promise<Reply> => {
  for await (const message of query({
    prompt: ownerPrompt(owner, question),
    options: {
      cwd: dataDir,
      model: values["owner-model"],
      pathToClaudeCodeExecutable: claudeBin,
      settingSources: [],
      settings: { claudeMdExcludes: [join(homedir(), ".claude", "**")] },
      env: { ...claudeEnv(), CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" },
      permissionMode: "dontAsk",
      tools: [],
      maxTurns: 3,
      persistSession: false,
      outputFormat: {
        type: "json_schema",
        schema: Object.fromEntries(
          Object.entries(z.toJSONSchema(replySchema)).filter(([key]) => key !== "$schema")
        ),
      },
    },
  })) {
    if (message.type !== "result") continue;
    if (message.subtype !== "success")
      throw new Error(`The owner's run failed: ${message.subtype}`);
    return replySchema.parse(message.structured_output ?? JSON.parse(message.result));
  }
  throw new Error("The owner's run ended without a result");
};

// The reply as the interview would receive it from the page.
const toAnswer = (question: NonNullable<Turn["question"]>, reply: Reply): Answer => {
  if (reply.leaveToYou) return { type: "you_decide" };
  const words = reply.words.trim();
  if (question.kind === "yes_no" && !words && reply.picked.length === 1) {
    return { type: "yes_no", value: reply.picked[0].toLowerCase() === "yes" };
  }
  const picked = reply.picked.filter((choice) => question.choices.includes(choice));
  if (question.kind !== "text" && question.kind !== "yes_no" && !words && picked.length) {
    return { type: "choices", values: question.kind === "pick_one" ? picked.slice(0, 1) : picked };
  }
  return { type: "text", value: [...picked, words].filter(Boolean).join("; ") || "I'm not sure" };
};

const answerWords = (answer: Answer): string => {
  switch (answer.type) {
    case "choices":
      return answer.values.join(", ");
    case "yes_no":
      return answer.value ? "Yes" : "No";
    case "text":
      return answer.value;
    case "you_decide":
      return "(left to Schmeide)";
  }
};

// The plan as the database would keep it, with ids handed out here.
const applyTurn = (items: readonly PlanItem[], turn: Turn, nextId: () => number): PlanItem[] => [
  ...items
    .filter((item) => !turn.remove.includes(item.id))
    .map((item) => {
      const change = turn.update.find((each) => each.id === item.id);
      return change ? { ...item, text: change.text } : item;
    }),
  ...turn.add.map((item) => ({
    ...item,
    id: nextId(),
    projectId: 0,
    source: "you" as const,
    open: false,
    createdAt: new Date(),
  })),
];

const interview = async (owner: Owner, depth: InterviewDepth) => {
  const project = { id: 0, name: owner.name, need: owner.need, features: "" };
  let id = 0;
  const nextId = () => ++id;
  let items: PlanItem[] = [];
  let covered: readonly string[] = [];
  const trail: AnsweredQuestion[] = [];
  const transcript: Exchange[] = [];
  for (;;) {
    const started = Date.now();
    const { turn, usage } = await interviewer({ project, items, trail, depth, covered });
    const ms = Date.now() - started;
    const costUsd = usage?.models.reduce((sum, model) => sum + model.costUsd, 0) ?? 0;
    items = applyTurn(items, turn, nextId);
    covered = CHECKLIST.map((point) => point.id).filter(
      (point) => covered.includes(point) || turn.covered.includes(point)
    );
    const { question } = turn;
    if (!question || trail.length >= QUESTION_LIMITS[depth]) break;
    const answer = toAnswer(question, await ownerReply(owner, question));
    trail.push({ question, answer });
    transcript.push({ question, answer: answerWords(answer), ms, costUsd });
    console.log(`${owner.id} ${trail.length}: ${question.text} -> ${answerWords(answer)}`);
  }
  return { transcript, items, covered };
};

const money = (usd: number) => `$${usd.toFixed(3)}`;
const row = (owner: Owner, metrics: Metrics) =>
  `| ${owner.id} | ${metrics.questions} | ${metrics.quotesEarlier} | ${metrics.raisesUnmentioned} | ${metrics.withWhy} | ${money(metrics.costUsd)} | ${metrics.secondsPerQuestion.toFixed(1)} |`;
const HEADER = [
  "| Owner | Questions | Quote an earlier answer | Raise what they did not mention | With a reason | Cost | Seconds per question |",
  "| --- | --- | --- | --- | --- | --- | --- |",
];

const transcriptText = (
  owner: Owner,
  result: Awaited<ReturnType<typeof interview>>,
  metrics: Metrics
): string => {
  const exchanges = result.transcript.map((exchange, index) => {
    const before = result.transcript.slice(0, index).map((each) => each.answer);
    const marks = [
      ...(index > 0 && quotesEarlier(exchange.question.text, before)
        ? ["builds on an answer"]
        : []),
      ...raisedBlindSpots(owner, exchange.question, before).map((topic) => `raises ${topic}`),
    ];
    return [
      `### ${index + 1}. ${exchange.question.text}`,
      "",
      `_Why:_ ${exchange.question.why || "(none given)"}`,
      ...(exchange.question.choices.length
        ? ["", `_Choices:_ ${exchange.question.choices.join(" / ")}`]
        : []),
      "",
      `**Answer:** ${exchange.answer}`,
      "",
      `_${(exchange.ms / 1000).toFixed(1)}s, ${money(exchange.costUsd)}${marks.length ? `; ${marks.join("; ")}` : ""}_`,
    ].join("\n");
  });
  const plan = result.items.map(
    (item) => `- ${item.section}: ${item.text}${item.phase === "later" ? " (later)" : ""}`
  );
  const open = CHECKLIST.filter((point) => !result.covered.includes(point.id)).map(
    (point) => `- ${point.id}`
  );
  return [
    `# ${owner.name} (${owner.id}), ${depth}`,
    "",
    `Model ${values.model}, owner played by ${values["owner-model"]}, ${new Date().toISOString().slice(0, 10)}.`,
    "",
    `> ${owner.need}`,
    "",
    ...HEADER,
    row(owner, metrics),
    "",
    "## Questions",
    "",
    exchanges.join("\n\n"),
    "",
    "## The plan at the end",
    "",
    ...(plan.length ? plan : ["Nothing."]),
    "",
    "## Checklist points left open",
    "",
    ...(open.length ? open : ["None."]),
    "",
  ].join("\n");
};

const out = new URL(`../../../docs/interview-transcripts/${depth}/`, import.meta.url);
mkdirSync(out, { recursive: true });
const rows: string[] = [];
for (const owner of owners) {
  const result = await interview(owner, depth);
  const metrics = measure(owner, result.transcript);
  writeFileSync(new URL(`${owner.id}.md`, out), transcriptText(owner, result, metrics));
  rows.push(row(owner, metrics));
}
// The summary covers every owner, so a run of one owner leaves it as it was.
if (!values.owner) {
  writeFileSync(
    new URL("README.md", out),
    [
      `# Interview transcripts: ${depth}`,
      "",
      `Written by \`make interview/eval DEPTH=${depth}\` with model ${values.model} on ${new Date().toISOString().slice(0, 10)}. See [the guide](../../interview-eval.md) for how to read them.`,
      "",
      ...HEADER,
      ...rows,
      "",
    ].join("\n")
  );
}
console.log(`Wrote ${owners.length} transcript(s) to ${out.pathname}`);
