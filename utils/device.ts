// A browser and operating system from a session's user agent, for the list of signed-in
// devices. Only the common ones; anything else is null and shown as an unknown browser.
export type Device = { readonly browser: string | null; readonly os: string | null };

// Order matters: Edge and Opera also say Chrome, and Chrome also says Safari.
const BROWSERS: readonly (readonly [RegExp, string])[] = [
  [/\bEdg(e|A|iOS)?\//, "Edge"],
  [/\bOPR\//, "Opera"],
  [/\b(Firefox|FxiOS)\//, "Firefox"],
  [/\b(Chrome|CriOS)\//, "Chrome"],
  [/\bVersion\/[\d.]+.*\bSafari\//, "Safari"],
];

// iPhone and iPad before macOS, which their agents also mention; Android before Linux.
const SYSTEMS: readonly (readonly [RegExp, string])[] = [
  [/\biPhone\b/, "iPhone"],
  [/\biPad\b/, "iPad"],
  [/\bAndroid\b/, "Android"],
  [/\bWindows NT\b/, "Windows"],
  [/\bCrOS\b/, "ChromeOS"],
  [/\bMac OS X\b/, "macOS"],
  [/\bLinux\b/, "Linux"],
];

const first = (agent: string, table: readonly (readonly [RegExp, string])[]) =>
  table.find(([pattern]) => pattern.test(agent))?.[1] ?? null;

export const describeDevice = (agent: string | null): Device =>
  agent
    ? { browser: first(agent, BROWSERS), os: first(agent, SYSTEMS) }
    : { browser: null, os: null };
