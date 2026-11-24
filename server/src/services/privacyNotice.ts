import { readdir, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { escapeHtml } from "./site.ts";

// The privacy notice page and the footer that links it, written into every app before deploy
// beside the page title and icon (`writeSite`), so the builder never writes them and a change
// cannot remove them. Filled from data only: what the business has not provided says so.
//
// ponytail: one fixed English text for every country, pending the lawyer's wording (#267). An app
// "keeps personal details" when its migrations create a table; swap for the guardrails tier (#259).

// Served as a static file, so it is public even on an invite-only app.
export const PRIVACY_FILE = "privacy.html";
export const NOT_PROVIDED = "The business has not provided this yet.";
const REPORT = "https://schmeide.app/report";

export type PrivacyFacts = {
  readonly business: string;
  // The app's own address, for the report form; null before its first deploy.
  readonly appUrl: string | null;
  // What only the owner knows (#56) and where the platform stores data (#260); null until known.
  readonly contact: string | null;
  readonly retention: string | null;
  readonly region: string | null;
};

const CREATE_TABLE = /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([\w.]+)"?/gi;

// The tables an app's migrations create, each once, in the order they were made.
export const tablesIn = (migrations: readonly string[]): readonly string[] => [
  ...new Set(migrations.flatMap((sql) => [...sql.matchAll(CREATE_TABLE)].map(([, name]) => name))),
];

export const reportUrl = (appUrl: string | null): string =>
  appUrl ? `${REPORT}?app=${encodeURIComponent(appUrl)}` : REPORT;

const given = (value: string | null): string =>
  value?.trim() ? escapeHtml(value.trim()) : NOT_PROVIDED;

export const privacyPage = (facts: PrivacyFacts & { readonly tables: readonly string[] }) => {
  const business = given(facts.business);
  // prettier-ignore: the app's own `make check` runs prettier, and this page is written for it.
  return `<!doctype html>
<!-- prettier-ignore -->
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Privacy notice</title>
    <style>body{font-family:system-ui,sans-serif;line-height:1.5;max-width:40rem;margin:0 auto;padding:1rem;overflow-wrap:anywhere}</style>
  </head>
  <body>
    <main>
      <h1>Privacy notice</h1>
      <h2>Who keeps your details</h2>
      <p>This app belongs to ${business}. Schmeide hosts it on their behalf.</p>
      <h2>What this app keeps</h2>
      <ul>
${facts.tables.map((table) => `        <li>${escapeHtml(table)}</li>`).join("\n")}
      </ul>
      <h2>Where it is stored</h2>
      <p>${given(facts.region)}</p>
      <h2>How long it is kept</h2>
      <p>${given(facts.retention)}</p>
      <h2>Asking for your details or having them removed</h2>
      <p>Contact the business: ${given(facts.contact)}</p>
      <p><a href="${escapeHtml(reportUrl(facts.appUrl))}">Report this app</a></p>
    </main>
  </body>
</html>
`;
};

const FOOTER = /[ \t]*<!-- schmeide:footer -->[\s\S]*?<!-- \/schmeide:footer -->\n?/g;

// Replaces the footer it added before, if any, so running it again changes nothing. The footer is
// on its own lines behind prettier-ignore, so the app's prettier check passes on it as written.
export const withFooter = (
  html: string,
  links: { readonly privacy: boolean; readonly report: string }
): string => {
  const privacy = links.privacy ? `<a href="/${PRIVACY_FILE}">Privacy notice</a> · ` : "";
  const footer = [
    "<!-- schmeide:footer -->",
    "<!-- prettier-ignore -->",
    `<footer style="text-align:center;font-size:0.875rem;padding:1rem">${privacy}<a href="${escapeHtml(links.report)}">Report this app</a></footer>`,
    "<!-- /schmeide:footer -->",
  ]
    .map((line) => `    ${line}\n`)
    .join("");
  return html.replace(FOOTER, "").replace(/[ \t]*<\/body>/i, () => `${footer}  </body>`);
};

// Writes frontend/public/privacy.html (or removes it when the app keeps no table) and the footer
// into frontend/index.html, which the caller has checked exists.
export const writePrivacy = async (workspace: string, facts: PrivacyFacts): Promise<void> => {
  const drizzle = join(workspace, "backend", "drizzle");
  const names = (await readdir(drizzle).catch(() => [])).filter((name) => name.endsWith(".sql"));
  const tables = tablesIn(
    await Promise.all(names.sort().map((name) => readFile(join(drizzle, name), "utf8")))
  );
  const frontend = join(workspace, "frontend");
  const page = join(frontend, "public", PRIVACY_FILE);
  if (tables.length > 0) {
    await mkdir(join(frontend, "public"), { recursive: true });
    await writeFile(page, privacyPage({ ...facts, tables }));
  } else await rm(page, { force: true });
  const index = join(frontend, "index.html");
  const html = await readFile(index, "utf8");
  await writeFile(
    index,
    withFooter(html, { privacy: tables.length > 0, report: reportUrl(facts.appUrl) })
  );
};
