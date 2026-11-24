// Measures of a feature evaluation run (`make eval/features`): for each test app, the share of its
// acceptance checks that work, the fix rounds the build used, its time and its cost; and, from the
// verdicts a person marked afterwards, how often the tester was right. Pure: e2e/features.ts builds
// the apps and writes what it recorded, and reads it back for the report.
import { createHash } from "node:crypto";
import { z } from "zod";
import { VERDICTS, liveChecks, type AcceptancePlan } from "../services/acceptance.ts";

const resultSchema = z.strictObject({
  id: z.string(),
  feature: z.string(),
  verdict: z.enum(VERDICTS),
  saw: z.string(),
});

// One test app's build, as the run recorded it. `checks` is how many the app's file holds;
// `results` are the tester's last results for the build (build_acceptance), one per check it
// followed, and `fixRounds` the round they came from.
const appRunSchema = z.strictObject({
  app: z.string(),
  name: z.string(),
  checks: z.number().int().nonnegative(),
  outcome: z.enum(["live", "failed"]),
  error: z.string().nullable(),
  results: z.array(resultSchema),
  fixRounds: z.number().int().nonnegative(),
  seconds: z.number().nonnegative(),
  costUsd: z.number().nonnegative(),
});
export type AppRun = z.infer<typeof appRunSchema>;

export const runFileSchema = z.strictObject({
  startedAt: z.string(),
  runs: z.array(appRunSchema),
});
export type RunFile = z.infer<typeof runFileSchema>;

// A verdict for a person to mark: the check as written, what the tester said and saw, and `right`,
// which the person sets to true or false after trying the check in the app themselves.
const markSchema = z.strictObject({
  app: z.string(),
  id: z.string(),
  feature: z.string(),
  given: z.string(),
  steps: z.array(z.string()),
  expect: z.string(),
  verdict: z.enum(VERDICTS),
  saw: z.string(),
  right: z.boolean().nullable(),
});
export type Mark = z.infer<typeof markSchema>;
export const marksSchema = z.array(markSchema);

export type Score = {
  readonly label: string;
  readonly checks: number;
  readonly works: number;
  readonly broken: number;
  readonly couldNotCheck: number;
  // Checks with no result: the build failed before the tester, or the tester was off.
  readonly notFollowed: number;
  readonly fixRounds: number;
  readonly seconds: number;
  readonly costUsd: number;
};

const count = (run: AppRun, verdict: (typeof VERDICTS)[number]) =>
  run.results.filter((result) => result.verdict === verdict).length;

export const scoreOf = (run: AppRun): Score => ({
  label: run.name,
  checks: run.checks,
  works: count(run, "works"),
  broken: count(run, "broken"),
  couldNotCheck: count(run, "could_not_check"),
  notFollowed: Math.max(0, run.checks - run.results.length),
  fixRounds: run.fixRounds,
  seconds: run.seconds,
  costUsd: run.costUsd,
});

export const totalOf = (scores: readonly Score[]): Score =>
  scores.reduce<Score>(
    (sum, score) => ({
      label: "All",
      checks: sum.checks + score.checks,
      works: sum.works + score.works,
      broken: sum.broken + score.broken,
      couldNotCheck: sum.couldNotCheck + score.couldNotCheck,
      notFollowed: sum.notFollowed + score.notFollowed,
      fixRounds: sum.fixRounds + score.fixRounds,
      seconds: sum.seconds + score.seconds,
      costUsd: sum.costUsd + score.costUsd,
    }),
    {
      label: "All",
      checks: 0,
      works: 0,
      broken: 0,
      couldNotCheck: 0,
      notFollowed: 0,
      fixRounds: 0,
      seconds: 0,
      costUsd: 0,
    }
  );

// The tester's highest fix round among a build's results, 0 when none were recorded.
export const fixRoundsOf = (rows: readonly { readonly round: number }[]): number =>
  rows.reduce((most, row) => Math.max(most, row.round), 0);

// `size` verdicts to mark, picked from every run's "works" and "broken" results by a hash of
// `seed`, so the same run always gives the same sample. "could_not_check" says nothing about the
// feature, so it is left out.
export const sampleForMarking = (
  runs: readonly AppRun[],
  plans: ReadonlyMap<string, AcceptancePlan>,
  size: number,
  seed: string
): readonly Mark[] => {
  const rank = (app: string, id: string) =>
    createHash("sha256").update(`${seed}:${app}:${id}`).digest("hex");
  return runs
    .flatMap((run) => {
      const checks = liveChecks(plans.get(run.app) ?? { features: [] });
      return run.results
        .filter((result) => result.verdict !== "could_not_check")
        .flatMap((result) => {
          const check = checks.find((each) => each.id === result.id);
          return check
            ? [
                {
                  app: run.app,
                  id: result.id,
                  feature: result.feature,
                  given: check.given,
                  steps: [...check.steps],
                  expect: check.expect,
                  verdict: result.verdict,
                  saw: result.saw,
                  right: null,
                },
              ]
            : [];
        });
    })
    .map((mark) => ({ mark, rank: rank(mark.app, mark.id) }))
    .sort((a, b) => a.rank.localeCompare(b.rank))
    .slice(0, size)
    .map(({ mark }) => mark)
    .sort(
      (a, b) => a.app.localeCompare(b.app) || a.id.localeCompare(b.id, "en", { numeric: true })
    );
};

export type Accuracy = {
  readonly marked: number;
  readonly right: number;
  // Verdicts a person found wrong: checks the tester passed that do not work, and checks it called
  // broken that do.
  readonly wrongPasses: readonly Mark[];
  readonly wrongFails: readonly Mark[];
};

export const accuracyOf = (marks: readonly Mark[]): Accuracy => {
  const marked = marks.filter((mark) => mark.right !== null);
  const wrong = marked.filter((mark) => mark.right === false);
  return {
    marked: marked.length,
    right: marked.length - wrong.length,
    wrongPasses: wrong.filter((mark) => mark.verdict === "works"),
    wrongFails: wrong.filter((mark) => mark.verdict === "broken"),
  };
};

const percent = (part: number, whole: number) =>
  whole === 0 ? "-" : `${Math.round((part / whole) * 100)}%`;

export const durationOf = (seconds: number): string => {
  const whole = Math.round(seconds);
  const minutes = Math.floor(whole / 60);
  return minutes === 0 ? `${whole}s` : `${minutes}m ${String(whole % 60).padStart(2, "0")}s`;
};

const row = (score: Score) =>
  `| ${score.label} | ${score.works} of ${score.checks} (${percent(score.works, score.checks)}) | ${score.fixRounds} | ${durationOf(score.seconds)} | $${score.costUsd.toFixed(2)} |`;

const VERDICT_WORDS = {
  works: "works",
  broken: "broken",
  could_not_check: "could not be checked",
} as const;

// Each check that does not work, or the reason none was followed.
const notWorking = (run: AppRun): readonly string[] => {
  const missing = run.checks - run.results.length;
  return [
    ...(run.outcome === "failed"
      ? [`${run.name}: the build failed: ${run.error ?? "no reason given"}`]
      : []),
    ...(missing > 0 && run.outcome !== "failed"
      ? [`${run.name}: ${missing} of ${run.checks} checks were not followed`]
      : []),
    ...run.results
      .filter((result) => result.verdict !== "works")
      .map(
        (result) =>
          `${run.name} ${result.id} (${result.feature}) ${VERDICT_WORDS[result.verdict]}: ${result.saw}`
      ),
  ];
};

const named = (marks: readonly Mark[]) => marks.map((mark) => `${mark.app} ${mark.id}`).join(", ");

// The report of a run, in Markdown, ready for a pull request: one row per test app and a total,
// what does not work, and the tester's accuracy on the verdicts marked so far.
export const reportOf = (runs: readonly AppRun[], marks: readonly Mark[]): string => {
  const scores = runs.map(scoreOf);
  const accuracy = accuracyOf(marks);
  const problems = runs.flatMap(notWorking);
  const verdicts =
    marks.length === 0
      ? "No verdicts to mark: the tester called no check working or broken."
      : accuracy.marked === 0
        ? `None of the ${marks.length} sampled verdicts are marked yet. Set \`right\` to true or false for each in \`verdicts.json\`, then run \`make eval/features/report\`.`
        : [
            `Right on ${accuracy.right} of ${accuracy.marked} marked (${percent(accuracy.right, accuracy.marked)}).`,
            ...(accuracy.wrongPasses.length > 0
              ? [`Passed but broken: ${named(accuracy.wrongPasses)}.`]
              : []),
            ...(accuracy.wrongFails.length > 0
              ? [`Called broken but works: ${named(accuracy.wrongFails)}.`]
              : []),
          ].join(" ");
  return [
    "## Features that work",
    "",
    "| Test app | Checks that work | Fix rounds | Time | Cost |",
    "| --- | --- | --- | --- | --- |",
    ...scores.map(row),
    ...(scores.length > 1 ? [row(totalOf(scores))] : []),
    "",
    ...(problems.length > 0
      ? ["Not working:", "", ...problems.map((problem) => `- ${problem}`), ""]
      : []),
    "## Tester verdicts",
    "",
    verdicts,
    "",
  ].join("\n");
};
