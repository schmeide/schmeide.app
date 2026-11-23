import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { check, resolveConfig } from "prettier";
import { describe, expect, it } from "vitest";
import {
  NOT_PROVIDED,
  PRIVACY_FILE,
  privacyPage,
  reportUrl,
  tablesIn,
  withFooter,
  writePrivacy,
} from "../privacyNotice.ts";

const INDEX = `<!doctype html>
<html lang="en">
  <head><title>Notes</title></head>
  <body>
    <div id="root"></div>
  </body>
</html>
`;

// frontend/index.html as the template has it, formatted by its prettier.
const TEMPLATE_INDEX = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Notes</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`;

// What the app's own \`make check\` asks of a file. The template's .prettierrc is this repo's.
const prettierPasses = async (html: string): Promise<boolean> =>
  check(html, { ...(await resolveConfig(import.meta.filename)), parser: "html" });

const facts = {
  business: "Bäckerei Ode",
  appUrl: "https://notes-abc123.apps.example",
  contact: null,
  retention: null,
  region: null,
};

const app = async (migrations: Readonly<Record<string, string>>) => {
  const dir = await mkdtemp(join(tmpdir(), "schmeide-privacy-"));
  await mkdir(join(dir, "frontend"), { recursive: true });
  await mkdir(join(dir, "backend", "drizzle"), { recursive: true });
  await writeFile(join(dir, "frontend", "index.html"), INDEX);
  for (const [name, sql] of Object.entries(migrations)) {
    await writeFile(join(dir, "backend", "drizzle", name), sql);
  }
  return dir;
};

const NOTES = `CREATE TABLE "notes" (\n\t"id" serial PRIMARY KEY NOT NULL\n);`;
const CUSTOMERS = `CREATE TABLE IF NOT EXISTS "customers" ("id" serial);\nCREATE TABLE orders (id serial);`;

describe("tablesIn", () => {
  it("names every table the migrations create, once, in order", () => {
    expect(tablesIn([NOTES, CUSTOMERS, NOTES])).toEqual(["notes", "customers", "orders"]);
    expect(tablesIn(["ALTER TABLE notes ADD COLUMN x int;"])).toEqual([]);
  });
});

describe("privacyPage", () => {
  it("lists the tables and says what the business has not provided, never inventing it", () => {
    const page = privacyPage({ ...facts, tables: ["notes", "customers"] });
    expect(page).toContain("<li>notes</li>");
    expect(page).toContain("<li>customers</li>");
    expect(page).toContain("Bäckerei Ode");
    expect(page).toContain("Schmeide");
    expect(page.split(NOT_PROVIDED).length - 1).toBe(3);
  });

  it("is left as written by the app's prettier", async () => {
    const tables = ["notes", "a_table_with_a_name_long_enough_to_wrap_".repeat(3)];
    expect(await prettierPasses(privacyPage({ ...facts, business: "B".repeat(150), tables }))).toBe(
      true
    );
  });

  it("shows what the business provided, escaped", () => {
    const page = privacyPage({
      ...facts,
      business: "A & <B>",
      contact: "privacy@ode.example",
      retention: "Two years",
      region: "Germany",
      tables: ["notes"],
    });
    expect(page).toContain("A &amp; &lt;B&gt;");
    expect(page).toContain("privacy@ode.example");
    expect(page).toContain("Two years");
    expect(page).toContain("Germany");
    expect(page).not.toContain(NOT_PROVIDED);
  });
});

describe("withFooter", () => {
  it("adds the links once, however often it runs", () => {
    const once = withFooter(INDEX, { privacy: true, report: reportUrl(facts.appUrl) });
    expect(withFooter(once, { privacy: true, report: reportUrl(facts.appUrl) })).toBe(once);
    expect(once).toContain(`href="/${PRIVACY_FILE}"`);
    expect(once).toContain(
      `href="https://schmeide.app/report?app=https%3A%2F%2Fnotes-abc123.apps.example"`
    );
  });

  it("leaves the template's index.html as prettier wants it, so the app's checks still pass", async () => {
    expect(await prettierPasses(TEMPLATE_INDEX)).toBe(true);
    const long = reportUrl(`https://${"a".repeat(80)}.apps.example`);
    for (const links of [
      { privacy: true, report: long },
      { privacy: false, report: reportUrl(null) },
    ]) {
      expect(await prettierPasses(withFooter(TEMPLATE_INDEX, links))).toBe(true);
    }
  });

  it("replaces a footer written the old way, on one line, with no second footer", () => {
    const old = TEMPLATE_INDEX.replace(
      "  </body>",
      `      <!-- schmeide:footer --><footer style="text-align:center"><a href="https://schmeide.app/report">Report this app</a></footer><!-- /schmeide:footer -->\n  </body>`
    );
    const html = withFooter(old, { privacy: true, report: reportUrl(facts.appUrl) });
    expect(html.split("<footer").length - 1).toBe(1);
    expect(html).toBe(
      withFooter(TEMPLATE_INDEX, { privacy: true, report: reportUrl(facts.appUrl) })
    );
  });

  it("drops the privacy link when the app keeps nothing", () => {
    const footer = withFooter(INDEX, { privacy: false, report: reportUrl(null) });
    expect(footer).not.toContain(PRIVACY_FILE);
    expect(footer).toContain(`href="https://schmeide.app/report"`);
  });
});

describe("writePrivacy", () => {
  it("writes the page and the link, and puts them back after a change deletes them", async () => {
    const dir = await app({ "0000_notes.sql": NOTES, "0001_customers.sql": CUSTOMERS });
    try {
      await writePrivacy(dir, facts);
      const page = join(dir, "frontend", "public", PRIVACY_FILE);
      expect(await readFile(page, "utf8")).toContain("<li>orders</li>");
      expect(await readFile(join(dir, "frontend", "index.html"), "utf8")).toContain(PRIVACY_FILE);

      await rm(page);
      await writeFile(join(dir, "frontend", "index.html"), INDEX);
      await writePrivacy(dir, facts);
      expect(await readFile(page, "utf8")).toContain("<li>notes</li>");
      expect(await readFile(join(dir, "frontend", "index.html"), "utf8")).toContain(PRIVACY_FILE);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("gives an app without tables only the report link", async () => {
    const dir = await app({});
    try {
      await writePrivacy(dir, facts);
      const html = await readFile(join(dir, "frontend", "index.html"), "utf8");
      expect(html).toContain("schmeide.app/report");
      expect(html).not.toContain(PRIVACY_FILE);
      await expect(readFile(join(dir, "frontend", "public", PRIVACY_FILE))).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
