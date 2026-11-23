import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chromium } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  MAX_READING,
  SAMPLE_COLORS,
  cut,
  flatPng,
  openChromium,
  samplePictures,
  testerOptions,
  testerTools,
  within,
  type AppBrowser,
} from "../appBrowser.ts";

describe("within", () => {
  it("answers the address of a path of the app", () => {
    expect(within("http://localhost:8100", "/profile?tab=photos")).toBe(
      "http://localhost:8100/profile?tab=photos"
    );
  });

  it.each(["https://example.com/", "//example.com/x", "http://localhost:8101/"])(
    "refuses %s, which is outside the app",
    (path) => {
      expect(() => within("http://localhost:8100", path)).toThrow(/outside the app/);
    }
  );
});

describe("the sample pictures", () => {
  it("are PNGs of one flat color each, named for it, in a fixed order", () => {
    const pictures = samplePictures(3);

    expect(pictures.map(({ name }) => name)).toEqual(["red.png", "blue.png", "green.png"]);
    for (const { buffer } of pictures)
      expect(buffer.subarray(0, 8)).toEqual(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      );
    expect(flatPng(SAMPLE_COLORS[0][1])).not.toEqual(flatPng(SAMPLE_COLORS[1][1]));
  });
});

describe("cut", () => {
  it("cuts a long page and says it goes on", () => {
    const reading = cut("x".repeat(MAX_READING + 1));

    expect(reading).toHaveLength(
      MAX_READING + "\n(The page goes on. Swipe up to read further.)".length
    );
    expect(cut("short")).toBe("short");
  });
});

// A browser that notes what it was asked, and fails where told to.
const fakeBrowser = (fail = false): AppBrowser & { readonly asked: unknown[][] } => {
  const asked: unknown[][] = [];
  const note =
    (name: string) =>
    async (...args: unknown[]) => {
      asked.push([name, ...args]);
      if (fail) throw new Error("locator.click: Timeout 5000ms exceeded.\nCall log: secret");
      return `${name} done`;
    };
  return {
    asked,
    open: note("open"),
    read: note("read"),
    look: async () => {
      asked.push(["look"]);
      return Buffer.from("jpeg");
    },
    click: note("click"),
    type: note("type"),
    choose: note("choose"),
    press: note("press"),
    swipe: note("swipe"),
    upload: note("upload"),
    resize: note("resize"),
    opened: () => asked.filter(([name]) => name === "open").length,
    close: async () => undefined,
  };
};

describe("the tester's tools", () => {
  const call = (browser: AppBrowser, name: string, args: unknown) => {
    const found = testerTools(browser).find((tool) => tool.name === name);
    if (!found) throw new Error(`no tool ${name}`);
    return (found.handler as (args: unknown, extra: unknown) => Promise<unknown>)(args, {});
  };

  it("are the browser and nothing else", () => {
    const options = testerOptions(fakeBrowser());

    expect(options.tools).toEqual([]);
    expect(options.strictMcpConfig).toBe(true);
    expect(options.allowedTools).toEqual(
      ["open", "read", "look", "click", "type", "choose", "press", "swipe", "upload", "resize"].map(
        (name) => `mcp__app__${name}`
      )
    );
    expect(Object.keys(options.mcpServers ?? {})).toEqual(["app"]);
  });

  it("pass what the tester asked to the browser", async () => {
    const browser = fakeBrowser();

    await call(browser, "open", { path: "/" });
    await call(browser, "click", { role: "button", name: "Next photo" });
    await call(browser, "type", { name: "Email", text: "a@example.com" });
    await call(browser, "swipe", { direction: "left", on: { name: "Photos" } });
    await call(browser, "upload", { count: 3 });

    expect(browser.asked).toEqual([
      ["open", "/"],
      ["click", { role: "button", name: "Next photo" }],
      ["type", { name: "Email" }, "a@example.com"],
      ["swipe", "left", { name: "Photos" }],
      ["upload", 3, undefined],
    ]);
  });

  it("answer a picture as an image", async () => {
    expect(await call(fakeBrowser(), "look", {})).toEqual({
      content: [
        { type: "image", data: Buffer.from("jpeg").toString("base64"), mimeType: "image/jpeg" },
      ],
    });
  });

  it("say what did not work in one line, and go on", async () => {
    expect(await call(fakeBrowser(true), "click", { name: "Next photo" })).toEqual({
      content: [
        { type: "text", text: "That did not work: locator.click: Timeout 5000ms exceeded." },
      ],
      isError: true,
    });
  });
});

// Real Chromium, so only where `make doctor` would pass: `make setup/chromium`.
const installed = existsSync(chromium.executablePath());

// Three photos, a Next button and a marker. With ?stuck, Next does nothing: the carousel a
// builder left half made.
const PAGE = `<!doctype html><title>Horse</title><meta name=viewport content="width=device-width">
<h1>Biscuit</h1>
<img id=photo alt="Photo 1 of 3" width=120 height=120>
<p id=marker>1 of 3</p>
<button id=next>Next photo</button>
<label>Name <input id=name></label>
<input type=file multiple aria-label="Add photos"><p id=files></p>
<a href="https://example.com/away">Elsewhere</a>
<script>
  let at = 1;
  const stuck = location.search.includes("stuck");
  document.querySelector("#next").onclick = () => {
    if (stuck) return;
    at = at % 3 + 1;
    document.querySelector("#photo").alt = "Photo " + at + " of 3";
    document.querySelector("#marker").textContent = at + " of 3";
  };
  document.querySelector("input[type=file]").onchange = (event) =>
    (document.querySelector("#files").textContent =
      [...event.target.files].map((file) => file.name).join(", "));
  fetch("https://example.com/beacon").catch(() => (document.title = "Horse (beacon refused)"));
</script>`;

describe.skipIf(!installed)("openChromium", () => {
  let server: Server;
  let origin: string;
  let browser: AppBrowser | undefined;
  beforeAll(async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(PAGE);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(() => browser?.close());
  afterAll(() => new Promise((resolve) => server.close(resolve)));

  it("reads a page as roles, names and text, and does what a person would", async () => {
    browser = await openChromium(origin);

    const first = await browser.open("/");
    const second = await browser.click({ role: "button", name: "Next photo" });
    await browser.type({ name: "Name" }, "Biscuit the second");
    const uploaded = await browser.upload(2);

    expect(first).toContain("Opened / (the app answered 200).");
    expect(first).toContain("Address: /");
    expect(first).toContain('heading "Biscuit"');
    expect(first).toContain("1 of 3");
    expect(second).toContain("Clicked.");
    expect(second).toContain("2 of 3");
    expect(second).toContain('img "Photo 2 of 3"');
    expect(uploaded).toContain("Chose 2 pictures: red, blue, in that order.");
    expect(uploaded).toContain("red.png, blue.png");
    expect((await browser.look()).subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect(browser.opened()).toBe(1);
  }, 60_000);

  it("shows a carousel that does not move for what it is", async () => {
    browser = await openChromium(origin);

    await browser.open("/?stuck");
    const after = await browser.click({ role: "button", name: "Next photo" });

    expect(after).toContain("1 of 3");
    expect(after).not.toContain("2 of 3");
  }, 60_000);

  it("fails fast on a control that is not there", async () => {
    browser = await openChromium(origin);
    await browser.open("/");

    await expect(browser.click({ role: "button", name: "Previous photo" })).rejects.toThrow(
      /Timeout/
    );
  }, 60_000);

  it("reaches the app and nothing else", async () => {
    browser = await openChromium(origin);

    const page = await browser.open("/");
    await expect(browser.open("https://example.com/")).rejects.toThrow(/outside the app/);
    const away = await browser.click({ role: "link", name: "Elsewhere" });

    // The page's own request to another origin was refused too.
    expect(page).toContain("Title: Horse (beacon refused)");
    expect(away).toContain("That led outside the app");
    expect(away).toContain('heading "Biscuit"');
  }, 60_000);
});
