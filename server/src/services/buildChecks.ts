// What can be told about a built app's safety from its files alone: a secret committed to the
// repository, or code that sends the app's information to another service (#271). Reads files and
// git only; a secret's value never leaves this module, only where it is and what it looks like.

import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const git = async (cwd: string, ...args: string[]): Promise<readonly string[]> =>
  (await promisify(execFile)("git", args, { cwd, maxBuffer: 64 << 20 })).stdout
    .split("\n")
    .filter(Boolean);

// What the app may call or load from besides itself. Empty until integrations exist (#74); then it
// comes from the project's spec.
export const ALLOWED_HOSTS: readonly string[] = [];
// Addresses that never leave the machine or never resolve (RFC 2606, RFC 6761).
const LOCAL_HOST =
  /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|(?:.+\.)?(?:localhost|test|invalid|example)|(?:.+\.)?example\.(?:com|org|net))$/i;

const MAX_FILE_BYTES = 1 << 20;
const MAX_SHOWN = 10;
const skipped = (path: string) =>
  /(?:^|\/)(?:node_modules|dist|\.git)\//.test(path) ||
  /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|[^/]*\.lock)$/.test(path);

const textOf = async (path: string): Promise<string | undefined> => {
  const bytes = await readFile(path).catch(() => undefined);
  if (!bytes || bytes.length > MAX_FILE_BYTES || bytes.includes(0)) return undefined;
  return bytes.toString("utf8");
};

// --- Secrets ---

const KEY_FORMATS: readonly (readonly [RegExp, string])[] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a private key"],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, "an AWS access key"],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}/, "a GitHub token"],
  [/\bgithub_pat_[A-Za-z0-9_]{22,}/, "a GitHub token"],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/, "an Anthropic key"],
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/, "an API key"],
  [/\b[rs]k_live_[A-Za-z0-9]{20,}/, "a Stripe key"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/, "a Slack token"],
  [/\bAIza[0-9A-Za-z_-]{35}/, "a Google API key"],
  [/\beyJ[\w-]{10,}\.eyJ[\w-]{10,}\.[\w-]{10,}/, "a signed token (JWT)"],
];
// A value given to a name that says it is secret, or a password inside an address.
const NAMED_SECRET =
  /(?:secret|token|passw(?:or)?d|pwd|api[_-]?key|private[_-]?key|access[_-]?key|credential)[\w-]*["']?\s*[:=]\s*["'`]?([A-Za-z0-9+/_=.~!@#$%^&*-]{12,})/gi;
// An id, such as a share token in a test, not a key.
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const PASSWORD_IN_ADDRESS = /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@"'`]+:([^\s@/"'`]+)@/gi;
// Any long run of key-like characters.
const LONG_TOKEN = /(?<![\w+/=-])[A-Za-z0-9+/_=-]{32,}(?![\w+/=-])/g;

// Bits per character: a random key scores high, a word or a hex hash lower.
export const entropy = (text: string): number => {
  const counts = new Map<string, number>();
  for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1);
  return [...counts.values()]
    .map((count) => count / text.length)
    .reduce((sum, p) => sum - p * Math.log2(p), 0);
};

const randomLooking = (value: string, bits: number) =>
  entropy(value) >= bits && /\d/.test(value) && /[a-zA-Z]/.test(value);

const secretIn = (line: string): string | undefined => {
  for (const [format, what] of KEY_FORMATS) if (format.test(line)) return what;
  for (const [, value] of line.matchAll(NAMED_SECRET))
    if (!UUID.test(value) && randomLooking(value, 3.5)) return "a password or key";
  for (const [, value] of line.matchAll(PASSWORD_IN_ADDRESS))
    if (randomLooking(value, 3)) return "a password in an address";
  for (const [value] of line.matchAll(LONG_TOKEN))
    if (/[A-Z]/.test(value) && /[a-z]/.test(value) && randomLooking(value, 4.5))
      return "a long random string, like a key";
  return undefined;
};

// `.env` and `.env.<anything>` hold real values; only the template's example belongs in git.
const isEnvFile = (path: string) =>
  /(?:^|\/)\.env(?:\.[^/]+)?$/.test(path) && !/(?:^|\/)\.env\.example$/.test(path);

// Every file git would commit, ignored ones left out.
const committable = (workspace: string) =>
  git(workspace, "ls-files", "--cached", "--others", "--exclude-standard");

// What changed since `base` (the commit the build started from; the first commit when there is
// none), committed or not. Every file when git cannot tell.
const changedSince = async (workspace: string, base: string | undefined) => {
  try {
    const from = base ?? (await git(workspace, "rev-list", "--max-parents=0", "HEAD"))[0];
    return [
      ...(await git(workspace, "diff", "--name-only", "--diff-filter=d", from)),
      ...(await git(workspace, "ls-files", "--others", "--exclude-standard")),
    ];
  } catch {
    return committable(workspace);
  }
};

export const secretProblems = async (
  workspace: string,
  base?: string
): Promise<readonly string[]> => {
  const envFiles = (await committable(workspace).catch(() => [])).filter(isEnvFile);
  const found = envFiles.map(
    (path) =>
      `${path} holds environment values and must not be committed. Delete it, add it to .gitignore, and keep example values in .env.example.`
  );
  for (const path of new Set(await changedSince(workspace, base))) {
    if (skipped(path) || isEnvFile(path)) continue;
    const lines = (await textOf(join(workspace, path)))?.split("\n") ?? [];
    lines.forEach((line, index) => {
      const what = secretIn(line);
      if (what)
        found.push(
          `${path}:${index + 1} has what looks like ${what}. Remove it, and if it is real, revoke it: it stays in git history.`
        );
    });
  }
  return found;
};

// --- Calls to other services ---

const ADDRESS = String.raw`((?:https?:)?\/\/[^\s"'\`)<>]+)`;
const QUOTE = String.raw`["'\`]`;
// Where a built page loads or sends something: a stylesheet's url() and @import, a script's
// fetch() and its kin, and the props and properties that load an image, script or form target.
// A plain link (`href` on <a>, or a navigation) is left alone.
const CSS_LOADS = new RegExp(String.raw`(?:url\(\s*["']?|@import\s+["'])${ADDRESS}`, "gi");
const JS_LOADS = new RegExp(
  String.raw`(?:\b(?:fetch|sendBeacon|EventSource|WebSocket|import|importScripts|open)\(\s*${QUOTE}|\b(?:src|srcSet|srcset|action|formAction|poster)\s*[:=]\s*${QUOTE})${ADDRESS}`,
  "gi"
);
const LOADING_ATTRIBUTE = new RegExp(
  String.raw`\b(?:src|srcset|href|action|formaction|data|poster)\s*=\s*["']?\s*${ADDRESS}`,
  "gi"
);
const NOT_LOADED = /^(?:canonical|alternate|author|license|me|help)$/i;

const htmlLoads = (html: string): readonly string[] =>
  (html.match(/<[a-z][\w-]*\b[^>]*>/gi) ?? []).flatMap((tag) => {
    const name = /^<([\w-]+)/.exec(tag)?.[1].toLowerCase();
    if (name === "a" || name === "area" || name === "meta" || name === "base") return [];
    const rel = /\brel\s*=\s*["']?([^"'\s>]+)/i.exec(tag)?.[1];
    if (name === "link" && rel !== undefined && NOT_LOADED.test(rel)) return [];
    return Array.from(tag.matchAll(LOADING_ATTRIBUTE), (match) => match[1]);
  });

const hostOf = (address: string): string | undefined => {
  try {
    return new URL(address, "https://self.invalid").hostname;
  } catch {
    return undefined;
  }
};

const outside = (address: string) => {
  const host = hostOf(address);
  return host !== undefined && !LOCAL_HOST.test(host) && !ALLOWED_HOSTS.includes(host);
};

const originOf = (address: string) => new URL(address, "https://self.invalid").origin;

const filesUnder = async (dir: string): Promise<readonly string[]> =>
  (await readdir(dir, { recursive: true }).catch(() => [])).map(String).sort();

// Built frontend: what a visitor's browser would load or send from another address.
const frontendProblems = async (workspace: string): Promise<readonly string[]> => {
  const dist = join(workspace, "frontend", "dist");
  const found: string[] = [];
  for (const name of await filesUnder(dist)) {
    if (!/\.(?:html?|m?js|css)$/i.test(name)) continue;
    const text = (await textOf(join(dist, name))) ?? "";
    const addresses = [
      ...(/\.html?$/i.test(name) ? htmlLoads(text) : []),
      ...Array.from(text.matchAll(CSS_LOADS), (match) => match[1]),
      ...(/\.css$/i.test(name) ? [] : Array.from(text.matchAll(JS_LOADS), (match) => match[1])),
    ];
    for (const origin of new Set(addresses.filter(outside).map(originOf)))
      found.push(
        `frontend/dist/${name} loads from or sends to ${origin}. Serve it from the app itself (a font or image under frontend/public) or drop it.`
      );
  }
  return found;
};

// Comments are not calls; a URL's `//` follows a colon, a comment's does not.
const withoutComments = (source: string) =>
  source
    .replace(/\/\*[^]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ""))
    .replace(/(^|[^:"'`\w])\/\/.*$/gm, "$1");

// Backend source: any address outside the app, in code that ships.
const backendProblems = async (workspace: string): Promise<readonly string[]> => {
  const backend = join(workspace, "backend");
  const found: string[] = [];
  for (const name of await filesUnder(backend)) {
    if (!/\.(?:[cm]?[jt]sx?)$/.test(name) || skipped(`backend/${name}`)) continue;
    if (/(?:^|\/)__tests__\/|\.(?:test|spec)\.[^/]+$/.test(name)) continue;
    const lines = withoutComments((await textOf(join(backend, name))) ?? "").split("\n");
    lines.forEach((line, index) => {
      for (const [address] of line.matchAll(/\bhttps?:\/\/[^\s"'`)<>]+/g))
        if (outside(address))
          found.push(
            `backend/${name}:${index + 1} calls ${originOf(address)}. A built app cannot reach other services; remove the call.`
          );
    });
  }
  return found;
};

export const outboundProblems = async (workspace: string): Promise<readonly string[]> => [
  ...(await frontendProblems(workspace)),
  ...(await backendProblems(workspace)),
];

export const buildProblems = async (
  workspace: string,
  base?: string
): Promise<readonly string[]> => [
  ...(await secretProblems(workspace, base)),
  ...(await outboundProblems(workspace)),
];

export const CHECKING_SAFETY = "Checking the code for secrets and calls to other services";
export const SAFE_TO_SHIP = "The code keeps no secrets and calls no other service";
export const notSafeToShip = (count: number): string =>
  `The code has a secret or calls another service (${count} ${count === 1 ? "problem" : "problems"})`;

// What the builder is told when the check fails.
export const safetyReport = (problems: readonly string[]): string =>
  [
    "Schmeide's check of the code for secrets and calls to other services found:",
    ...problems.slice(0, MAX_SHOWN).map((problem) => `- ${problem}`),
    ...(problems.length > MAX_SHOWN
      ? [`- And ${problems.length - MAX_SHOWN} more like these.`]
      : []),
  ].join("\n");
