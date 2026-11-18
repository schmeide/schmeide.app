import { ageOf, reportOverdue, workingDaysAfter } from "../reviewAge";

describe("ageOf", () => {
  const now = new Date("2026-11-18T12:00:00Z");

  it("counts minutes, then hours, then days", () => {
    expect(ageOf(new Date("2026-11-18T11:59:30Z"), now)).toEqual({ amount: 0, unit: "minute" });
    expect(ageOf(new Date("2026-11-18T11:00:00Z"), now)).toEqual({ amount: 1, unit: "hour" });
    expect(ageOf(new Date("2026-11-18T09:30:00Z"), now)).toEqual({ amount: 2, unit: "hour" });
    expect(ageOf(new Date("2026-11-16T12:00:00Z"), now)).toEqual({ amount: 2, unit: "day" });
  });
});

describe("working days", () => {
  // 2026-11-13 is a Friday.
  const friday = new Date("2026-11-13T18:00:00Z");

  it("skips Saturday and Sunday, and does not count the day it was opened", () => {
    expect(workingDaysAfter(friday, new Date("2026-11-13T23:00:00Z"))).toBe(0);
    expect(workingDaysAfter(friday, new Date("2026-11-16T09:00:00Z"))).toBe(1);
    expect(workingDaysAfter(friday, new Date("2026-11-17T09:00:00Z"))).toBe(2);
    expect(workingDaysAfter(friday, new Date("2026-11-18T09:00:00Z"))).toBe(3);
  });

  it("calls a report overdue once two working days have passed", () => {
    expect(reportOverdue(friday, new Date("2026-11-17T23:00:00Z"))).toBe(false);
    expect(reportOverdue(friday, new Date("2026-11-18T00:00:00Z"))).toBe(true);
  });
});
