import { query } from "@anthropic-ai/claude-agent-sdk";
const cwd = process.argv[2];
for await (const m of query({
  prompt:
    'Without using tools, answer yes/no for each: does your context contain the exact phrases (a) "Prefer subagents for most substantive work" (b) "always use -s to include a sign-off" (c) "Test-Driven Development". Then quote the first heading line of every CLAUDE.md or memory file loaded in your context, with its path if shown.',
  options: {
    cwd,
    model: "haiku",
    settingSources: ["project"],
    pathToClaudeCodeExecutable: process.env.CB,
    tools: ["Read", "Bash"],
    allowedTools: ["Read", "Bash(make:*)"],
    permissionMode: "dontAsk",
    persistSession: false,
    settings: {
      claudeMdExcludes: [process.env.HOME + "/.claude/CLAUDE.md", process.env.HOME + "/.claude/**"],
    },
    env: { ...process.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" },
  },
})) {
  if (m.type === "system" && m.subtype === "init")
    console.log(
      "INIT",
      JSON.stringify({
        sc: m.slash_commands,
        plugins: m.plugins,
        skills: (m as { skills?: unknown }).skills,
        apiKeySource: m.apiKeySource,
        mcp: m.mcp_servers,
      })
    );
  if (m.type === "result") console.log("RESULT", m.subtype === "success" ? m.result : m.subtype);
}
