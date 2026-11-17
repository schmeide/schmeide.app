import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it, vi } from "vitest";
import type { Query } from "../builds.ts";
import { InterviewUnavailableError } from "../errors.ts";
import type { Interviewer } from "../interview.ts";
import { createInterviewer, interviewPrompt } from "../interviewer.ts";

const config = { dataDir: tmpdir(), claudeBin: undefined, model: "sonnet" } as const;

type Call = { prompt: string; options: Options };

// Stands in for the Claude Agent SDK: one result carrying the given structured output.
const fakeQuery = (calls: Call[], result: Record<string, unknown>): Query =>
  ((params: Call) => {
    calls.push(params);
    return (async function* (): AsyncGenerator<SDKMessage> {
      yield {
        type: "result",
        duration_ms: 1500,
        subtype: "success",
        is_error: false,
        result: "",
        modelUsage: {
          "claude-test": {
            inputTokens: 10,
            outputTokens: 20,
            cacheReadInputTokens: 30,
            cacheCreationInputTokens: 40,
            costUSD: 0.01,
          },
        },
        ...result,
      } as unknown as SDKMessage;
    })();
  }) as unknown as Query;

const TURN = {
  add: [{ section: "who", text: "Only the owner", phase: "day_one" }],
  update: [],
  remove: [],
  ready: ["who"],
  question: { text: "Do invoices have a due date?", kind: "yes_no", choices: [] },
};

const input: Parameters<Interviewer>[0] = {
  project: { id: 7, name: "Invoices", need: "", features: "Keep a list of my clients" },
  items: [
    {
      id: 41,
      projectId: 7,
      section: "does",
      text: "Create an invoice",
      source: "schmeide",
      phase: "day_one",
      createdAt: new Date(),
    },
  ],
  trail: [
    {
      question: { text: "Who sends the invoices?", kind: "pick_one", choices: ["Just me"] },
      answer: { type: "choices", values: ["Just me"] },
    },
    {
      question: { text: "Do you send reminders?", kind: "yes_no", choices: [] },
      answer: { type: "you_decide" },
    },
  ],
};

describe("interviewPrompt", () => {
  it("opens with what the person said they need on the start page", () => {
    const prompt = interviewPrompt({
      ...input,
      project: { ...input.project, need: "I need to send invoices and see who has paid" },
    });

    expect(prompt).toContain(
      "What they said they need when they started, in their own words:\nI need to send invoices and see who has paid"
    );
  });
});

describe("createInterviewer", () => {
  it("gives the model the project, the plan with its ids, and the answers so far", async () => {
    vi.stubEnv("SCHMEIDE_AUTH_SECRET", "secret");
    const calls: Call[] = [];
    const interviewer = createInterviewer(config, fakeQuery(calls, { structured_output: TURN }));

    const result = await interviewer(input);

    expect(result.turn).toEqual(TURN);
    expect(result.usage).toEqual({
      run: { projectId: 7, buildId: null, runKind: "interview", durationMs: 1500 },
      models: [
        expect.objectContaining({
          projectId: 7,
          buildId: null,
          runKind: "interview",
          model: "claude-test",
          costUsd: 0.01,
        }),
      ],
    });
    const [{ prompt, options }] = calls;
    expect(prompt).toContain("Invoices");
    expect(prompt).toContain("Keep a list of my clients");
    expect(prompt).toContain("[41] Create an invoice");
    expect(prompt).toContain("Who sends the invoices?\n   Answer: Just me");
    expect(prompt).toContain("Do you send reminders?\n   Answer: (left for you to decide)");
    expect(options).toMatchObject({
      cwd: config.dataDir,
      model: "sonnet",
      tools: [],
      settingSources: [],
      persistSession: false,
      outputFormat: { type: "json_schema", schema: expect.objectContaining({ type: "object" }) },
    });
    // Claude Code refuses a schema that carries "$schema".
    expect(options.outputFormat?.schema).not.toHaveProperty("$schema");
    expect(options.env?.SCHMEIDE_AUTH_SECRET).toBeUndefined();
    expect(options.env?.DATABASE_URL).toBeUndefined();
    expect(options.env?.PATH).toBe(process.env.PATH);
  });

  it("reads the turn from the reply text when there is no structured output", async () => {
    const reply = `\`\`\`json\n${JSON.stringify({ ...TURN, question: null })}\n\`\`\``;
    const interviewer = createInterviewer(config, fakeQuery([], { result: reply }));

    expect((await interviewer(input)).turn.question).toBeNull();
  });

  it("turns a choice question with too few choices into one answered in words", async () => {
    const question = { text: "Who uses it?", kind: "pick_many", choices: ["Me"] };
    const interviewer = createInterviewer(
      config,
      fakeQuery([], { structured_output: { ...TURN, question } })
    );

    expect((await interviewer(input)).turn.question).toEqual({
      text: "Who uses it?",
      kind: "text",
      choices: [],
    });
  });

  it.each([
    ["the run fails", { subtype: "error_max_turns", is_error: true }],
    ["the reply is not a turn", { structured_output: { question: "What?" } }],
    ["the reply is not JSON", { result: "Let me think about that." }],
  ])("is unavailable when %s", async (_, result) => {
    const interviewer = createInterviewer(config, fakeQuery([], result));

    await expect(interviewer(input)).rejects.toBeInstanceOf(InterviewUnavailableError);
  });

  it("uses the stand-in command when one is configured, with the prompt in AGENT_PROMPT", async () => {
    const script = join(mkdtempSync(join(tmpdir(), "schmeide-interviewer-")), "agent.sh");
    writeFileSync(
      script,
      `#!/usr/bin/env bash\n[[ "$1" == interview && "$AGENT_PROMPT" == *Invoices* ]] && echo '${JSON.stringify(TURN)}'\n`,
      { mode: 0o755 }
    );
    const interviewer = createInterviewer({ ...config, agentCmd: script }, fakeQuery([], {}));

    expect(await interviewer(input)).toEqual({ turn: TURN, usage: null });
  });
});
