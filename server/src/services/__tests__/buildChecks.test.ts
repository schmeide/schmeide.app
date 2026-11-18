import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildProblems, entropy, outboundProblems, secretProblems } from "../buildChecks.ts";

// Built at run time so this repository never holds a key-shaped literal.
const AWS_KEY = ["AKIA", "Z7Q2", "M4XK", "P9RW", "T3LB"].join("");
const RANDOM = ["q8Zr", "T2vL", "x9Wm", "K4pN", "s7Yb", "H3cJ", "w6Fd", "R1gV"].join("");

const write = (dir: string, files: Readonly<Record<string, string>>) => {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
};

const git = (dir: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.invalid", ...args], {
    cwd: dir,
    // The developer's own hooks and settings stay out of the fixture.
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });

// A one-commit repository standing in for the template, with `files` added on top.
const workspace = (template: Readonly<Record<string, string>>, files = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "build-checks-"));
  write(dir, { ".gitignore": "node_modules/\n.env\n", ...template });
  git(dir, "init", "-q");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "template");
  write(dir, files);
  return dir;
};

describe("secretProblems", () => {
  it("names the file and line of a committed key without its value", async () => {
    const dir = workspace({ "backend/src/app.ts": "export {};\n" });
    write(dir, { "backend/src/app.ts": `export {};\nconst aws = "${AWS_KEY}";\n` });
    git(dir, "commit", "-qam", "agent");

    const problems = await secretProblems(dir);

    expect(problems).toEqual([expect.stringMatching(/^backend\/src\/app\.ts:2 .*AWS access key/)]);
    expect(problems.join("\n")).not.toContain(AWS_KEY);
  });

  it("finds a random value given to a secret-sounding name in a new, uncommitted file", async () => {
    const dir = workspace(
      {},
      { "backend/src/config.ts": `export const apiToken = "${RANDOM}";\n` }
    );

    expect(await secretProblems(dir)).toEqual([
      expect.stringMatching(/^backend\/src\/config\.ts:1 /),
    ]);
  });

  it("only reads what changed since the build started", async () => {
    const dir = workspace({ "old.ts": `const token = "${RANDOM}";\n` });
    const base = git(dir, "rev-parse", "HEAD").toString().trim();
    write(dir, { "new.ts": `const token = "${RANDOM}";\n` });

    expect(await secretProblems(dir, base)).toEqual([expect.stringMatching(/^new\.ts:1 /)]);
  });

  it("fails a committed .env but not the example or an ignored one", async () => {
    const dir = workspace(
      {},
      { ".env.example": "X=1\n", ".env": "X=2\n", "backend/.env.local": "X=3\n" }
    );

    expect(await secretProblems(dir)).toEqual([expect.stringMatching(/^backend\/\.env\.local /)]);
  });

  it("passes ordinary code, local addresses, hashes and lockfiles", async () => {
    const dir = workspace(
      {},
      {
        "compose.yaml": "DATABASE_URL: postgres://postgres:postgres@db:5432/app\n",
        "backend/src/a.ts": [
          "const password = req.body.password;",
          'const tokenKey = "session_token_for_the_signed_in_user";',
          'const commit = "e5b299f0123456789abcdef0123456789abcdef0";',
          "export const renderTheCustomerDetailsPageWithAllFields = 1;",
          'const shareToken = "6f1c2a4e-7d1b-4c55-9a43-0d6b1e2f3a4b";',
          "",
        ].join("\n"),
        "package-lock.json": `{"integrity": "sha512-${RANDOM}${RANDOM}"}\n`,
      }
    );

    expect(await secretProblems(dir)).toEqual([]);
  });

  it("scores random text above words", () => {
    expect(entropy(RANDOM)).toBeGreaterThan(4.5);
    expect(entropy("aaaaaaaa")).toBe(0);
  });
});

describe("outboundProblems", () => {
  const page = (head: string, body = "") =>
    `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;

  it("fails a frontend that loads a remote font", async () => {
    const dir = workspace({
      "frontend/dist/index.html": page(
        '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">'
      ),
      "frontend/dist/assets/app.css":
        "@font-face{font-family:X;src:url(https://fonts.gstatic.com/x.woff2)}",
    });

    expect(await outboundProblems(dir)).toEqual([
      expect.stringContaining(
        "frontend/dist/assets/app.css loads from or sends to https://fonts.gstatic.com"
      ),
      expect.stringContaining(
        "frontend/dist/index.html loads from or sends to https://fonts.googleapis.com"
      ),
    ]);
  });

  it("passes a plain link to an outside page, in the page and in the bundle", async () => {
    const dir = workspace({
      "frontend/dist/index.html": page(
        '<link rel="canonical" href="https://shop.example.org/"><script type="module" src="/assets/app.js"></script>',
        '<a href="https://www.wikipedia.org/">Wikipedia</a>'
      ),
      "frontend/dist/assets/app.js":
        'const e=jsx("a",{href:"https://www.wikipedia.org/",children:"Wikipedia"});' +
        'const ns="http://www.w3.org/2000/svg";throw Error("https://react.dev/errors/"+n);',
    });

    expect(await outboundProblems(dir)).toEqual([]);
  });

  it("fails a bundle that fetches, loads a script or posts a form elsewhere", async () => {
    const dir = workspace({
      "frontend/dist/assets/app.js":
        'fetch("https://api.tracker.io/collect");s.src="//cdn.ads.net/t.js";jsx("form",{action:"https://forms.io/x"})',
    });

    expect((await outboundProblems(dir)).join("\n")).toEqual(
      expect.stringMatching(/api\.tracker\.io[^]*cdn\.ads\.net[^]*forms\.io/)
    );
  });

  it("fails backend code that calls another service, but not localhost, comments or tests", async () => {
    const dir = workspace({
      "backend/src/app.ts": [
        "// See https://docs.example.dev/how",
        'await fetch("http://localhost:3000/health");',
        "/* https://hono.dev */",
        'await fetch("https://api.weather.dev/today");',
        "",
      ].join("\n"),
      "backend/src/__tests__/app.test.ts": 'fetch("https://api.weather.dev/")',
      "backend/node_modules/x/index.js": 'fetch("https://registry.npmjs.org/")',
    });

    expect(await outboundProblems(dir)).toEqual([
      expect.stringMatching(/^backend\/src\/app\.ts:4 calls https:\/\/api\.weather\.dev\./),
    ]);
  });
});

describe("buildProblems", () => {
  it("passes a workspace with nothing to report", async () => {
    expect(await buildProblems(workspace({ "frontend/dist/index.html": "<html></html>" }))).toEqual(
      []
    );
  });
});
