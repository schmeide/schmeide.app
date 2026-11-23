// The journeys (#358): each acceptance check the tester saw work, kept in the app as a Playwright
// test, `journeys/<check id>.spec.ts`. The server writes it from the steps the tester's browser
// recorded (services/appBrowser.ts), never from code a model wrote, so a journey only does what
// worked in the running app and finds everything by role and name, as the tester did. Every later
// build runs them against staging first, and the tester follows only the checks without a journey
// that passes. Only the server writes here: a build that changes journeys/ is refused.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { z } from "zod";
import {
  PHONE,
  SAMPLE_COLORS,
  SWIPE_SETTLE_MS,
  WHEEL,
  flatPng,
  viewportOf,
  type Step,
  type Target,
} from "./appBrowser.ts";
import { listReport } from "./buildChecks.ts";

export const JOURNEYS_DIR = "journeys";
// The template's Makefile can run them (schmeide/template#102).
export const JOURNEYS_TARGET = /^journeys:/m;

export const journeyFile = (id: string): string => `${id}.spec.ts`;
export const idOfJourney = (file: string): string | undefined =>
  /^(F\d+\.\d+)\.spec\.ts$/.exec(file)?.[1];

type Written = {
  readonly id: string;
  readonly given: string;
  readonly steps: readonly string[];
  readonly expect: string;
};

// What a journey was written from. A check whose words differ from its journey's is followed
// again; ids are never reused (services/acceptance.ts), so this only guards against a plan edited
// by hand.
export const checkHash = ({ given, steps, expect }: Written): string =>
  createHash("sha256")
    .update(JSON.stringify([given, steps, expect]))
    .digest("hex")
    .slice(0, 12);

const HEADER = /^\/\/ check (F\d+\.\d+) ([0-9a-f]{12})$/m;

// The check a journey's text says it was written from.
export const headerOf = (
  text: string
): { readonly id: string; readonly hash: string } | undefined => {
  const match = HEADER.exec(text);
  return match ? { id: match[1], hash: match[2] } : undefined;
};

// A string as TypeScript source. Where the tester put its code (`marker`) to make something
// unique, such as its email, the journey puts a code of its own run, so it can sign up again.
const literal = (text: string, marker: string): string =>
  marker && text.includes(marker)
    ? `\`${text
        .split(marker)
        .map((part) => part.replace(/[\\`]/g, "\\$&").replace(/\$\{/g, "\\${"))
        .join("${run}")}\``
    : JSON.stringify(text);

// The same locator the tester's browser used for `target` (openChromium's find).
const locator = ({ role, name, nth }: Target, marker: string): string => {
  const text = literal(name, marker);
  const found = role
    ? `page.getByRole(${JSON.stringify(role)}, { name: ${text} })`
    : `page.getByLabel(${text}).or(page.getByPlaceholder(${text})).or(page.getByText(${text}))`;
  return `${found}.${nth ? `nth(${nth - 1})` : "first()"}`;
};

const lineOf = (step: Exclude<Step, { do: "start" }>, marker: string): readonly string[] => {
  switch (step.do) {
    case "open":
      return [`await page.goto(${JSON.stringify(step.path)});`];
    case "click":
      return [`await ${locator(step.target, marker)}.click();`];
    case "type":
      return [`await ${locator(step.target, marker)}.fill(${literal(step.text, marker)});`];
    case "choose":
      return [
        `await ${locator(step.target, marker)}.selectOption({ label: ${JSON.stringify(step.option)} });`,
      ];
    case "press":
      return [`await page.keyboard.press(${JSON.stringify(step.key)});`];
    case "swipe":
      return [
        step.target
          ? `await ${locator(step.target, marker)}.hover();`
          : `await page.mouse.move(${PHONE.width / 2}, ${PHONE.height / 2});`,
        `await page.mouse.wheel(${WHEEL[step.direction].join(", ")});`,
        `await page.waitForTimeout(${SWIPE_SETTLE_MS});`,
      ];
    case "upload":
      return [
        `await page.locator('input[type="file"]').nth(${step.nth - 1}).setInputFiles(pictures.slice(0, ${step.count}));`,
      ];
    case "resize":
      return [`await page.setViewportSize(${JSON.stringify(viewportOf(step.width))});`];
    case "see":
      return [
        `await expect(${locator(step.target, marker)}).${step.gone ? "toBeHidden" : "toBeVisible"}();`,
      ];
  }
};

// The journey of one check, from what the tester did in one browser: everything it did up to the
// end of that check, so what "Given" needs is made again, and only that check's `see` steps as
// what must hold. Undefined when the tester never said it started the check, or saw nothing in
// it: a journey that asserts nothing would pass whatever the app did.
export const journeyOf = (
  check: Written & { readonly feature: string },
  steps: readonly Step[],
  marker: string
): string | undefined => {
  const starts = steps.flatMap((step, index) => (step.do === "start" ? [index] : []));
  const begin = starts
    .filter((index) => {
      const step = steps[index];
      return step.do === "start" && step.check === check.id;
    })
    .at(-1);
  if (begin === undefined) return undefined;
  const end = starts.find((index) => index > begin) ?? steps.length;
  const done = steps
    .slice(0, end)
    .flatMap((step, index) =>
      step.do === "start" || (step.do === "see" && index < begin) ? [] : [step]
    );
  if (!steps.slice(begin, end).some((step) => step.do === "see")) return undefined;
  const uploads = Math.max(0, ...done.map((step) => (step.do === "upload" ? step.count : 0)));
  const mine = (text: string) => Boolean(marker) && text.includes(marker);
  const unique = done.some(
    (step) =>
      ("text" in step && mine(step.text)) ||
      ("target" in step && step.target && mine(step.target.name))
  );
  return [
    `// Schmeide's journey for ${check.id} of ${JSON.stringify(check.feature)}, written from what its tester did in the app.`,
    "// Do not edit: Schmeide refuses a build that changes journeys/, and its tester rewrites a journey that no longer fits.",
    `// check ${check.id} ${checkHash(check)}`,
    'import { expect, test } from "@playwright/test";',
    "",
    ...(unique
      ? [
          "// The tester's code in what had to be unique, such as its email, made new for each run.",
          'const run = Math.random().toString(36).slice(2).padEnd(8, "0").slice(0, 8);',
          "",
        ]
      : []),
    ...(uploads > 0
      ? [
          "// The tester's sample pictures, one flat color each, in its order.",
          "const pictures = [",
          ...SAMPLE_COLORS.slice(0, uploads).map(
            ([color, rgb]) =>
              `  { name: "${color}.png", mimeType: "image/png", buffer: Buffer.from("${flatPng(rgb).toString("base64")}", "base64") },`
          ),
          "];",
          "",
        ]
      : []),
    `test(${JSON.stringify(`${check.id} ${check.feature}: ${check.expect}`)}, async ({ page, baseURL }) => {`,
    "  // Like the tester's browser: the app and nothing else, and every message box answered yes.",
    '  const home = new URL(baseURL ?? "").origin;',
    "  await page",
    "    .context()",
    '    .route("**/*", (route) => (new URL(route.request().url()).origin === home ? route.continue() : route.abort()));',
    '  page.on("dialog", (dialog) => void dialog.accept());',
    `  // Given: ${check.given.replace(/\n/g, " ")}`,
    ...check.steps.map((step, index) => `  // ${index + 1}. ${step.replace(/\n/g, " ")}`),
    `  // Then: ${check.expect.replace(/\n/g, " ")}`,
    ...done.flatMap((step) => lineOf(step, marker)).map((line) => `  ${line}`),
    "});",
    "",
  ].join("\n");
};

// What Playwright's JSON reporter writes, as far as it is read here: every spec under its file.
type ReportSuite = {
  readonly file?: string;
  readonly specs?: readonly { readonly ok?: boolean }[];
  readonly suites?: readonly ReportSuite[];
};
const suiteSchema: z.ZodType<ReportSuite> = z.lazy(() =>
  z.object({
    file: z.string().optional(),
    specs: z.array(z.object({ ok: z.boolean().optional() })).optional(),
    suites: z.array(suiteSchema).optional(),
  })
);
const reportSchema = z.object({ suites: z.array(suiteSchema) });

// The journeys a run passed, by file name: every test in the file ran and passed. None when the
// report is not one.
export const passedIn = (report: unknown): ReadonlySet<string> => {
  const parsed = reportSchema.safeParse(report);
  if (!parsed.success) return new Set();
  const ok = new Map<string, boolean>();
  const walk = (suite: ReportSuite) => {
    if (suite.file)
      for (const spec of suite.specs ?? [])
        ok.set(suite.file, (ok.get(suite.file) ?? true) && spec.ok === true);
    suite.suites?.forEach(walk);
  };
  parsed.data.suites.forEach(walk);
  return new Set(
    [...ok].flatMap(([file, passed]) => (passed ? [file.split("/").at(-1) ?? file] : []))
  );
};

const git = async (cwd: string, ...args: string[]): Promise<readonly string[]> =>
  (await promisify(execFile)("git", args, { cwd, maxBuffer: 16 << 20 })).stdout
    .split("\n")
    .filter(Boolean);

// What the build changed under journeys/ since `base` (the first commit when there is none),
// committed or not. Nothing when git cannot tell.
export const journeyProblems = async (
  workspace: string,
  base?: string
): Promise<readonly string[]> => {
  try {
    const from = base ?? (await git(workspace, "rev-list", "--max-parents=0", "HEAD"))[0];
    const changed = (
      await git(workspace, "diff", "--name-status", "--no-renames", from, "--", `${JOURNEYS_DIR}/`)
    ).map((line) => line.split("\t") as [string, string]);
    const added = await git(
      workspace,
      "ls-files",
      "--others",
      "--exclude-standard",
      "--",
      `${JOURNEYS_DIR}/`
    );
    return [
      ...changed.map(([status, path]) =>
        status === "A"
          ? `${path} was added. Delete it.`
          : `${path} was ${status === "D" ? "deleted" : "changed"}. Put it back with \`git checkout ${from} -- ${path}\`.`
      ),
      ...added.map((path) => `${path} was added. Delete it.`),
    ];
  } catch {
    return [];
  }
};

export const CHECKING_JOURNEYS = "Checking that the journeys are as the tester left them";
export const JOURNEYS_UNCHANGED = "The journeys are as the tester left them";
export const journeysChanged = (count: number): string =>
  `The build changed the journeys (${count} ${count === 1 ? "file" : "files"})`;

export const journeysReport = (problems: readonly string[]): string =>
  listReport(
    "journeys/ holds the journeys Schmeide's tester wrote, and a build may not change them. Undo these changes and commit:",
    problems
  );

// What a check whose journey passed is kept with: it worked without the tester following it.
export const JOURNEY_PASSED =
  "Its journey passed on staging, so the tester did not follow it again.";
