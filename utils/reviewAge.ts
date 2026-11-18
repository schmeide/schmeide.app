// How old an open review item is, and whether a report is past the two working days it is
// looked at in (copy.report.lookedAt, copy.review.lookedAt). Weekends are Saturday and Sunday, UTC.

export const REPORT_WORKING_DAYS = 2;

export type AgeUnit = "minute" | "hour" | "day";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// Whole minutes, hours, or days since `at`. A future time is zero minutes.
export const ageOf = (at: Date, now: Date): { readonly amount: number; readonly unit: AgeUnit } => {
  const elapsed = Math.max(0, now.getTime() - at.getTime());
  if (elapsed < HOUR) return { amount: Math.floor(elapsed / MINUTE), unit: "minute" };
  if (elapsed < DAY) return { amount: Math.floor(elapsed / HOUR), unit: "hour" };
  return { amount: Math.floor(elapsed / DAY), unit: "day" };
};

// Working days strictly after `from`'s calendar day, up to and including `to`'s. Friday to the
// next Tuesday is two. A `to` on or before `from` is zero.
export const workingDaysAfter = (from: Date, to: Date): number => {
  const start = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  const end = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  let days = 0;
  for (let cursor = start + DAY; cursor <= end; cursor += DAY) {
    const weekday = new Date(cursor).getUTCDay();
    if (weekday !== 0 && weekday !== 6) days += 1;
  }
  return days;
};

// A report still open after the two working days it is meant to be looked at in.
export const reportOverdue = (at: Date, now: Date): boolean =>
  workingDaysAfter(at, now) > REPORT_WORKING_DAYS;
