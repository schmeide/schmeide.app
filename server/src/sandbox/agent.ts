// The agent's entry point in a build pod (docs/stage2.md, "Agent runs: a Job per run"). The Job's
// script has cloned the project's staging branch into the working directory; this runs query()
// with the options the worker uses on the host and prints every SDK message as one JSON line,
// which the worker reads back from the pod's log. Then it commits what the agent left and pushes
// staging, also when the pod is stopped (SIGTERM), so a deleted pod loses at most the turn it was in.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { claudeEnv } from "../services/claudeEnv.ts";
import { AGENT_ALLOWED_TOOLS, AGENT_TOOLS, agentOptions } from "../temporal/activities.ts";

const cwd = process.cwd();
const prompt = readFileSync("/run/schmeide/prompt", "utf8");
const model = process.env.SCHMEIDE_MODEL ?? "opus";

const git = (...args: readonly string[]) =>
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "inherit"] })
    .toString()
    .trim();

const abortController = new AbortController();
process.once("SIGTERM", () => abortController.abort());

let ok = false;
try {
  for await (const message of query({
    prompt,
    options: {
      ...agentOptions(
        cwd,
        // The model gets the claude allow list and the pod's own test database, nothing else.
        { ...claudeEnv(), TEST_DATABASE_URL: process.env.TEST_DATABASE_URL ?? "" },
        model
      ),
      tools: AGENT_TOOLS,
      allowedTools: AGENT_ALLOWED_TOOLS,
      abortController,
    },
  })) {
    console.log(JSON.stringify(message));
    if (message.type === "result") ok = message.subtype === "success" && !message.is_error;
  }
} finally {
  git("add", "-A");
  if (git("status", "--porcelain"))
    git("commit", "-q", "-m", "keep what the builder left uncommitted");
  git("push", "-q", "origin", "HEAD:refs/heads/staging");
  console.log(JSON.stringify({ type: "schmeide", pushed: git("rev-parse", "HEAD") }));
}
process.exit(ok ? 0 : 1);
