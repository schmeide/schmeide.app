import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import type { LookupFunction } from "node:net";
import type { Readable, Transform } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import type { WEBSITE_OWNERS } from "../db/schema.ts";
import { reducePage, type PageDigest, type ReducedPage } from "./htmlText.ts";
import { robotsAllows } from "./robots.ts";
import { NO_EXCEPTIONS, addressAllowed, checkUrl, parseAddress, portOf } from "./webAddress.ts";

export const READ_FAILURES = [
  "unreachable",
  "needs_sign_in",
  "blocks_readers",
  "nothing_found",
  "refused_address",
] as const;
export type ReadFailure = (typeof READ_FAILURES)[number];

export type Whose = (typeof WEBSITE_OWNERS)[number];

export type SiteRead =
  | { readonly ok: true; readonly url: string; readonly pages: readonly PageDigest[] }
  | { readonly ok: false; readonly reason: ReadFailure };

export type SiteFetcher = (input: {
  readonly address: string;
  readonly whose: Whose;
}) => Promise<SiteRead>;

export type Resolve = (
  hostname: string
) => Promise<readonly { readonly address: string; readonly family: number }[]>;

export type FetchLimits = {
  readonly totalMs: number;
  readonly pageBytes: number;
  readonly robotsBytes: number;
  readonly redirects: number;
  readonly pages: number;
};

export const DEFAULT_LIMITS: FetchLimits = {
  totalMs: 20_000,
  pageBytes: 1_000_000,
  robotsBytes: 100_000,
  redirects: 5,
  pages: 4,
};

export const BOT_TOKEN = "SchmeideBot";
export const USER_AGENT = `${BOT_TOKEN}/1.0 (+https://schmeide.app)`;

export type FetcherConfig = {
  readonly userAgent?: string;
  readonly limits?: Partial<FetchLimits>;
  readonly exceptions?: ReadonlySet<string>;
  readonly resolve?: Resolve;
};

type Run = {
  readonly deadline: number;
  readonly limits: FetchLimits;
  readonly exceptions: ReadonlySet<string>;
  readonly resolve: Resolve;
  readonly userAgent: string;
  readonly robots: Map<string, Promise<string | ReadFailure>>;
};

type Want = "page" | "robots";

type Failed = { readonly kind: "failed"; readonly reason: ReadFailure };
type Answered = {
  readonly kind: "response";
  readonly status: number;
  readonly body: string | null;
};
type Got = Failed | Answered | { readonly kind: "redirect"; readonly location: string };
type Followed = Failed | (Answered & { readonly url: URL });

const failed = (reason: ReadFailure): Failed => ({ kind: "failed", reason });

const HTML_TYPES: readonly string[] = ["text/html", "application/xhtml+xml"];
const SIGN_IN_TEXT = 1500;
const USEFUL_TEXT = 40;
const WORTH_READING =
  /about|service|product|pricing|price|feature|offer|menu|shop|what-we-do|leistung|angebot|ueber|über|preise/i;
const NOT_A_PAGE = /\.(pdf|zip|jpe?g|png|gif|webp|svg|mp4|mp3|docx?|xlsx?|css|js|xml|json)$/i;

const systemResolve: Resolve = (hostname) => dnsLookup(hostname, { all: true });

const decoderFor = (encoding: string): (() => Transform) | null | undefined =>
  ({
    "": null,
    identity: null,
    gzip: createGunzip,
    "x-gzip": createGunzip,
    deflate: createInflate,
    br: createBrotliDecompress,
  })[encoding];

const decodeText = (bytes: Buffer, contentType: string): string => {
  const charset = /charset\s*=\s*"?([\w-]+)/i.exec(contentType)?.[1] ?? "utf-8";
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
};

const get = (run: Run, url: URL, want: Want): Promise<Got> =>
  new Promise((resolve) => {
    const remaining = run.deadline - Date.now();
    if (remaining <= 0) {
      resolve(failed("unreachable"));
      return;
    }
    const port = portOf(url);
    const limit = want === "page" ? run.limits.pageBytes : run.limits.robotsBytes;
    const state = { done: false, refused: false };

    const lookup: LookupFunction = (hostname, options, callback) => {
      run.resolve(hostname).then(
        (found) => {
          if (
            found.length === 0 ||
            found.some((to) => !addressAllowed(to.address, port, run.exceptions))
          ) {
            state.refused = true;
            callback(new Error("This address is not one the reader may connect to"), "", 0);
          } else if (options.all) callback(null, [...found]);
          else callback(null, found[0].address, found[0].family);
        },
        (error: Error) => callback(error, "", 0)
      );
    };

    const request = (url.protocol === "https:" ? https : http).request(
      url,
      {
        method: "GET",
        agent: false,
        lookup,
        headers: {
          "user-agent": run.userAgent,
          accept: want === "page" ? "text/html,application/xhtml+xml" : "text/plain,*/*;q=0.1",
          "accept-encoding": "gzip, br",
        },
      },
      (response) => {
        const remote = (response.socket.remoteAddress ?? "").replace(/^::ffff:(?=\d+\.)/, "");
        if (!addressAllowed(remote, port, run.exceptions)) {
          finish(failed("refused_address"));
          return;
        }
        const status = response.statusCode ?? 0;
        const { location } = response.headers;
        if (status >= 300 && status < 400 && location) {
          finish({ kind: "redirect", location });
          return;
        }
        const contentType = response.headers["content-type"] ?? "";
        const type = contentType.split(";")[0].trim().toLowerCase();
        const decoder = decoderFor((response.headers["content-encoding"] ?? "").toLowerCase());
        const readable = want === "robots" || HTML_TYPES.includes(type);
        if (status < 200 || status >= 300 || !readable || decoder === undefined) {
          finish({ kind: "response", status, body: null });
          return;
        }
        const stream: Readable = decoder ? response.pipe(decoder()) : response;
        const chunks: Buffer[] = [];
        const read = { bytes: 0 };
        const finishBody = () =>
          finish({
            kind: "response",
            status,
            body: decodeText(Buffer.concat(chunks), contentType),
          });
        stream.on("data", (chunk: Buffer) => {
          if (state.done) return;
          chunks.push(chunk.subarray(0, limit - read.bytes));
          read.bytes += chunk.length;
          if (read.bytes >= limit) finishBody();
        });
        stream.on("end", finishBody);
        stream.on("error", () => finish(failed("unreachable")));
        response.on("error", () => finish(failed("unreachable")));
      }
    );

    const timer = setTimeout(() => finish(failed("unreachable")), remaining);
    function finish(got: Got): void {
      if (state.done) return;
      state.done = true;
      clearTimeout(timer);
      request.destroy();
      resolve(got);
    }
    request.on("error", () => finish(failed(state.refused ? "refused_address" : "unreachable")));
    request.end();
  });

const urlFrom = (location: string, base: URL): URL | null => {
  try {
    return new URL(location, base);
  } catch {
    return null;
  }
};

const follow = async (run: Run, url: URL, want: Want, hops = 0): Promise<Followed> => {
  if (!checkUrl(url.href, run.exceptions).ok) return failed("refused_address");
  if (want === "page") {
    const blocked = await robotsFailure(run, url);
    if (blocked) return failed(blocked);
  }
  const got = await get(run, url, want).catch(() => failed("unreachable"));
  if (got.kind !== "redirect") return got.kind === "failed" ? got : { ...got, url };
  const next = urlFrom(got.location, url);
  if (!next || hops >= run.limits.redirects) return failed("unreachable");
  return follow(run, next, want, hops + 1);
};

const loadRobots = async (run: Run, origin: string): Promise<string | ReadFailure> => {
  const answer = await follow(run, new URL("/robots.txt", origin), "robots");
  if (answer.kind === "failed") return answer.reason;
  if (answer.status >= 200 && answer.status < 300) return answer.body ?? "";
  return answer.status >= 400 && answer.status < 500 ? "" : "blocks_readers";
};

const isFailure = (value: string): value is ReadFailure =>
  (READ_FAILURES as readonly string[]).includes(value);

const robotsFailure = async (run: Run, url: URL): Promise<ReadFailure | null> => {
  const loading = run.robots.get(url.origin) ?? loadRobots(run, url.origin);
  run.robots.set(url.origin, loading);
  const robots = await loading;
  if (isFailure(robots)) return robots;
  return robotsAllows(robots, BOT_TOKEN, `${url.pathname}${url.search}`) ? null : "blocks_readers";
};

type Page =
  | { readonly ok: true; readonly url: URL; readonly page: ReducedPage }
  | { readonly ok: false; readonly reason: ReadFailure };

const statusFailure = (status: number): ReadFailure => {
  if (status === 401 || status === 407) return "needs_sign_in";
  if (status === 403 || status === 429 || status === 451 || status === 999) return "blocks_readers";
  return "unreachable";
};

const readPage = async (run: Run, url: URL, withBrand: boolean): Promise<Page> => {
  const answer = await follow(run, url, "page");
  if (answer.kind === "failed") return { ok: false, reason: answer.reason };
  if (answer.status < 200 || answer.status >= 300)
    return { ok: false, reason: statusFailure(answer.status) };
  if (answer.body === null) return { ok: false, reason: "nothing_found" };
  return {
    ok: true,
    url: answer.url,
    page: reducePage(answer.body, answer.url.href, withBrand),
  };
};

const site = (url: URL): string => url.hostname.replace(/^www\./, "");

const pathKey = (url: URL): string => url.pathname.replace(/\/$/, "");

export const pickLinks = (page: ReducedPage, from: URL, count: number): readonly URL[] =>
  page.links
    .flatMap(({ href, text }) => {
      const url = urlFrom(href.split("#")[0], from);
      const wanted =
        url &&
        site(url) === site(from) &&
        pathKey(url) !== pathKey(from) &&
        !NOT_A_PAGE.test(url.pathname) &&
        WORTH_READING.test(`${text} ${url.pathname}`);
      return url && wanted ? [url] : [];
    })
    .filter(
      (url, index, all) => all.findIndex((other) => pathKey(other) === pathKey(url)) === index
    )
    .slice(0, Math.max(0, count));

const isEmpty = ({ text, headings }: PageDigest): boolean =>
  text.length < USEFUL_TEXT && headings.length === 0;

export const createSiteFetcher = (config: FetcherConfig = {}): SiteFetcher => {
  const limits = { ...DEFAULT_LIMITS, ...config.limits };
  const exceptions = config.exceptions ?? NO_EXCEPTIONS;
  return async ({ address, whose }) => {
    const start = parseAddress(address, exceptions);
    if (!start.ok) return { ok: false, reason: "refused_address" };
    const run: Run = {
      deadline: Date.now() + limits.totalMs,
      limits,
      exceptions,
      resolve: config.resolve ?? systemResolve,
      userAgent: config.userAgent ?? USER_AGENT,
      robots: new Map(),
    };
    const withBrand = whose === "mine";
    const first = await readPage(run, start.url, withBrand);
    if (!first.ok) return first;
    if (first.page.asksForPassword && first.page.digest.text.length < SIGN_IN_TEXT)
      return { ok: false, reason: "needs_sign_in" };
    const more = await Promise.all(
      pickLinks(first.page, first.url, limits.pages - 1).map((url) => readPage(run, url, false))
    );
    const pages = [
      first.page.digest,
      ...more.flatMap((next) =>
        next.ok && site(next.url) === site(first.url) && !next.page.asksForPassword
          ? [next.page.digest]
          : []
      ),
    ].filter((digest) => !isEmpty(digest));
    if (pages.length === 0) return { ok: false, reason: "nothing_found" };
    return { ok: true, url: first.url.href, pages };
  };
};
