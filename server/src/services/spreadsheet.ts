import { DamagedFileError } from "./errors.ts";
import { readZipEntry, zipEntries, type ZipEntry } from "./zip.ts";

export type Table = {
  readonly sheet: string | null;
  readonly columns: readonly string[];
  readonly sampleRows: readonly (readonly string[])[];
};

export const SAMPLE_ROWS = 5;
export const MAX_COLUMNS = 50;
export const CELL_MAX = 200;
const SCANNED_ROWS = 200;
const DELIMITERS = [",", ";", "\t"] as const;

const WORKBOOK = "xl/workbook.xml";
const WORKBOOK_LINKS = "xl/_rels/workbook.xml.rels";
const SHARED_STRINGS = "xl/sharedStrings.xml";
const FIRST_SHEET_TARGET = "worksheets/sheet1.xml";
const WORKBOOK_LIMIT = 1024 * 1024;
const SHEET_LIMIT = 4 * 1024 * 1024;
const STRINGS_LIMIT = 16 * 1024 * 1024;

const decode = (bytes: Buffer, encoding: string): string | undefined => {
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
};

export const decodeText = (bytes: Buffer): string | undefined => {
  const text = decode(bytes, "utf-8") ?? decode(bytes, "windows-1252");
  if (text === undefined) return undefined;
  return /[^\P{Cc}\t\r\n]/u.test(text) ? undefined : text;
};

const firstLine = (text: string): string => /^\s*([^\r\n]*)/.exec(text)?.[1] ?? "";

const countOutsideQuotes = (line: string, delimiter: string): number =>
  line
    .split('"')
    .reduce(
      (total, part, index) => (index % 2 === 0 ? total + part.split(delimiter).length - 1 : total),
      0
    );

export const delimiterOf = (text: string): string => {
  const line = firstLine(text);
  return DELIMITERS.reduce((best, candidate) =>
    countOutsideQuotes(line, candidate) > countOutsideQuotes(line, best) ? candidate : best
  );
};

export const parseCsv = (text: string, maxRows: number): readonly (readonly string[])[] => {
  const delimiter = delimiterOf(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let wasQuoted = false;
  const endCell = () => {
    row.push(wasQuoted ? cell : cell.trim());
    cell = "";
    wasQuoted = false;
  };
  const endRow = () => {
    endCell();
    rows.push(row);
    row = [];
  };
  for (let at = 0; at < text.length && rows.length < maxRows; at++) {
    const char = text[at];
    if (quoted) {
      if (char !== '"') cell += char;
      else if (text[at + 1] === '"') {
        cell += '"';
        at += 1;
      } else quoted = false;
    } else if (char === '"' && cell.trim() === "") {
      quoted = true;
      wasQuoted = true;
      cell = "";
    } else if (char === delimiter) endCell();
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[at + 1] === "\n") at += 1;
      endRow();
    } else cell += char;
  }
  if (rows.length < maxRows && (cell !== "" || wasQuoted || row.length > 0)) endRow();
  return rows;
};

const isBlank = (row: readonly string[]): boolean => row.every((cell) => cell.trim() === "");

const clip = (cell: string): string => [...cell.trim()].slice(0, CELL_MAX).join("");

export const tableOf = (rows: readonly (readonly string[])[], sheet: string | null): Table => {
  const [header, ...rest] = rows.filter((row) => !isBlank(row));
  if (!header) return { sheet, columns: [], sampleRows: [] };
  const named = header
    .map((name, index) => ({ name: clip(name), index }))
    .filter(({ name }) => name !== "")
    .filter(({ name }, at, all) => all.findIndex((other) => other.name === name) === at)
    .slice(0, MAX_COLUMNS);
  return {
    sheet,
    columns: named.map(({ name }) => name),
    sampleRows: rest
      .slice(0, SAMPLE_ROWS)
      .map((row) => named.map(({ index }) => clip(row[index] ?? ""))),
  };
};

const withoutBom = (text: string): string => text.replace(/^\uFEFF/, "");

export const looksLikeCsv = (bytes: Buffer): boolean => {
  const text = decodeText(bytes);
  if (text === undefined || /^\s*</.test(withoutBom(text))) return false;
  const [header] = parseCsv(withoutBom(text), 20).filter((row) => !isBlank(row));
  return header !== undefined && header.filter((cell) => cell !== "").length >= 2;
};

export const csvTable = (bytes: Buffer): Table => {
  const text = decodeText(bytes);
  if (text === undefined) throw new DamagedFileError("The file is not plain text");
  return tableOf(parseCsv(withoutBom(text), SCANNED_ROWS), null);
};

const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

const codePoint = (value: number, fallback: string): string =>
  Number.isInteger(value) && value >= 0 && value <= 0x10ffff
    ? String.fromCodePoint(value)
    : fallback;

export const decodeXml = (text: string): string =>
  text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (whole, name: string) =>
    name.startsWith("#x")
      ? codePoint(Number.parseInt(name.slice(2), 16), whole)
      : name.startsWith("#")
        ? codePoint(Number.parseInt(name.slice(1), 10), whole)
        : (ENTITIES[name] ?? whole)
  );

const attribute = (attributes: string, name: string): string | undefined => {
  const found = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attributes);
  return found ? decodeXml(found[1]) : undefined;
};

const textRuns = (xml: string): string =>
  [...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "").matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)]
    .map((run) => decodeXml(run[1]))
    .join("");

const sharedStringsOf = (xml: string): readonly string[] =>
  [...xml.matchAll(/<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g)].map((item) => textRuns(item[1] ?? ""));

const columnIndex = (reference: string | undefined): number | undefined => {
  const letters = /^[A-Z]+/.exec(reference ?? "")?.[0];
  if (!letters) return undefined;
  return [...letters].reduce((total, letter) => total * 26 + letter.charCodeAt(0) - 64, 0) - 1;
};

const cellValue = (attributes: string, body: string, shared: readonly string[]): string => {
  const kind = attribute(attributes, "t");
  if (kind === "inlineStr") return textRuns(body);
  const value = decodeXml(/<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? "");
  if (kind === "s") return shared[Number(value)] ?? "";
  if (kind === "b") return value === "1" ? "Yes" : "No";
  return value;
};

const rowOf = (xml: string, shared: readonly string[]): readonly string[] => {
  const cells: string[] = [];
  for (const cell of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const index = columnIndex(attribute(cell[1], "r")) ?? cells.length;
    if (index >= 16_384) continue;
    while (cells.length < index) cells.push("");
    cells[index] = cellValue(cell[1], cell[2] ?? "", shared);
  }
  return cells;
};

const rowsOf = (xml: string, shared: readonly string[]): readonly (readonly string[])[] => {
  const rows: (readonly string[])[] = [];
  for (const row of xml.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    rows.push(rowOf(row[1] ?? "", shared));
    if (rows.length >= SCANNED_ROWS) break;
  }
  return rows;
};

const sheetPath = (target: string): string =>
  target.startsWith("/") ? target.slice(1) : `xl/${target}`;

export const isXlsx = (entries: readonly ZipEntry[]): boolean =>
  entries.some(({ name }) => name === WORKBOOK) &&
  entries.some(({ name }) => name === "[Content_Types].xml");

export const xlsxTable = async (bytes: Buffer): Promise<Table> => {
  const entries = zipEntries(bytes);
  const part = async (name: string, limit: number): Promise<string | undefined> => {
    const entry = entries.find((candidate) => candidate.name === name);
    return entry && (await readZipEntry(bytes, entry, limit)).toString("utf8");
  };
  const workbook = await part(WORKBOOK, WORKBOOK_LIMIT);
  if (workbook === undefined) throw new DamagedFileError("The file is not a spreadsheet");
  const first = /<sheet\b([^>]*)>/.exec(workbook)?.[1] ?? "";
  const link = attribute(first, "r:id");
  const links = (await part(WORKBOOK_LINKS, WORKBOOK_LIMIT)) ?? "";
  const target = [...links.matchAll(/<Relationship\b([^>]*)>/g)]
    .map((relationship) => relationship[1])
    .find((attributes) => link !== undefined && attribute(attributes, "Id") === link);
  const path = sheetPath((target && attribute(target, "Target")) ?? FIRST_SHEET_TARGET);
  const sheet = await part(path, SHEET_LIMIT);
  if (sheet === undefined) throw new DamagedFileError("The spreadsheet has no first sheet");
  const shared = sharedStringsOf((await part(SHARED_STRINGS, STRINGS_LIMIT)) ?? "");
  return tableOf(rowsOf(sheet, shared), attribute(first, "name") ?? null);
};
