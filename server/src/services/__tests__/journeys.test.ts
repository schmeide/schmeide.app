import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Step } from "../appBrowser.ts";
import {
  checkHash,
  headerOf,
  idOfJourney,
  journeyFile,
  journeyOf,
  journeyProblems,
  journeysReport,
  passedIn,
} from "../journeys.ts";

const CHECK = {
  id: "F1.2",
  feature: "Photo carousel",
  given: "A profile with three photos.",
  steps: ["Open the profile.", "Tap Next photo."],
  expect: "The second photo shows.",
};
const MARKER = "1a2b3c4d";

const SIGN_UP: readonly Step[] = [
  { do: "open", path: "/" },
  { do: "start", check: "F1.1" },
  { do: "type", target: { name: "Email" }, text: `tester-${MARKER}@example.com` },
  { do: "click", target: { role: "button", name: "Sign up" } },
  { do: "see", target: { role: "heading", name: "Welcome" }, gone: false },
];

describe("journeyOf", () => {
  it("writes what the tester did up to the end of the check, by role and name, with only its own checks of what showed", () => {
    const text = journeyOf(
      CHECK,
      [
        ...SIGN_UP,
        { do: "start", check: "F1.2" },
        { do: "upload", count: 3, nth: 1 },
        { do: "click", target: { role: "button", name: "Next photo", nth: 2 } },
        { do: "swipe", direction: "left", target: { name: "Photos" } },
        { do: "see", target: { role: "img", name: "Photo 2 of 3" }, gone: false },
        { do: "see", target: { name: "Next photo" }, gone: true },
        { do: "start", check: "F1.3" },
        { do: "click", target: { role: "button", name: "Delete" } },
      ],
      MARKER
    );

    expect(text).toBeDefined();
    const lines = (text ?? "").split("\n").map((line) => line.trim());
    expect(headerOf(text ?? "")).toEqual({ id: "F1.2", hash: checkHash(CHECK) });
    expect(lines).toContain('import { expect, test } from "@playwright/test";');
    expect(lines).toContain(
      'test("F1.2 Photo carousel: The second photo shows.", async ({ page, baseURL }) => {'
    );
    const steps = lines.filter((line) => line.startsWith("await ") && line !== "await page");
    expect(steps).toEqual([
      'await page.goto("/");',
      'await page.getByLabel("Email").or(page.getByPlaceholder("Email")).or(page.getByText("Email")).first().fill(`tester-${run}@example.com`);',
      'await page.getByRole("button", { name: "Sign up" }).first().click();',
      "await page.locator('input[type=\"file\"]').nth(0).setInputFiles(pictures.slice(0, 3));",
      'await page.getByRole("button", { name: "Next photo" }).nth(1).click();',
      'await page.getByLabel("Photos").or(page.getByPlaceholder("Photos")).or(page.getByText("Photos")).first().hover();',
      "await page.mouse.wheel(300, 0);",
      "await page.waitForTimeout(600);",
      'await expect(page.getByRole("img", { name: "Photo 2 of 3" }).first()).toBeVisible();',
      'await expect(page.getByLabel("Next photo").or(page.getByPlaceholder("Next photo")).or(page.getByText("Next photo")).first()).toBeHidden();',
    ]);
    // The sign-up check's own "Welcome" and the next check's steps are not this journey's.
    expect(text).not.toContain("Welcome");
    expect(text).not.toContain("Delete");
    expect(text).toContain("const run = ");
    expect(text).toContain('{ name: "green.png", mimeType: "image/png"');
    expect(text).not.toContain("yellow.png");
    expect(text).toContain("// Then: The second photo shows.");
  });

  it("writes no journey for a check the tester never started, or saw nothing in", () => {
    expect(journeyOf(CHECK, SIGN_UP, MARKER)).toBeUndefined();
    expect(
      journeyOf(
        CHECK,
        [...SIGN_UP, { do: "start", check: "F1.2" }, { do: "click", target: { name: "Next" } }],
        MARKER
      )
    ).toBeUndefined();
  });

  it("keeps text that is not the tester's code as it was, quoted safely", () => {
    const text = journeyOf(
      CHECK,
      [
        { do: "start", check: "F1.2" },
        { do: "type", target: { name: "Note" }, text: 'say "hi" `now` ${x}' },
        { do: "see", target: { name: `Hello ${MARKER} \`a\`` }, gone: false },
      ],
      MARKER
    );

    expect(text).toContain('.fill("say \\"hi\\" `now` ${x}");');
    expect(text).toContain("page.getByText(`Hello ${run} \\`a\\``)");
  });
});

describe("the journey files", () => {
  it("are named by check id", () => {
    expect(journeyFile("F3.1")).toBe("F3.1.spec.ts");
    expect(idOfJourney("F3.1.spec.ts")).toBe("F3.1");
    expect(idOfJourney("playwright.config.ts")).toBeUndefined();
    expect(headerOf("// a journey someone wrote by hand")).toBeUndefined();
  });

  it("hash what the check says", () => {
    expect(checkHash(CHECK)).toMatch(/^[0-9a-f]{12}$/);
    expect(checkHash({ ...CHECK, expect: "The third photo shows." })).not.toBe(checkHash(CHECK));
  });
});

describe("passedIn", () => {
  it("answers the files whose every test passed", () => {
    const report = {
      suites: [
        { file: "F1.1.spec.ts", specs: [{ ok: true }] },
        { file: "F1.2.spec.ts", specs: [{ ok: false }] },
        {
          file: "F2.1.spec.ts",
          specs: [],
          suites: [{ file: "F2.1.spec.ts", specs: [{ ok: true }, { ok: false }] }],
        },
        { file: "sub/F3.1.spec.ts", specs: [{ ok: true }] },
      ],
    };

    expect([...passedIn(report)].sort()).toEqual(["F1.1.spec.ts", "F3.1.spec.ts"]);
    expect(passedIn(null).size).toBe(0);
    expect(passedIn({ errors: ["No tests found"] }).size).toBe(0);
  });
});

describe("journeyProblems", () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      cwd,
      // The developer's own hooks and settings stay out of the fixture.
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    })
      .toString()
      .trim();
  const repo = () => {
    const dir = mkdtempSync(join(tmpdir(), "journeys-"));
    mkdirSync(join(dir, "journeys"));
    writeFileSync(join(dir, "journeys", "playwright.config.ts"), "export default {};\n");
    writeFileSync(join(dir, "journeys", "F1.1.spec.ts"), "// check F1.1 aaaaaaaaaaaa\n");
    writeFileSync(join(dir, "journeys", "F1.2.spec.ts"), "// check F1.2 bbbbbbbbbbbb\n");
    git(dir, "init", "-q");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "first");
    return { dir, base: git(dir, "rev-parse", "HEAD") };
  };

  it("finds every change the build made under journeys/, committed or not", async () => {
    const { dir, base } = repo();
    writeFileSync(join(dir, "journeys", "F1.1.spec.ts"), "test.skip();\n");
    rmSync(join(dir, "journeys", "F1.2.spec.ts"));
    writeFileSync(join(dir, "journeys", "F9.1.spec.ts"), "// mine\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "builder");
    writeFileSync(join(dir, "journeys", "notes.ts"), "\n");
    writeFileSync(join(dir, "app.ts"), "\n");

    const problems = await journeyProblems(dir, base);

    expect(problems).toEqual([
      `journeys/F1.1.spec.ts was changed. Put it back with \`git checkout ${base} -- journeys/F1.1.spec.ts\`.`,
      `journeys/F1.2.spec.ts was deleted. Put it back with \`git checkout ${base} -- journeys/F1.2.spec.ts\`.`,
      "journeys/F9.1.spec.ts was added. Delete it.",
      "journeys/notes.ts was added. Delete it.",
    ]);
    expect(journeysReport(problems)).toContain("a build may not change them");
    rmSync(dir, { recursive: true });
  });

  it("finds nothing when only the rest of the app changed, and reads from the first commit without a base", async () => {
    const { dir } = repo();
    writeFileSync(join(dir, "app.ts"), "\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "builder");

    expect(await journeyProblems(dir)).toEqual([]);
    writeFileSync(join(dir, "journeys", "F1.1.spec.ts"), "\n");
    expect(await journeyProblems(dir)).toHaveLength(1);
    rmSync(dir, { recursive: true });
  });
});
