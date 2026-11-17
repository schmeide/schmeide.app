import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { USER_AGENT, createSiteFetcher, type FetcherConfig, type Resolve } from "../siteFetcher.ts";

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

const routes = new Map<string, Handler>();
const seen: { readonly path: string; readonly host: string; readonly agent: string }[] = [];

const server = http.createServer((request, response) => {
  seen.push({
    path: request.url ?? "",
    host: request.headers.host ?? "",
    agent: request.headers["user-agent"] ?? "",
  });
  const handler = routes.get(request.url ?? "");
  if (handler) handler(request, response);
  else response.writeHead(404).end();
});

const listening = (target: http.Server): Promise<number> =>
  new Promise((resolve) => {
    target.listen(0, "127.0.0.1", () => resolve((target.address() as AddressInfo).port));
  });

const ports = { site: 0, dead: 0 };

beforeAll(async () => {
  ports.site = await listening(server);
  const closed = http.createServer();
  ports.dead = await listening(closed);
  await new Promise((resolve) => closed.close(resolve));
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});
beforeEach(() => {
  routes.clear();
  seen.length = 0;
});

const HOSTS: Readonly<Record<string, readonly string[]>> = {
  "shop.test": ["127.0.0.1"],
  "www.shop.test": ["127.0.0.1"],
  "other.test": ["127.0.0.1"],
  "inside.test": ["10.0.0.5"],
  "metadata.test": ["169.254.169.254"],
  "mixed.test": ["93.184.216.34", "127.0.0.1"],
  "mapped.test": ["::ffff:127.0.0.1"],
};

const resolve: Resolve = async (hostname) => {
  const found = HOSTS[hostname];
  if (!found) throw new Error(`getaddrinfo ENOTFOUND ${hostname}`);
  return found.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
};

const testOnly = (): ReadonlySet<string> =>
  new Set([`127.0.0.1:${ports.site}`, `127.0.0.1:${ports.dead}`]);

const fetcher = (config: FetcherConfig = {}) =>
  createSiteFetcher({ resolve, exceptions: testOnly(), ...config });

const at = (path = "/", host = "shop.test", port = ports.site) => `http://${host}:${port}${path}`;

const html =
  (body: string, headers: http.OutgoingHttpHeaders = {}): Handler =>
  (_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", ...headers }).end(body);
  };

const status =
  (code: number, headers: http.OutgoingHttpHeaders = {}): Handler =>
  (_request, response) => {
    response.writeHead(code, headers).end();
  };

const text = (body: string): Handler => html(body, { "content-type": "text/plain" });

const HOME = `<title>Shop</title><h1>Welcome to the shop</h1>
<p>We sell bread and cakes, and you can order ahead for collection.</p>
<a href="/about">About us</a> <a href="/services">Our services</a> <a href="/pricing">Pricing</a>
<a href="/menu">Menu</a> <a href="/products">Products</a> <a href="/contact">Contact</a>
<a href="http://other.test:${0}/about">About our partner</a>`;

const page = (name: string) =>
  html(`<title>${name}</title><h1>${name}</h1><p>${name} page with plenty of words on it.</p>`);

const paths = () => seen.map(({ path }) => path);

describe("createSiteFetcher", () => {
  it("reads the page given and a few same-site pages it links to, and says who it is", async () => {
    routes.set("/", html(HOME.replace(":0/", `:${ports.site}/`)));
    for (const path of ["/about", "/services", "/pricing", "/menu", "/products"])
      routes.set(path, page(path.slice(1)));

    const read = await fetcher()({ address: at(), whose: "someone_else" });

    expect(read).toMatchObject({ ok: true, url: at() });
    if (!read.ok) return;
    expect(read.pages.map(({ url }) => url)).toEqual([
      at(),
      at("/about"),
      at("/services"),
      at("/pricing"),
    ]);
    expect(read.pages[0]).toMatchObject({
      title: "Shop",
      headings: ["Welcome to the shop"],
    });
    expect(read.pages[0].text).toContain("We sell bread and cakes");
    expect(paths().sort()).toEqual(["/", "/about", "/pricing", "/robots.txt", "/services"]);
    expect(seen.every(({ agent }) => agent === USER_AGENT)).toBe(true);
    expect(seen.every(({ host }) => host === `shop.test:${ports.site}`)).toBe(true);
    expect(USER_AGENT).toMatch(/^SchmeideBot\/\d.* \(\+https:\/\/schmeide\.app\)$/);
  });

  it("reads no more pages than its limit", async () => {
    routes.set("/", html(HOME));
    routes.set("/about", page("about"));

    const read = await fetcher({ limits: { pages: 1 } })({ address: at(), whose: "mine" });

    expect(read.ok && read.pages).toHaveLength(1);
    expect(paths()).toEqual(["/robots.txt", "/"]);
  });

  it("collects logo and color candidates only for a person's own site", async () => {
    routes.set(
      "/",
      html(`<meta name="theme-color" content="#123456"><img src="/logo.png" alt="Shop logo">
      <h1>Shop</h1><p>Plenty of words for a page that is worth reading.</p>`)
    );

    const mine = await fetcher()({ address: at(), whose: "mine" });
    const others = await fetcher()({ address: at(), whose: "someone_else" });

    expect(mine.ok && mine.pages[0].brand).toEqual({
      siteName: "",
      colors: ["#123456"],
      logos: [at("/logo.png")],
    });
    expect(others.ok && others.pages[0].brand).toBeUndefined();
  });

  it("reads a compressed page", async () => {
    routes.set("/", (_request, response) => {
      response
        .writeHead(200, { "content-type": "text/html", "content-encoding": "gzip" })
        .end(gzipSync("<h1>Squeezed</h1><p>These words arrived compressed and were read.</p>"));
    });

    const read = await fetcher()({ address: at(), whose: "someone_else" });

    expect(read.ok && read.pages[0].headings).toEqual(["Squeezed"]);
  });

  describe("the address guard", () => {
    it("refuses this machine by default: only the test's own allowance lets it through", async () => {
      routes.set("/", page("home"));

      const byName = await createSiteFetcher({ resolve })({ address: at(), whose: "mine" });
      const byNumber = await createSiteFetcher()({
        address: at("/", "127.0.0.1"),
        whose: "mine",
      });
      const onPort80 = await createSiteFetcher({ resolve })({
        address: "http://shop.test/",
        whose: "mine",
      });

      expect(byName).toEqual({ ok: false, reason: "refused_address" });
      expect(byNumber).toEqual({ ok: false, reason: "refused_address" });
      expect(onPort80).toEqual({ ok: false, reason: "refused_address" });
      expect(seen).toEqual([]);
    });

    it.each([
      ["ftp://shop.test/"],
      ["http://user:secret@shop.test/"],
      ["http://shop.test:8080/"],
      ["http://localhost/"],
      ["http://169.254.169.254/latest/meta-data/"],
      ["http://[::ffff:127.0.0.1]/"],
    ])("refuses %s before anything is sent", async (address) => {
      expect(await fetcher()({ address, whose: "mine" })).toEqual({
        ok: false,
        reason: "refused_address",
      });
      expect(seen).toEqual([]);
    });

    it.each([
      ["a private address", "inside.test"],
      ["the cloud metadata address", "metadata.test"],
      ["a public and a private address at once", "mixed.test"],
      ["a private address written as IPv6", "mapped.test"],
    ])("refuses a name that resolves to %s", async (_, host) => {
      const read = await fetcher()({ address: at("/", host), whose: "mine" });

      expect(read).toEqual({ ok: false, reason: "refused_address" });
      expect(seen).toEqual([]);
    });

    it.each([
      ["a private address", "http://10.0.0.5/"],
      ["the cloud metadata address", "http://169.254.169.254/latest/meta-data/"],
      ["this machine on another port", "http://127.0.0.1:22/"],
      ["this machine as IPv6", "http://[::1]/"],
      ["a name that resolves to a private address", "http://inside.test/"],
      ["another scheme", "file:///etc/passwd"],
      ["an address with a password in it", "http://user:secret@shop.test/"],
    ])("refuses a redirect to %s", async (_, location) => {
      routes.set("/", status(302, { location }));

      const read = await fetcher()({ address: at(), whose: "mine" });

      expect(read).toEqual({ ok: false, reason: "refused_address" });
      expect(paths()).toEqual(["/robots.txt", "/"]);
    });

    it("refuses a private address at the second redirect too", async () => {
      routes.set("/", status(301, { location: "/moved" }));
      routes.set("/moved", status(307, { location: "http://192.168.1.1/admin" }));

      const read = await fetcher()({ address: at(), whose: "mine" });

      expect(read).toEqual({ ok: false, reason: "refused_address" });
    });

    it("checks the address it connects to, not an earlier answer for the same name", async () => {
      routes.set("/", page("home"));
      const answers = [["127.0.0.1"], ["10.0.0.5"]];
      const asked: string[] = [];
      const rebinding: Resolve = async (hostname) => {
        asked.push(hostname);
        const now = answers[Math.min(asked.length - 1, answers.length - 1)];
        return now.map((address) => ({ address, family: 4 }));
      };

      const read = await fetcher({ resolve: rebinding })({ address: at(), whose: "mine" });

      expect(asked).toEqual(["shop.test", "shop.test"]);
      expect(read).toEqual({ ok: false, reason: "refused_address" });
      expect(paths()).toEqual(["/robots.txt"]);
    });
  });

  describe("redirects", () => {
    it("follows them by hand to the page, and reports where it ended", async () => {
      routes.set("/", status(301, { location: "/en/" }));
      routes.set("/en/", status(302, { location: at("/en/home", "www.shop.test") }));
      routes.set("/en/home", page("home"));

      const read = await fetcher()({ address: at(), whose: "mine" });

      expect(read).toMatchObject({ ok: true, url: at("/en/home", "www.shop.test") });
    });

    it("gives up after its limit", async () => {
      routes.set("/", status(302, { location: "/" }));

      const read = await fetcher({ limits: { redirects: 3 } })({ address: at(), whose: "mine" });

      expect(read).toEqual({ ok: false, reason: "unreachable" });
      expect(paths().filter((path) => path === "/")).toHaveLength(4);
    });
  });

  describe("limits", () => {
    it("stops reading a page at the size cap", async () => {
      const sent = { bytes: 0, closedEarly: false };
      routes.set("/", (_request, response) => {
        response.writeHead(200, { "content-type": "text/html" });
        response.write("<h1>Endless</h1>");
        const chunk = `<p>${"word ".repeat(2000)}</p>`;
        const timer = setInterval(() => {
          sent.bytes += chunk.length;
          response.write(chunk);
        }, 1);
        response.on("close", () => {
          sent.closedEarly = true;
          clearInterval(timer);
        });
      });

      const read = await fetcher({ limits: { pageBytes: 50_000 } })({
        address: at(),
        whose: "mine",
      });

      expect(read.ok && read.pages[0].headings).toEqual(["Endless"]);
      await expect.poll(() => sent.closedEarly).toBe(true);
      expect(sent.bytes).toBeLessThan(2_000_000);
    });

    it("stops a compressed page at the size cap too", async () => {
      routes.set("/", (_request, response) => {
        response
          .writeHead(200, { "content-type": "text/html", "content-encoding": "gzip" })
          .end(gzipSync(`<h1>Bomb</h1>${"<p>word word word</p>".repeat(500_000)}`));
      });

      const read = await fetcher({ limits: { pageBytes: 50_000 } })({
        address: at(),
        whose: "mine",
      });

      expect(read.ok && read.pages[0].headings).toEqual(["Bomb"]);
      expect(read.ok && read.pages[0].text.length).toBeLessThanOrEqual(6000);
    });

    it("gives up on a site that does not answer in time", async () => {
      routes.set("/", () => undefined);
      const started = Date.now();

      const read = await fetcher({ limits: { totalMs: 300 } })({ address: at(), whose: "mine" });

      expect(read).toEqual({ ok: false, reason: "unreachable" });
      expect(Date.now() - started).toBeLessThan(2000);
    });

    it("gives up on a page that arrives too slowly", async () => {
      routes.set("/", (_request, response) => {
        response.writeHead(200, { "content-type": "text/html" });
        const timer = setInterval(() => response.write("<p>slow</p>"), 50);
        response.on("close", () => clearInterval(timer));
      });
      const started = Date.now();

      const read = await fetcher({ limits: { totalMs: 300 } })({ address: at(), whose: "mine" });

      expect(read).toEqual({ ok: false, reason: "unreachable" });
      expect(Date.now() - started).toBeLessThan(2000);
    });

    it("spends one time limit on the whole read, not one per page", async () => {
      routes.set("/robots.txt", (_request, response) => {
        setTimeout(() => response.writeHead(404).end(), 200);
      });
      routes.set("/", () => undefined);
      const started = Date.now();

      const read = await fetcher({ limits: { totalMs: 400 } })({ address: at(), whose: "mine" });

      expect(read).toEqual({ ok: false, reason: "unreachable" });
      expect(Date.now() - started).toBeLessThan(1500);
    });
  });

  describe("robots.txt", () => {
    it("does not read a page the site closes to every reader", async () => {
      routes.set("/robots.txt", text("User-agent: *\nDisallow: /"));
      routes.set("/", page("home"));

      const read = await fetcher()({ address: at(), whose: "mine" });

      expect(read).toEqual({ ok: false, reason: "blocks_readers" });
      expect(paths()).toEqual(["/robots.txt"]);
    });

    it("does not read a page the site closes to this reader by name", async () => {
      routes.set(
        "/robots.txt",
        text("User-agent: *\nAllow: /\n\nUser-agent: schmeidebot\nDisallow: /")
      );
      routes.set("/", page("home"));

      expect(await fetcher()({ address: at(), whose: "mine" })).toEqual({
        ok: false,
        reason: "blocks_readers",
      });
    });

    it("skips the linked pages the site closes, and reads the rest", async () => {
      routes.set("/robots.txt", text("User-agent: *\nDisallow: /about"));
      routes.set("/", html(HOME));
      routes.set("/about", page("about"));
      routes.set("/services", page("services"));

      const read = await fetcher()({ address: at(), whose: "mine" });

      expect(read.ok && read.pages.map(({ url }) => url)).toEqual([at(), at("/services")]);
      expect(paths()).not.toContain("/about");
    });

    it("asks the site a redirect leads to for its own rules", async () => {
      routes.set("/", status(302, { location: at("/landing", "other.test") }));
      routes.set("/landing", page("landing"));

      const read = await fetcher()({ address: at(), whose: "mine" });

      expect(read.ok).toBe(true);
      expect(seen.filter(({ path }) => path === "/robots.txt").map(({ host }) => host)).toEqual([
        `shop.test:${ports.site}`,
        `other.test:${ports.site}`,
      ]);
    });

    it("reads the page when the site has no rules, and not when its rules are broken", async () => {
      routes.set("/", page("home"));
      expect((await fetcher()({ address: at(), whose: "mine" })).ok).toBe(true);

      routes.set("/robots.txt", status(503));
      expect(await fetcher()({ address: at(), whose: "mine" })).toEqual({
        ok: false,
        reason: "blocks_readers",
      });
    });

    it("refuses rules that redirect to a private address", async () => {
      routes.set("/robots.txt", status(302, { location: "http://10.0.0.5/robots.txt" }));
      routes.set("/", page("home"));

      expect(await fetcher()({ address: at(), whose: "mine" })).toEqual({
        ok: false,
        reason: "refused_address",
      });
      expect(paths()).toEqual(["/robots.txt"]);
    });
  });

  describe("failure reasons", () => {
    it.each([
      [401, "needs_sign_in"],
      [407, "needs_sign_in"],
      [403, "blocks_readers"],
      [429, "blocks_readers"],
      [404, "unreachable"],
      [410, "unreachable"],
      [500, "unreachable"],
      [503, "unreachable"],
    ])("answers %i with %s", async (code, reason) => {
      routes.set("/", status(code));

      expect(await fetcher()({ address: at(), whose: "mine" })).toEqual({ ok: false, reason });
    });

    it("says a page that is only a sign-in form needs a sign-in", async () => {
      routes.set(
        "/",
        html(`<h1>Sign in</h1><form><input name="email"><input type="password"></form>`)
      );

      expect(await fetcher()({ address: at(), whose: "mine" })).toEqual({
        ok: false,
        reason: "needs_sign_in",
      });
    });

    it("cannot reach a name that does not exist, or a port nothing listens on", async () => {
      expect(await fetcher()({ address: at("/", "nowhere.test"), whose: "mine" })).toEqual({
        ok: false,
        reason: "unreachable",
      });
      expect(await fetcher()({ address: at("/", "127.0.0.1", ports.dead), whose: "mine" })).toEqual(
        { ok: false, reason: "unreachable" }
      );
    });

    it("cannot reach a site that hangs up", async () => {
      routes.set("/", (request) => request.socket.destroy());

      expect(await fetcher()({ address: at(), whose: "mine" })).toEqual({
        ok: false,
        reason: "unreachable",
      });
    });

    it.each([
      ["a file that is not a web page", "application/pdf", "%PDF-1.7"],
      [
        "a page with no words on it",
        "text/html",
        `<div id="app"></div><script src="/app.js"></script>`,
      ],
      ["data", "application/json", `{"secret":"value"}`],
    ])("finds nothing useful in %s", async (_, type, body) => {
      routes.set("/", html(body, { "content-type": type }));

      expect(await fetcher()({ address: at(), whose: "mine" })).toEqual({
        ok: false,
        reason: "nothing_found",
      });
    });
  });
});
