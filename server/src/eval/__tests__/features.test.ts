import { describe, expect, it } from "vitest";
import { liveChecks } from "../../services/acceptance.ts";
import { planOf, readApps } from "../apps.ts";
import {
  accuracyOf,
  durationOf,
  fixRoundsOf,
  reportOf,
  sampleForMarking,
  scoreOf,
  totalOf,
  type AppRun,
  type Mark,
} from "../features.ts";

const run = (overrides: Partial<AppRun> = {}): AppRun => ({
  app: "todo",
  name: "To-do list",
  checks: 4,
  outcome: "live",
  error: null,
  results: [
    { id: "F1.1", feature: "A list", verdict: "works", saw: "It showed." },
    { id: "F1.2", feature: "A list", verdict: "works", saw: "Still there." },
    { id: "F2.1", feature: "Done", verdict: "broken", saw: "Tapped Done; nothing changed." },
    { id: "F2.2", feature: "Done", verdict: "could_not_check", saw: "Sign-up needed an email." },
  ],
  fixRounds: 2,
  seconds: 372,
  costUsd: 1.234,
  ...overrides,
});

const mark = (overrides: Partial<Mark> = {}): Mark => ({
  app: "todo",
  id: "F1.1",
  feature: "A list",
  given: "Empty.",
  steps: ["Add one."],
  expect: "It shows.",
  verdict: "works",
  saw: "It showed.",
  right: null,
  ...overrides,
});

describe("the test apps", () => {
  const apps = readApps();

  it("are the to-do list, the contact book and the horse dating app", () => {
    expect(apps.map((app) => app.id)).toEqual(["contacts", "horse-dating", "todo"]);
  });

  it("check every part of the horse profile's photo carousel", () => {
    const horses = apps.find((app) => app.id === "horse-dating");
    const carousel = horses?.checks.features.find((feature) => /carousel/i.test(feature.name));
    const text = carousel?.checks.map((check) => `${check.steps.join(" ")} ${check.expect}`);
    expect(text).toEqual([
      expect.stringMatching(/next photo.*marker/is),
      expect.stringMatching(/previous photo.*marker/is),
      expect.stringMatching(/swipe.*marker/is),
      expect.stringMatching(/only one photo|red photo still shows/is),
    ]);
    expect(carousel?.checks[3]?.given).toMatch(/only one photo/);
  });

  it("number their checks as a build keeps them, from build 0", () => {
    const todo = apps.find((app) => app.id === "todo");
    const checks = todo ? liveChecks(planOf(todo)) : [];
    expect(checks.map((check) => check.id)).toEqual(["F1.1", "F1.2", "F1.3", "F2.1", "F2.2"]);
    expect(checks.every((check) => check.build === 0)).toBe(true);
  });
});

describe("scoreOf", () => {
  it("counts each verdict, and the checks with no result", () => {
    expect(scoreOf(run({ checks: 5 }))).toEqual({
      label: "To-do list",
      checks: 5,
      works: 2,
      broken: 1,
      couldNotCheck: 1,
      notFollowed: 1,
      fixRounds: 2,
      seconds: 372,
      costUsd: 1.234,
    });
  });

  it("counts every check as not followed when the build failed before the tester", () => {
    expect(scoreOf(run({ outcome: "failed", results: [] }))).toMatchObject({
      works: 0,
      notFollowed: 4,
    });
  });
});

describe("totalOf", () => {
  it("adds the apps up", () => {
    expect(totalOf([scoreOf(run()), scoreOf(run({ checks: 6, fixRounds: 0 }))])).toEqual({
      label: "All",
      checks: 10,
      works: 4,
      broken: 2,
      couldNotCheck: 2,
      notFollowed: 2,
      fixRounds: 2,
      seconds: 744,
      costUsd: expect.closeTo(2.468),
    });
  });
});

describe("fixRoundsOf", () => {
  it("is the highest round recorded, or 0", () => {
    expect(fixRoundsOf([{ round: 1 }, { round: 2 }, { round: 0 }])).toBe(2);
    expect(fixRoundsOf([])).toBe(0);
  });
});

describe("durationOf", () => {
  it("reads as minutes and seconds", () => {
    expect(durationOf(372)).toBe("6m 12s");
    expect(durationOf(65)).toBe("1m 05s");
    expect(durationOf(9.4)).toBe("9s");
  });
});

describe("sampleForMarking", () => {
  const apps = readApps();
  const plans = new Map(apps.map((app) => [app.id, planOf(app)]));
  const todo = run({
    results: [
      { id: "F1.1", feature: "A list of to-dos", verdict: "works", saw: "Showed." },
      { id: "F1.2", feature: "A list of to-dos", verdict: "broken", saw: "Gone." },
      { id: "F1.3", feature: "A list of to-dos", verdict: "could_not_check", saw: "No way in." },
      { id: "F2.1", feature: "Mark a to-do done", verdict: "works", saw: "Ticked." },
      { id: "F2.2", feature: "Mark a to-do done", verdict: "works", saw: "Still ticked." },
    ],
  });

  it("leaves out what could not be checked, and carries the check as written", () => {
    const sample = sampleForMarking([todo], plans, 10, "seed");
    expect(sample.map((each) => each.id)).toEqual(["F1.1", "F1.2", "F2.1", "F2.2"]);
    expect(sample[0]).toEqual({
      app: "todo",
      id: "F1.1",
      feature: "A list of to-dos",
      given: "The app is open and the list has no to-dos.",
      steps: ['Type "Buy oats" as a new to-do.', "Add it."],
      expect: '"Buy oats" shows in the list.',
      verdict: "works",
      saw: "Showed.",
      right: null,
    });
  });

  it("picks the same ones for the same seed, and others for another", () => {
    const ids = (seed: string) => sampleForMarking([todo], plans, 2, seed).map((each) => each.id);
    expect(ids("a")).toHaveLength(2);
    expect(ids("a")).toEqual(ids("a"));
    const seeds = ["a", "b", "c", "d", "e", "f"].map((seed) => ids(seed).join());
    expect(new Set(seeds).size).toBeGreaterThan(1);
  });
});

describe("accuracyOf", () => {
  it("counts the marked verdicts that were right, and names the wrong ones", () => {
    const wrongPass = mark({ id: "F2.1", right: false });
    const wrongFail = mark({ id: "F2.2", verdict: "broken", right: false });
    expect(accuracyOf([mark({ right: true }), mark({ id: "F1.2" }), wrongPass, wrongFail])).toEqual(
      { marked: 3, right: 1, wrongPasses: [wrongPass], wrongFails: [wrongFail] }
    );
  });
});

describe("reportOf", () => {
  it("has a row per app and a total, what does not work, and the tester's accuracy", () => {
    const report = reportOf(
      [
        run(),
        run({
          app: "contacts",
          name: "Contact book",
          checks: 7,
          outcome: "failed",
          error: "make check failed",
          results: [],
          fixRounds: 0,
          seconds: 65,
          costUsd: 0.5,
        }),
      ],
      [mark({ right: true }), mark({ id: "F1.2", right: true }), mark({ id: "F2.1", right: false })]
    );
    expect(report).toBe(`## Features that work

| Test app | Checks that work | Fix rounds | Time | Cost |
| --- | --- | --- | --- | --- |
| To-do list | 2 of 4 (50%) | 2 | 6m 12s | $1.23 |
| Contact book | 0 of 7 (0%) | 0 | 1m 05s | $0.50 |
| All | 2 of 11 (18%) | 2 | 7m 17s | $1.73 |

Not working:

- To-do list F2.1 (Done) broken: Tapped Done; nothing changed.
- To-do list F2.2 (Done) could not be checked: Sign-up needed an email.
- Contact book: the build failed: make check failed

## Tester verdicts

Right on 2 of 3 marked (67%). Passed but broken: todo F2.1.
`);
  });

  it("says how to mark the verdicts when none are marked", () => {
    expect(reportOf([run()], [mark()])).toContain("None of the 1 sampled verdicts are marked yet.");
  });

  it("says when there was no verdict to mark", () => {
    expect(reportOf([run({ results: [] })], [])).toContain("No verdicts to mark");
  });

  it("says which checks were not followed on a build that went live", () => {
    expect(reportOf([run({ checks: 6 })], [])).toContain(
      "- To-do list: 2 of 6 checks were not followed"
    );
  });
});
