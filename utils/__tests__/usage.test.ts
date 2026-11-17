import { currentMonth, formatCost, formatDuration, formatTokens } from "../usage";

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

  it("formats a duration in minutes and seconds under an hour, hours and minutes above", () => {
    expect(formatDuration(0)).toBe("0 s");
    expect(formatDuration(-500)).toBe("0 s");
    expect(formatDuration(59_400)).toBe("59 s");
    expect(formatDuration(61_000)).toBe("1 min 1 s");
    expect(formatDuration(3_599_000)).toBe("59 min 59 s");
    expect(formatDuration(3_600_000)).toBe("1 h 0 min");
    expect(formatDuration(5_430_000)).toBe("1 h 30 min");
    expect(formatDuration(30 * 3_600_000)).toBe("30 h 0 min");
  });
});
