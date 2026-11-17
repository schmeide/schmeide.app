type Rule = { readonly allow: boolean; readonly pattern: string };
type Group = { readonly agents: readonly string[]; readonly rules: readonly Rule[] };

const MAX_LINES = 5000;

const parseGroups = (robots: string): readonly Group[] =>
  robots
    .split(/\r\n|\r|\n/)
    .slice(0, MAX_LINES)
    .map((line) => /^\s*([a-z-]+)\s*:\s*(.*?)\s*$/i.exec(line.replace(/#.*$/, "")))
    .reduce<{ readonly groups: readonly Group[]; readonly open: boolean }>(
      ({ groups, open }, match) => {
        if (!match) return { groups, open };
        const key = match[1].toLowerCase();
        const value = match[2];
        const last = groups.at(-1);
        if (key === "user-agent") {
          const agent = value.toLowerCase();
          return last && open
            ? {
                groups: [...groups.slice(0, -1), { ...last, agents: [...last.agents, agent] }],
                open,
              }
            : { groups: [...groups, { agents: [agent], rules: [] }], open: true };
        }
        if ((key !== "allow" && key !== "disallow") || !last) return { groups, open: false };
        const rule = { allow: key === "allow", pattern: value };
        return {
          groups: [...groups.slice(0, -1), { ...last, rules: [...last.rules, rule] }],
          open: false,
        };
      },
      { groups: [], open: false }
    ).groups;

const matches = (pattern: string, path: string): boolean => {
  const anchored = pattern.endsWith("$");
  const parts = (anchored ? pattern.slice(0, -1) : pattern).split("*");
  const first = parts[0];
  const last = parts[parts.length - 1];
  if (!path.startsWith(first)) return false;
  if (parts.length === 1) return !anchored || path.length === first.length;
  const end = (anchored ? parts.slice(1, -1) : parts.slice(1)).reduce((at, part) => {
    const found = at < 0 ? -1 : path.indexOf(part, at);
    return found < 0 ? -1 : found + part.length;
  }, first.length);
  if (end < 0) return false;
  return !anchored || (path.length - last.length >= end && path.endsWith(last));
};

export const robotsAllows = (robots: string, agent: string, path: string): boolean => {
  const groups = parseGroups(robots);
  const token = agent.toLowerCase();
  const named = groups.filter(({ agents }) => agents.includes(token));
  const chosen = named.length > 0 ? named : groups.filter(({ agents }) => agents.includes("*"));
  const best = chosen
    .flatMap(({ rules }) => rules)
    .filter(({ pattern }) => pattern !== "" && matches(pattern, path || "/"))
    .reduce<Rule | null>(
      (winner, rule) =>
        !winner ||
        rule.pattern.length > winner.pattern.length ||
        (rule.pattern.length === winner.pattern.length && rule.allow)
          ? rule
          : winner,
      null
    );
  return best ? best.allow : true;
};
