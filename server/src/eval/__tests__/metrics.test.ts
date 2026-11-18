import { describe, expect, it } from "vitest";
import { measure, quotesEarlier, raisedBlindSpots, type Exchange } from "../metrics.ts";
import { OWNERS } from "../owners.ts";

const owner = {
  need: "I need to send invoices.",
  blindSpots: [
    { topic: "tax", keywords: ["tax"] },
    { topic: "late payers", keywords: ["overdue", "late pay"] },
  ],
};

const exchange = (text: string, answer: string, why = "Because.", ms = 4000): Exchange => ({
  question: { text, why, kind: "text", choices: [] },
  answer,
  ms,
  costUsd: 0.01,
});

describe("quotesEarlier", () => {
  it("counts a question that repeats three words of an earlier answer", () => {
    expect(
      quotesEarlier("Can the two staff send them on their own?", ["Me and my two staff send them"])
    ).toBe(true);
  });

  it("counts a question that says it follows what they said", () => {
    expect(quotesEarlier("You mentioned letting agents. Do they pay later?", [])).toBe(true);
  });

  it("does not count words in common that are only filler", () => {
    expect(quotesEarlier("What is the best way to do it?", ["it is the way it is"])).toBe(false);
  });
});

describe("raisedBlindSpots", () => {
  it("finds a topic the owner has not mentioned yet, in the question or its reason", () => {
    expect(
      raisedBlindSpots(
        owner,
        {
          text: "Do you add anything to prices?",
          why: "Tax changes the total.",
          kind: "text",
          choices: [],
        },
        []
      )
    ).toEqual(["tax"]);
  });

  it("does not count a topic the owner already brought up", () => {
    expect(
      raisedBlindSpots(
        owner,
        { text: "What do you do about overdue invoices?", why: "", kind: "text", choices: [] },
        ["Some are overdue every month"]
      )
    ).toEqual([]);
  });
});

describe("measure", () => {
  it("counts questions, follow-ups, raised topics, reasons, cost, and time", () => {
    expect(
      measure(owner, [
        exchange("What do you sell?", "Plumbing for homeowners and letting agents"),
        exchange("You said letting agents. Do they pay by transfer?", "Yes, within a month", ""),
        exchange("What happens when an invoice is overdue?", "I ring them", "Because.", 7000),
      ])
    ).toEqual({
      questions: 3,
      quotesEarlier: 1,
      raisesUnmentioned: 1,
      withWhy: 2,
      costUsd: expect.closeTo(0.03),
      secondsPerQuestion: 5,
    });
  });
});

describe("the scripted owners", () => {
  it("are the four the issue names, each with blind spots to raise", () => {
    expect(OWNERS.map((each) => each.id)).toEqual(["plumber", "salon", "bakery", "bookkeeper"]);
    for (const each of OWNERS) expect(each.blindSpots.length).toBeGreaterThan(2);
  });
});
