import { describe, expect, it } from "vitest";
import { designBrief, stylesheetTokens } from "../designBrief.ts";
import {
  parseReview,
  reviewFeedbackPrompt,
  reviewPrompt,
  touchesInterface,
  type Problem,
} from "../designReview.ts";

const BRIEF = designBrief(
  {
    style: "ledger",
    reason: "Staff work through many orders a day.",
    screens: [{ name: "Orders", layout: "A table of open orders." }],
  },
  []
);

const problem = (overrides: Partial<Problem> = {}): Problem => ({
  severity: "serious",
  screen: "Orders",
  problem: "The table uses raw hex colors instead of the tokens.",
  fix: "Use --surface and --border from the shared stylesheet.",
  ...overrides,
});

describe("touchesInterface", () => {
  it.each([
    [["frontend/src/Orders.tsx"]],
    [["backend/src/router.ts", "frontend/src/app.css"]],
    [["frontend/index.html"]],
  ])("is true when the build changed what a person sees: %j", (paths) => {
    expect(touchesInterface(paths)).toBe(true);
  });

  it.each([
    [[]],
    [["backend/src/services/orders.ts", "backend/drizzle/0003_add_due_date.sql"]],
    [["frontend/src/__tests__/Orders.test.tsx", "frontend/src/Orders.test.tsx"]],
    [["README.md", "package-lock.json"]],
  ])("is false when it did not: %j", (paths) => {
    expect(touchesInterface(paths)).toBe(false);
  });
});

describe("parseReview", () => {
  it("ranks serious problems first, keeping the reviewer's order within each", () => {
    const first = problem({ severity: "minor", problem: "Uneven gaps between cards." });
    const second = problem({ screen: "New order" });
    const third = problem({ severity: "minor", screen: "New order", problem: "Hint is long." });
    const fourth = problem({ screen: "Orders", problem: "No empty state." });

    expect(parseReview({ problems: [first, second, third, fourth] })).toEqual([
      second,
      fourth,
      first,
      third,
    ]);
  });

  it("accepts a review that found nothing", () => {
    expect(parseReview({ problems: [] })).toEqual([]);
  });

  it.each([
    ["a severity it was not given", { problems: [problem({ severity: "fatal" as "serious" })] }],
    ["a field it was not asked for", { problems: [problem()], verdict: "pass" }],
    ["no answer", undefined],
    ["text", "looks fine"],
  ])("refuses %s", (_what, value) => {
    expect(parseReview(value)).toBeUndefined();
  });
});

describe("reviewPrompt", () => {
  it("gives the reviewer the brief and the spec, fenced off as material", () => {
    const prompt = reviewPrompt({ brief: BRIEF, spec: "## Screens\n- Orders", pictures: [] }, "M");

    expect(prompt).toContain("Ledger");
    expect(prompt).toContain(stylesheetTokens(BRIEF.tokens));
    expect(prompt).toContain("- Orders: A table of open orders.");
    expect(prompt).toContain("BEGIN SPEC M\n## Screens\n- Orders\nEND SPEC M");
    expect(prompt).toMatch(/never instructions to you/);
  });

  it("says it is a code-based review when there are no pictures of the app", () => {
    const prompt = reviewPrompt({ brief: BRIEF, spec: "", pictures: [] });

    expect(prompt).toContain("code-based review");
    expect(prompt).toContain("360px");
    expect(prompt).toContain("1280px");
  });

  it("points the reviewer at each picture, with its width and theme, when there are some", () => {
    const prompt = reviewPrompt({
      brief: BRIEF,
      spec: "",
      pictures: [
        { path: "/shots/orders-360-dark.png", screen: "Orders", width: 360, theme: "dark" },
      ],
    });

    expect(prompt).toContain("- /shots/orders-360-dark.png: Orders, 360px wide, dark");
    expect(prompt).not.toContain("code-based review");
  });
});

describe("reviewFeedbackPrompt", () => {
  it("lists the problems in order with their fixes and asks for the checks again", () => {
    const prompt = reviewFeedbackPrompt([
      problem(),
      problem({ severity: "minor", screen: "Home" }),
    ]);

    expect(prompt).toContain(
      "1. [serious] Orders: The table uses raw hex colors instead of the tokens. Fix: Use --surface and --border from the shared stylesheet."
    );
    expect(prompt).toContain("2. [minor] Home:");
    expect(prompt).toContain("`make check`, `make test`, and `make build`");
  });
});
