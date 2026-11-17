import { describe, expect, it } from "vitest";
import { hexColor, reducePage } from "../htmlText.ts";
import { robotsAllows } from "../robots.ts";

const PAGE = `<!doctype html>
<html>
  <head>
    <title>Acme &amp; Sons   Bakery</title>
    <meta name="description" content="Fresh bread, baked every morning.">
    <meta property="og:site_name" content="Acme Bakery">
    <meta property="og:image" content="/img/cover.jpg">
    <meta name="theme-color" content="#C0392B">
    <link rel="icon" href="/favicon.png">
    <style>body { color: #222; background: #fafafa } a { color: #c0392b } .x { color: #222222 }</style>
    <script>document.write("<h1>Injected by a script</h1>")</script>
  </head>
  <body>
    <!-- <h1>Inside a comment</h1> -->
    <header><img class="site-logo" src="logo.svg" alt="Acme logo"><nav>
      <a href="/about">About us</a> <a href='/order?x=1'>Order <b>online</b></a>
      <a href="https://elsewhere.example/">Partner</a> <a href="mailto:a@b.example">Mail</a>
    </nav></header>
    <h1>Bread, <em>baked</em> daily</h1>
    <p>We deliver on weekdays.<br>Call us &#38; ask &lt;anything&gt;.</p>
    <noscript><p>Turn on scripts</p></noscript>
    <svg><text>Vector words</text></svg>
    <h2>Opening hours</h2>
    <div style="color:#0A0;background:#00aa00">Mon to Fri</div>
    <textarea>typed text</textarea>
  </body>
</html>`;

describe("reducePage", () => {
  const { digest, links, asksForPassword } = reducePage(PAGE, "https://acme.example/", true);

  it("keeps the title, the description, the headings, and the words a visitor sees", () => {
    expect(digest.title).toBe("Acme & Sons Bakery");
    expect(digest.description).toBe("Fresh bread, baked every morning.");
    expect(digest.headings).toEqual(["Bread, baked daily", "Opening hours"]);
    expect(digest.text).toContain("We deliver on weekdays.\nCall us & ask <anything>.");
    expect(digest.text).toContain("Mon to Fri");
    expect(digest.text).toContain("Acme logo");
    expect(asksForPassword).toBe(false);
  });

  it("drops scripts, styles, comments, and other text nobody sees", () => {
    const everything = JSON.stringify(digest);
    for (const hidden of [
      "Injected by a script",
      "Inside a comment",
      "Turn on scripts",
      "Vector words",
      "typed text",
      "background",
    ])
      expect(everything).not.toContain(hidden);
  });

  it("lists link texts, and resolves web links against the page", () => {
    expect(digest.linkTexts).toEqual(["About us", "Order online", "Partner"]);
    expect(links).toEqual([
      { href: "https://acme.example/about", text: "About us" },
      { href: "https://acme.example/order?x=1", text: "Order online" },
      { href: "https://elsewhere.example/", text: "Partner" },
    ]);
  });

  it("collects the site name, logo candidates, and colors for a person's own site", () => {
    expect(digest.brand).toEqual({
      siteName: "Acme Bakery",
      colors: ["#c0392b", "#222222", "#00aa00", "#fafafa"],
      logos: [
        "https://acme.example/logo.svg",
        "https://acme.example/favicon.png",
        "https://acme.example/img/cover.jpg",
      ],
    });
  });

  it("collects none of that for someone else's site", () => {
    const others = reducePage(PAGE, "https://acme.example/", false).digest;
    expect(others.brand).toBeUndefined();
    expect(JSON.stringify(others)).not.toContain("logo.svg");
    expect(JSON.stringify(others)).not.toContain("#c0392b");
  });

  it("notices a page that asks for a password", () => {
    const page = `<form><input type="text" name="user"><input type=PASSWORD name="p"></form>`;
    expect(reducePage(page, "https://acme.example/", false).asksForPassword).toBe(true);
  });

  it("survives broken and hostile markup, and bounds what it keeps", () => {
    const hostile = [
      "<h1>Unclosed heading",
      "<a href='/x'>Unclosed link",
      "<script>never closed",
      "<p>after</p>",
      `<a href="javascript:alert(1)">Run</a>`,
      "<".repeat(5000),
      `<div title="${">".repeat(50)}">kept</div>`,
    ].join("\n");
    const reduced = reducePage(hostile, "https://acme.example/", true);
    expect(reduced.digest.text).toContain("Unclosed heading");
    expect(reduced.links.every(({ href }) => href.startsWith("https://"))).toBe(true);
    expect(
      reducePage("<p>word </p>".repeat(20_000), "https://acme.example/", true).digest.text
    ).toHaveLength(6000);
    expect(
      reducePage("<h2>Heading</h2>".repeat(500), "https://acme.example/", true).digest.headings
    ).toEqual(["Heading"]);
  });

  it("stays quick on a megabyte of unclosed tags", () => {
    const started = Date.now();
    reducePage("<script".repeat(150_000), "https://acme.example/", true);
    reducePage("<a href=".repeat(125_000), "https://acme.example/", true);
    reducePage("<!--".repeat(250_000), "https://acme.example/", true);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("hexColor", () => {
  it("writes a color the long, lowercase way, and refuses anything else", () => {
    expect(hexColor("#ABC")).toBe("#aabbcc");
    expect(hexColor(" #C0392B ")).toBe("#c0392b");
    expect(hexColor("red")).toBeNull();
    expect(hexColor("#12345")).toBeNull();
    expect(hexColor("url(https://evil.example)")).toBeNull();
  });
});

describe("robotsAllows", () => {
  const ROBOTS = `# comment
User-agent: *
Disallow: /private/
Disallow: /*.pdf$
Allow: /private/open/

User-agent: OtherBot
User-agent: schmeidebot
Disallow: /only-for-us/
`;

  it("allows everything when the file is empty or says nothing for the path", () => {
    expect(robotsAllows("", "SchmeideBot", "/")).toBe(true);
    expect(robotsAllows("User-agent: *\nDisallow:", "SchmeideBot", "/anything")).toBe(true);
    expect(robotsAllows("Disallow: /", "SchmeideBot", "/")).toBe(true);
  });

  it("follows the rules for every reader when none are written for ours", () => {
    const rules = "User-agent: *\nDisallow: /private/\nDisallow: /*.pdf$\nAllow: /private/open/";
    expect(robotsAllows(rules, "SchmeideBot", "/")).toBe(true);
    expect(robotsAllows(rules, "SchmeideBot", "/private/notes")).toBe(false);
    expect(robotsAllows(rules, "SchmeideBot", "/private/open/day")).toBe(true);
    expect(robotsAllows(rules, "SchmeideBot", "/menu.pdf")).toBe(false);
    expect(robotsAllows(rules, "SchmeideBot", "/menu.pdf?download=1")).toBe(true);
    expect(robotsAllows("User-agent: *\nDisallow: /", "SchmeideBot", "/")).toBe(false);
  });

  it("follows the rules written for our reader instead, whatever its capitals", () => {
    expect(robotsAllows(ROBOTS, "SchmeideBot", "/private/notes")).toBe(true);
    expect(robotsAllows(ROBOTS, "SchmeideBot", "/only-for-us/x")).toBe(false);
    expect(robotsAllows(ROBOTS, "SomeoneElse", "/only-for-us/x")).toBe(true);
    expect(
      robotsAllows(
        "User-agent: *\nAllow: /\n\nUser-agent: SchmeideBot\nDisallow: /",
        "SchmeideBot",
        "/"
      )
    ).toBe(false);
  });

  it("lets the longer rule win, and allow win a tie", () => {
    const rules = "User-agent: *\nDisallow: /shop\nAllow: /shop/open\nDisallow: /tie\nAllow: /tie";
    expect(robotsAllows(rules, "SchmeideBot", "/shop/closed")).toBe(false);
    expect(robotsAllows(rules, "SchmeideBot", "/shop/open/now")).toBe(true);
    expect(robotsAllows(rules, "SchmeideBot", "/tie")).toBe(true);
  });

  it("stays quick on a file made to be slow", () => {
    const started = Date.now();
    const rules = `User-agent: *\n${`Disallow: /${"*a".repeat(200)}$\n`.repeat(400)}`;
    expect(robotsAllows(rules, "SchmeideBot", `/${"a".repeat(5000)}b`)).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
