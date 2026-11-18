import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
