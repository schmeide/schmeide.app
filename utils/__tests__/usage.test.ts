import { currentMonth, formatCost, formatTokens } from "../usage";

describe("usage", () => {
  it("formats tokens and cost as a project's page shows them", () => {
    expect(formatTokens(1234567)).toBe("1,234,567");
    expect(formatCost(0.3)).toBe("$0.30");
  });

  it("takes the current month in UTC, first day to last", () => {
    expect(currentMonth(new Date("2026-02-10T12:00:00Z"))).toEqual({
      from: "2026-02-01",
      to: "2026-02-28",
    });
    // Evening of 30 November in New York is already December in UTC.
    expect(currentMonth(new Date("2026-11-30T21:00:00-05:00"))).toEqual({
      from: "2026-12-01",
      to: "2026-12-31",
    });
  });
});
