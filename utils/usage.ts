import { copy } from "../data/copy";

// How tokens, cost, and time read on a project's page and in the admin area.
const count = new Intl.NumberFormat("en-US");

export const TOKEN_FIELDS = [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheCreationTokens",
] as const;

export const NO_USAGE = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  costUsd: 0,
} as const;

export const formatTokens = (tokens: number): string => count.format(tokens);
export const formatCost = (usd: number): string => `$${usd.toFixed(2)}`;

// Minutes and seconds under an hour, hours and minutes from an hour on.
export const formatDuration = (ms: number): string => {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes < 60
    ? copy.duration(minutes, seconds % 60)
    : copy.longDuration(Math.floor(minutes / 60), minutes % 60);
};

// The month `now` falls in, in UTC, as its first and last day: what the usage page opens on.
export const currentMonth = (now: Date): { readonly from: string; readonly to: string } => {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  // Day 0 of the next month is the last day of this one.
  const day = (monthOffset: number, date: number) =>
    new Date(Date.UTC(year, month + monthOffset, date)).toISOString().slice(0, 10);
  return { from: day(0, 1), to: day(1, 0) };
};
