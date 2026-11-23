// The tester's browser (#356): headless Chromium, from Playwright, on one built app. It reaches
// that app's address and nothing else, and the tester drives it through the few tools below: what
// a person with a phone can do, and no more. The tester has no other tool.
import { deflateSync } from "node:zlib";
import { createSdkMcpServer, tool, type Options } from "@anthropic-ai/claude-agent-sdk";
import { chromium, type BrowserContext, type Locator, type Page } from "playwright";
import { z } from "zod";

// The width the mobile-first skill designs for, and a computer.
export const PHONE = { width: 360, height: 740 } as const;
export const WIDTHS = [360, 768, 1280] as const;
// Short, so a control that is not there is an answer in seconds, not a stall.
export const ACTION_TIMEOUT_MS = 5000;
const LOAD_TIMEOUT_MS = 20_000;
// What one reading of a page may hold. A longer page is cut and says so.
export const MAX_READING = 8000;

// A control or a piece of text on the page, found the way a person finds it: by what it is and
// what it says. Without a role, anything labeled or reading `name`.
export type Target = {
  readonly role?: string;
  readonly name: string;
  // Which one, from 1, when several match.
  readonly nth?: number;
};

export const DIRECTIONS = ["left", "right", "up", "down"] as const;
export type Direction = (typeof DIRECTIONS)[number];

// The sample pictures the tester can put into an app: each one flat color, so it can tell which
// picture a screen shows.
export const SAMPLE_COLORS = [
  ["red", [220, 38, 38]],
  ["blue", [37, 99, 235]],
  ["green", [22, 163, 74]],
  ["yellow", [234, 179, 8]],
  ["purple", [147, 51, 234]],
] as const;

// What the tester did that worked, in order, so the server can write it down as a journey
// (services/journeys.ts). `start` marks where a check begins; `see` is what it saw, or saw gone.
export type Step =
  | { readonly do: "start"; readonly check: string }
  | { readonly do: "open"; readonly path: string }
  | { readonly do: "click"; readonly target: Target }
  | { readonly do: "type"; readonly target: Target; readonly text: string }
  | { readonly do: "choose"; readonly target: Target; readonly option: string }
  | { readonly do: "press"; readonly key: string }
  | { readonly do: "swipe"; readonly direction: Direction; readonly target?: Target }
  | { readonly do: "upload"; readonly count: number; readonly nth: number }
  | { readonly do: "resize"; readonly width: number }
  | { readonly do: "see"; readonly target: Target; readonly gone: boolean };

export type AppBrowser = {
  // Goes to a path of the app and answers what the page reads.
  open(path: string): Promise<string>;
  // The page as roles, names and text, under its address and title.
  read(): Promise<string>;
  // A picture of what the screen shows, as a JPEG.
  look(): Promise<Buffer>;
  click(target: Target): Promise<string>;
  type(target: Target, text: string): Promise<string>;
  choose(target: Target, option: string): Promise<string>;
  press(key: string): Promise<string>;
  // Swipes the page, or the thing named, as a finger would.
  swipe(direction: Direction, target?: Target): Promise<string>;
  // Puts the first `count` sample pictures into the page's `nth` file control.
  upload(count: number, nth?: number): Promise<string>;
  resize(width: number): Promise<string>;
  // Marks the start of a check, by its id.
  start(check: string): Promise<string>;
  // Waits for the thing named to show, or with `gone` to be gone, and fails when it does not.
  see(target: Target, gone?: boolean): Promise<string>;
  // Everything done so far that worked, in order.
  steps(): readonly Step[];
  // How many times a page of the app was opened: a verdict given without opening the app can be
  // told from one that was earned.
  opened(): number;
  close(): Promise<void>;
};

// Opens a browser on the app at `origin`. Throws when Chromium is missing.
export type OpenBrowser = (origin: string) => Promise<AppBrowser>;

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (bytes: Buffer): number => {
  let c = 0xffffffff;
  for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type: string, data: Buffer): Buffer => {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
};

// A PNG of one flat color, `size` px square.
export const flatPng = ([red, green, blue]: readonly [number, number, number], size = 240) => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([
    Buffer.from([0]),
    Buffer.alloc(size * 3, Buffer.from([red, green, blue])),
  ]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: size }, () => row)))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
};

export const samplePictures = (count: number) =>
  SAMPLE_COLORS.slice(0, count).map(([color, rgb]) => ({
    name: `${color}.png`,
    mimeType: "image/png",
    buffer: flatPng(rgb),
  }));

// The address a path of the app is at. Throws for anything that would leave the app.
export const within = (origin: string, path: string): string => {
  const url = new URL(path, origin);
  if (url.origin !== new URL(origin).origin)
    throw new Error(`${path} is outside the app. Give a path such as /profile.`);
  return url.href;
};

export const cut = (text: string, max = MAX_READING): string =>
  text.length > max ? `${text.slice(0, max)}\n(The page goes on. Swipe up to read further.)` : text;

// The screen at a width the tester may choose.
export const viewportOf = (width: number) => ({
  width,
  height: width < 700 ? PHONE.height : 800,
});
// How long a swipe is given to settle.
export const SWIPE_SETTLE_MS = 600;

export const WHEEL: Readonly<Record<Direction, readonly [number, number]>> = {
  // A finger moving left brings the next thing in from the right.
  left: [300, 0],
  right: [-300, 0],
  up: [0, 500],
  down: [0, -500],
};

// `origin`'s app in headless Chromium at phone width. Every request to another origin is refused,
// so nothing the app shows or links to can send the tester anywhere else.
export const openChromium: OpenBrowser = async (origin) => {
  const browser = await chromium.launch({ timeout: LOAD_TIMEOUT_MS });
  const home = new URL(origin).origin;
  const said: string[] = [];
  let context: BrowserContext;
  let page: Page;
  try {
    context = await browser.newContext({
      viewport: PHONE,
      hasTouch: true,
      acceptDownloads: false,
      serviceWorkers: "block",
    });
    context.setDefaultTimeout(ACTION_TIMEOUT_MS);
    context.setDefaultNavigationTimeout(LOAD_TIMEOUT_MS);
    await context.route("**/*", (route) =>
      new URL(route.request().url()).origin === home ? route.continue() : route.abort()
    );
    await context.routeWebSocket(/.*/, (socket) => {
      if (new URL(socket.url()).origin.replace(/^ws/, "http") === home) socket.connectToServer();
      else void socket.close();
    });
    const watch = (opened: Page) => {
      page = opened;
      // A message box is answered yes, and what it said is part of the next reading.
      opened.on("dialog", (dialog) => {
        said.push(`A message box said: ${dialog.message()}`);
        void dialog.accept().catch(() => undefined);
      });
    };
    // A link that opens a new tab: the tester follows it, as a person's phone would.
    context.on("page", watch);
    page = await context.newPage();
  } catch (error) {
    await browser.close();
    throw error;
  }

  const find = ({ role, name, nth }: Target): Locator => {
    const found = role
      ? page.getByRole(role as Parameters<Page["getByRole"]>[0], { name })
      : page.getByLabel(name).or(page.getByPlaceholder(name)).or(page.getByText(name));
    return nth ? found.nth(nth - 1) : found.first();
  };
  const read = async () => {
    await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => undefined);
    const heard = said.splice(0).join("\n");
    const body = await page.locator("body").ariaSnapshot();
    return cut(
      `Address: ${new URL(page.url()).pathname}${new URL(page.url()).search}\nTitle: ${await page.title()}\n${heard ? `${heard}\n` : ""}\n${body || "(The page is empty.)"}`
    );
  };
  const inside = () => page.url().startsWith(`${home}/`);
  // A link out of the app is refused, which leaves the browser on an error page: go back to the
  // app and say so, so the tester does not read the error as the app's.
  const then = async (did: string) => {
    if (inside()) return `${did} The page now:\n\n${await read()}`;
    await page.goBack({ waitUntil: "load" }).catch(() => undefined);
    if (!inside()) await page.goto(`${home}/`, { waitUntil: "load" });
    return `${did} That led outside the app, where you cannot go, so you are back in the app. The page now:\n\n${await read()}`;
  };

  let opened = 0;
  const steps: Step[] = [];
  // A step is kept only once it worked.
  const did = (step: Step) => steps.push(step);
  return {
    opened: () => opened,
    steps: () => [...steps],
    async open(path) {
      opened++;
      const response = await page.goto(within(home, path), { waitUntil: "load" });
      did({ do: "open", path });
      return then(`Opened ${path} (the app answered ${response?.status() ?? "nothing"}).`);
    },
    read,
    look: () => page.screenshot({ type: "jpeg", quality: 60 }),
    async click(target) {
      await find(target).click();
      did({ do: "click", target });
      return then("Clicked.");
    },
    async type(target, text) {
      await find(target).fill(text);
      did({ do: "type", target, text });
      return then("Typed.");
    },
    async choose(target, option) {
      await find(target).selectOption({ label: option });
      did({ do: "choose", target, option });
      return then("Chosen.");
    },
    async press(key) {
      await page.keyboard.press(key);
      did({ do: "press", key });
      return then(`Pressed ${key}.`);
    },
    async swipe(direction, target) {
      if (target) await find(target).hover();
      else await page.mouse.move(PHONE.width / 2, PHONE.height / 2);
      await page.mouse.wheel(...WHEEL[direction]);
      await page.waitForTimeout(SWIPE_SETTLE_MS);
      did({ do: "swipe", direction, ...(target && { target }) });
      return then(`Swiped ${direction}.`);
    },
    async upload(count, nth = 1) {
      await page
        .locator('input[type="file"]')
        .nth(nth - 1)
        .setInputFiles(samplePictures(count));
      did({ do: "upload", count, nth });
      return then(
        `Chose ${count} ${count === 1 ? "picture" : "pictures"}: ${SAMPLE_COLORS.slice(0, count)
          .map(([color]) => color)
          .join(", ")}, in that order.`
      );
    },
    async resize(width) {
      await page.setViewportSize(viewportOf(width));
      did({ do: "resize", width });
      return then(`The screen is now ${width}px wide.`);
    },
    async start(check) {
      did({ do: "start", check });
      return `Starting ${check}.`;
    },
    async see(target, gone = false) {
      await find(target).waitFor({ state: gone ? "hidden" : "visible" });
      did({ do: "see", target, gone });
      return gone ? "It is not on the page." : "It is on the page.";
    },
    close: () => browser.close(),
  };
};

const targetShape = {
  role: z
    .string()
    .optional()
    .describe(
      'What it is, as the page reading names it: "button", "link", "textbox", "checkbox", "img", "heading". Leave out to find a field by its label, or anything by its text.'
    ),
  name: z.string().min(1).describe("What it says: its label or its text, as the page reads."),
  nth: z.number().int().min(1).optional().describe("Which one, from 1, when several match."),
};

export const TESTER_SERVER = "app";

// What a tool answers when the browser could not do it: the tester reads why and tries another
// way, or reports the check broken. The app's own words stay out of the first line.
const failed = (error: unknown) => ({
  content: [
    {
      type: "text" as const,
      text: `That did not work: ${(error instanceof Error ? error.message : String(error)).split("\n")[0].slice(0, 300)}`,
    },
  ],
  isError: true,
});

// The tester's tools over one browser.
export const testerTools = (browser: AppBrowser) => {
  const text = async (work: () => Promise<string>) => {
    try {
      return { content: [{ type: "text" as const, text: await work() }] };
    } catch (error) {
      return failed(error);
    }
  };
  return [
    tool(
      "open",
      "Go to a page of the app by its path, such as / or /profile. Answers what the page reads.",
      { path: z.string().min(1).describe("A path inside the app, starting with /.") },
      ({ path }) => text(() => browser.open(path))
    ),
    tool(
      "read",
      "Read the page as it is now: every heading, control and piece of text, with its role and name.",
      {},
      () => text(() => browser.read())
    ),
    tool(
      "look",
      "See a picture of what the screen shows now. Use it when a check is about what is visible: which picture shows, whether something is cut off or hidden.",
      {},
      async () => {
        try {
          const picture = await browser.look();
          return {
            content: [
              { type: "image" as const, data: picture.toString("base64"), mimeType: "image/jpeg" },
            ],
          };
        } catch (error) {
          return failed(error);
        }
      }
    ),
    tool("click", "Tap a button, a link or anything else on the page.", targetShape, (target) =>
      text(() => browser.click(target))
    ),
    tool(
      "type",
      "Type into a field, replacing what it holds.",
      { ...targetShape, text: z.string().describe("What to type.") },
      ({ text: typed, ...target }) => text(() => browser.type(target, typed))
    ),
    tool(
      "choose",
      "Pick an option from a drop-down list.",
      { ...targetShape, option: z.string().min(1).describe("The option, as it reads.") },
      ({ option, ...target }) => text(() => browser.choose(target, option))
    ),
    tool(
      "press",
      "Press a key, such as Enter, Escape, Tab, ArrowRight or ArrowLeft.",
      { key: z.string().min(1).max(20) },
      ({ key }) => text(() => browser.press(key))
    ),
    tool(
      "swipe",
      "Swipe with a finger. left brings in what is to the right, as on a row of photos; up moves down the page. Name a thing to swipe on it, or leave it out to swipe the page.",
      {
        direction: z.enum(DIRECTIONS),
        on: z.strictObject(targetShape).optional().describe("The thing to swipe on."),
      },
      ({ direction, on }) => text(() => browser.swipe(direction, on))
    ),
    tool(
      "upload",
      `Put sample pictures into a "choose a file" control on the page. Each is one flat color, in this order: ${SAMPLE_COLORS.map(([color]) => color).join(", ")}. So after uploading 3, the first is red, the second blue and the third green.`,
      {
        count: z.number().int().min(1).max(SAMPLE_COLORS.length).describe("How many pictures."),
        nth: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Which file control, from 1, when the page has several."),
      },
      ({ count, nth }) => text(() => browser.upload(count, nth))
    ),
    tool(
      "start",
      "Say which check you are starting, by its id, before you make what it needs.",
      { check: z.string().min(1).max(16).describe("The check's id, such as F1.2.") },
      ({ check }) => text(() => browser.start(check))
    ),
    tool(
      "see",
      'Confirm that something is on the page now, found by what it is and what it says, or with gone that it is not. Use it for each thing "Then" says before you answer works.',
      {
        ...targetShape,
        gone: z.boolean().optional().describe("True to confirm it is not on the page."),
      },
      ({ gone, ...target }) => text(() => browser.see(target, gone))
    ),
    tool(
      "resize",
      "Change how wide the screen is. It starts at 360, a phone.",
      { width: z.union(WIDTHS.map((width) => z.literal(width))) },
      ({ width }) => text(() => browser.resize(width))
    ),
  ];
};

// The options that give a run this browser and no other tool.
export const testerOptions = (browser: AppBrowser): Options => {
  const tools = testerTools(browser);
  return {
    tools: [],
    // Only the browser: no server from this machine's or the login's own settings.
    strictMcpConfig: true,
    mcpServers: { [TESTER_SERVER]: createSdkMcpServer({ name: TESTER_SERVER, tools }) },
    allowedTools: tools.map(({ name }) => `mcp__${TESTER_SERVER}__${name}`),
  };
};
