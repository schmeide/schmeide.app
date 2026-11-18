// Scans an upload after the type check and before it is stored (docs/mvp.md, "Files").
// ClamAV runs in the cluster; a customer file is not sent anywhere else. Its deployment is in
// schmeide/iac. On a dev machine with SCHMEIDE_CLAMAV_ADDRESS unset, the stand-in passes everything.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { crc32, deflateRawSync, inflateSync } from "node:zlib";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import {
  files as fileRows,
  projects,
  type FileOwner,
  type FilePurpose,
  type FileType,
} from "../db/schema.ts";
import { DamagedFileError, UploadRefusedError } from "./errors.ts";
import type { FileStore } from "./fileStore.ts";
import { decodeText, decodeXml, delimiterOf, parseCsv } from "./spreadsheet.ts";
import { readZipEntry, zipEntries } from "./zip.ts";

// The EICAR test string: harmless on its own, and the file every scanner is built to refuse.
export const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

export const UNSAFE_MESSAGE =
  "This file can't be accepted. It could harm someone who opens it. Send a different file.";
export const SCANNER_UNAVAILABLE = "We couldn't check this file just now. Try again in a moment.";
const DAMAGED_MESSAGE = "We couldn't open this file. Save it again, then send it again.";

const SCAN_TIMEOUT_MS = 10_000;
const MAX_PART = 16 * 1024 * 1024;
const CHUNK = 64 * 1024;

export type ScanVerdict =
  { readonly clean: true } | { readonly clean: false; readonly detail: string };

export type FileScanner = (bytes: Buffer) => Promise<ScanVerdict>;

export class ScannerUnavailableError extends Error {}

// ponytail: passes every file. Set SCHMEIDE_CLAMAV_ADDRESS to scan with ClamAV instead.
export const passingScanner: FileScanner = async () => ({ clean: true });

export const parseScannerAddress = (
  address: string
): { readonly host: string; readonly port: number } => {
  const at = address.lastIndexOf(":");
  const host = address.slice(0, at).trim();
  const port = Number(address.slice(at + 1));
  if (at < 1 || host === "" || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error(
      `SCHMEIDE_CLAMAV_ADDRESS must be host:port, for example clamav.clamav.svc.cluster.local:3310 (it is ${address}).`
    );
  return { host, port };
};

const writeTo = (socket: Socket, data: Buffer) =>
  new Promise<void>((resolve, reject) => {
    socket.write(data, (error) => (error ? reject(error) : resolve()));
  });

// clamd INSTREAM: zINSTREAM and a null, then each chunk as a 4-byte big-endian length and its
// bytes, then a zero length. The reply is "stream: OK" or "stream: <name> FOUND".
export const createClamdScanner = (
  address: { readonly host: string; readonly port: number },
  timeoutMs = SCAN_TIMEOUT_MS
): FileScanner => {
  return (bytes) =>
    new Promise((resolve, reject) => {
      const socket = connect({ host: address.host, port: address.port });
      socket.setNoDelay(true);
      let settled = false;
      let response = "";
      const finish = (error?: ScannerUnavailableError, verdict?: ScanVerdict) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (verdict) resolve(verdict);
        else reject(error ?? new ScannerUnavailableError("could not be reached"));
      };
      const timer = setTimeout(() => finish(new ScannerUnavailableError("timed out")), timeoutMs);
      const verdictOf = (reply: string): ScanVerdict | ScannerUnavailableError => {
        const text = reply.replaceAll("\0", "").trim();
        if (text.includes("FOUND")) return { clean: false, detail: text };
        if (text.includes("OK")) return { clean: true };
        return new ScannerUnavailableError(text || "empty reply");
      };
      socket.on("error", () => finish(new ScannerUnavailableError("could not be reached")));
      socket.on("data", (chunk: Buffer) => {
        response += chunk.toString("latin1");
        if (!/FOUND|OK|ERROR/.test(response)) return;
        const verdict = verdictOf(response);
        if (verdict instanceof ScannerUnavailableError) finish(verdict);
        else finish(undefined, verdict);
      });
      socket.on("end", () => {
        const verdict = verdictOf(response);
        if (verdict instanceof ScannerUnavailableError) finish(verdict);
        else finish(undefined, verdict);
      });
      socket.once("connect", () => {
        void (async () => {
          await writeTo(socket, Buffer.from("zINSTREAM\0", "latin1"));
          for (let at = 0; at < bytes.length; at += CHUNK) {
            const chunk = bytes.subarray(at, Math.min(at + CHUNK, bytes.length));
            const header = Buffer.alloc(4);
            header.writeUInt32BE(chunk.length);
            await writeTo(socket, header);
            await writeTo(socket, chunk);
          }
          await writeTo(socket, Buffer.alloc(4));
        })().catch(() => finish(new ScannerUnavailableError("could not be reached")));
      });
    });
};

export const createFileScanner = (address: string | undefined): FileScanner =>
  address === undefined || address.trim() === ""
    ? passingScanner
    : createClamdScanner(parseScannerAddress(address.trim()));

const PDF_NAMES = new Set(["JS", "JavaScript", "Launch", "EmbeddedFile", "EmbeddedFiles"]);

const pdfName = (raw: string): string =>
  raw.replace(/#([0-9A-Fa-f]{2})/g, (_whole, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16))
  );

const dangerousPdfName = (latin1: string): string | undefined => {
  for (const match of latin1.matchAll(/\/([A-Za-z0-9#]+)/g)) {
    const name = pdfName(match[1]);
    if (PDF_NAMES.has(name)) return name;
  }
  return undefined;
};

const pdfDetail = (name: string): string => {
  if (name === "Launch") return "PDF has a launch action";
  if (name === "EmbeddedFile" || name === "EmbeddedFiles") return "PDF has an attached file";
  return "PDF has a JavaScript action";
};

const streamData = (
  bytes: Buffer,
  at: number
): { readonly start: number; readonly end: number } | undefined => {
  let start = at + "stream".length;
  if (bytes[start] === 0x0d && bytes[start + 1] === 0x0a) start += 2;
  else if (bytes[start] === 0x0a || bytes[start] === 0x0d) start += 1;
  else return undefined;
  const dict = bytes.subarray(Math.max(0, at - 500), at).toString("latin1");
  const lengths = [...dict.matchAll(/\/Length\s+(\d+)\b/g)];
  const declared = lengths.length > 0 ? Number(lengths[lengths.length - 1][1]) : undefined;
  const marker = bytes.indexOf("endstream", start);
  const end = declared !== undefined ? start + declared : marker === -1 ? bytes.length : marker;
  return { start, end: Math.min(end, bytes.length) };
};

// A script, launch action, or attachment is refused from the PDF's own structure. FlateDecode
// streams are inflated first, so hiding the dictionary in a compressed stream does not help.
const pdfProblem = (bytes: Buffer): string | undefined => {
  const clear = Buffer.from(bytes);
  let from = 0;
  while (from < bytes.length) {
    const at = bytes.indexOf("stream", from);
    if (at < 0) break;
    const previous = at === 0 ? 0x0a : bytes[at - 1];
    const boundary =
      previous === 0x0a || previous === 0x0d || previous === 0x20 || previous === 0x09;
    const data = boundary ? streamData(bytes, at) : undefined;
    if (!boundary || !data) {
      from = at + "stream".length;
      continue;
    }
    const dict = bytes.subarray(Math.max(0, at - 500), at).toString("latin1");
    if (dict.includes("/FlateDecode")) {
      try {
        const name = dangerousPdfName(
          inflateSync(bytes.subarray(data.start, data.end)).toString("latin1")
        );
        if (name) return pdfDetail(name);
      } catch {
        // A stream that does not inflate is not, by itself, a script.
      }
      clear.fill(0x20, data.start, data.end);
    }
    from = Math.max(data.end, at + "stream".length);
  }
  const name = dangerousPdfName(clear.toString("latin1"));
  return name ? pdfDetail(name) : undefined;
};

const MACRO_NAME = /(?:^|\/)(?:vbaProject\.bin|vbaData\.xml)$|macrosheets?\/|oleObject/i;

const xlsxProblem = async (bytes: Buffer): Promise<string | undefined> => {
  const entries = zipEntries(bytes);
  if (entries.some((entry) => MACRO_NAME.test(entry.name))) return "spreadsheet has macros";
  const types = entries.find((entry) => entry.name === "[Content_Types].xml");
  if (!types) return undefined;
  const xml = await readZipEntry(bytes, types, MAX_PART + 1);
  if (xml.length > MAX_PART || /vbaProject|macroSheet|macroEnabled/i.test(xml.toString("utf8")))
    return "spreadsheet has macros";
  return undefined;
};

const structureProblem = async (type: FileType, bytes: Buffer): Promise<string | undefined> => {
  if (type === "pdf") return pdfProblem(bytes);
  if (type === "xlsx") return xlsxProblem(bytes);
  return undefined;
};

export const screenUpload = async (input: {
  readonly type: FileType;
  readonly bytes: Buffer;
  readonly scanner: FileScanner;
}): Promise<void> => {
  let structure: string | undefined;
  try {
    structure = await structureProblem(input.type, input.bytes);
  } catch (error) {
    if (error instanceof DamagedFileError) throw new UploadRefusedError("damaged", DAMAGED_MESSAGE);
    throw error;
  }
  if (structure) throw new UploadRefusedError("unsafe", UNSAFE_MESSAGE, structure);
  let verdict: ScanVerdict;
  try {
    verdict = await input.scanner(input.bytes);
  } catch (error) {
    if (error instanceof UploadRefusedError) throw error;
    throw new UploadRefusedError("scan_unavailable", SCANNER_UNAVAILABLE);
  }
  if (!verdict.clean) throw new UploadRefusedError("unsafe", UNSAFE_MESSAGE, verdict.detail);
};

const FORMULA_START = /^[=+\-@]/;

const escapeXml = (text: string): string =>
  text.replace(/[&<>]/g, (char) => `&#${char.charCodeAt(0)};`);

const textOf = (xml: string): string =>
  [...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "").matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)]
    .map((run) => decodeXml(run[1]))
    .join("");

const prefixText = (xml: string): string => {
  if (!FORMULA_START.test(textOf(xml))) return xml;
  let done = false;
  return xml.replace(/<t\b([^>]*)>([\s\S]*?)<\/t>/, (run, attrs: string, inner: string) => {
    if (done) return run;
    done = true;
    return `<t${attrs}>'${inner}</t>`;
  });
};

const prefixSheet = (xml: string): string =>
  xml.replace(
    /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g,
    (whole, attributes: string, body?: string) => {
      if (body === undefined) return whole;
      const formula = /<f\b[^>]*>([\s\S]*?)<\/f>/.exec(body);
      if (formula) {
        const ref = /(?:^|\s)r="([^"]*)"/.exec(attributes)?.[1];
        const shown = escapeXml(`'=${decodeXml(formula[1])}`);
        return `<c${ref ? ` r="${escapeXml(ref)}"` : ""} t="inlineStr"><is><t>${shown}</t></is></c>`;
      }
      const kind = /(?:^|\s)t="([^"]*)"/.exec(attributes)?.[1];
      if (kind === "inlineStr") {
        const next = prefixText(body);
        return next === body ? whole : whole.replace(body, () => next);
      }
      if (kind === "str")
        return whole.replace(/<v\b([^>]*)>([\s\S]*?)<\/v>/, (run, attrs: string, inner: string) =>
          FORMULA_START.test(decodeXml(inner)) ? `<v${attrs}>'${inner}</v>` : run
        );
      return whole;
    }
  );

const u16le = (value: number): Buffer => {
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16LE(value);
  return bytes;
};
const u32le = (value: number): Buffer => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return bytes;
};

const writeZip = (parts: readonly { readonly name: string; readonly data: Buffer }[]): Buffer => {
  const packed = parts.map((part) => ({ ...part, body: deflateRawSync(part.data) }));
  const offsets = packed.map((_, index) =>
    packed
      .slice(0, index)
      .reduce((total, part) => total + 30 + Buffer.byteLength(part.name) + part.body.length, 0)
  );
  const shared = (part: (typeof packed)[number]) =>
    Buffer.concat([
      u16le(0),
      u16le(8),
      u16le(0),
      u16le(0),
      u32le(crc32(part.data)),
      u32le(part.body.length),
      u32le(part.data.length),
      u16le(Buffer.byteLength(part.name)),
      u16le(0),
    ]);
  const locals = packed.map((part) =>
    Buffer.concat([u32le(0x04034b50), u16le(20), shared(part), Buffer.from(part.name), part.body])
  );
  const central = packed.map((part, index) =>
    Buffer.concat([
      u32le(0x02014b50),
      u16le(20),
      u16le(20),
      shared(part),
      u16le(0),
      u16le(0),
      u16le(0),
      u32le(0),
      u32le(offsets[index] ?? 0),
      Buffer.from(part.name),
    ])
  );
  const directory = Buffer.concat(central);
  const start = Buffer.concat(locals).length;
  return Buffer.concat([
    ...locals,
    directory,
    u32le(0x06054b50),
    u16le(0),
    u16le(0),
    u16le(parts.length),
    u16le(parts.length),
    u32le(directory.length),
    u32le(start),
    u16le(0),
  ]);
};

const isShared = (name: string) => name.toLowerCase() === "xl/sharedstrings.xml";
const isSheet = (name: string) => /^xl\/worksheets\/.+\.xml$/i.test(name);

const partOf = async (
  bytes: Buffer,
  entry: ReturnType<typeof zipEntries>[number]
): Promise<Buffer> => {
  const data = await readZipEntry(bytes, entry, MAX_PART + 1);
  if (data.length > MAX_PART) throw new DamagedFileError("A part of the spreadsheet is too large");
  return data;
};

const neutralizeCsv = (bytes: Buffer): Buffer => {
  const decoded = decodeText(bytes);
  if (decoded === undefined) return bytes;
  const bom = decoded.startsWith("\uFEFF");
  const text = bom ? decoded.slice(1) : decoded;
  const rows = parseCsv(text, Number.MAX_SAFE_INTEGER);
  if (!rows.some((row) => row.some((cell) => FORMULA_START.test(cell)))) return bytes;
  const delimiter = delimiterOf(text);
  const ending = text.includes("\r\n") ? "\r\n" : "\n";
  const quote = (cell: string) =>
    cell.includes(delimiter) || /["\r\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell;
  const body = rows
    .map((row) =>
      row.map((cell) => quote(FORMULA_START.test(cell) ? `'${cell}` : cell)).join(delimiter)
    )
    .join(ending);
  const trailing = /\r?\n$/.test(text) ? ending : "";
  return Buffer.from(`${bom ? "\uFEFF" : ""}${body}${trailing}`, "utf8");
};

const neutralizeXlsx = async (bytes: Buffer): Promise<Buffer> => {
  const entries = zipEntries(bytes);
  const rewritten = new Map<string, Buffer>();
  for (const entry of entries) {
    if (!isShared(entry.name) && !isSheet(entry.name)) continue;
    const xml = (await partOf(bytes, entry)).toString("utf8");
    const next = isShared(entry.name)
      ? xml.replace(/<si\b[^>]*?(?:\/>|>[\s\S]*?<\/si>)/g, (item) => prefixText(item))
      : prefixSheet(xml);
    if (next !== xml) rewritten.set(entry.name, Buffer.from(next));
  }
  if (rewritten.size === 0) return bytes;
  const parts: { name: string; data: Buffer }[] = [];
  for (const entry of entries)
    parts.push({
      name: entry.name,
      data: rewritten.get(entry.name) ?? (await partOf(bytes, entry)),
    });
  return writeZip(parts);
};

// Quotes a cell a spreadsheet program would run, so a copy into an app or a later download (#85)
// keeps the text and does not execute it.
export const neutralizeSpreadsheet = (type: "csv" | "xlsx", bytes: Buffer): Promise<Buffer> =>
  type === "csv" ? Promise.resolve(neutralizeCsv(bytes)) : neutralizeXlsx(bytes);

// The builder may copy a file into the app only when it is mine and in_app (temporal/activities.ts).
const goesIntoApp = (owner: FileOwner, purpose: FilePurpose) =>
  owner === "mine" && purpose === "in_app";

export const acceptUpload = async (input: {
  readonly type: FileType;
  readonly bytes: Buffer;
  readonly owner: FileOwner;
  readonly purpose: FilePurpose;
  readonly scanner: FileScanner;
}): Promise<Buffer> => {
  await screenUpload(input);
  if (!goesIntoApp(input.owner, input.purpose) || (input.type !== "csv" && input.type !== "xlsx"))
    return input.bytes;
  try {
    return await neutralizeSpreadsheet(input.type, input.bytes);
  } catch (error) {
    if (error instanceof DamagedFileError) throw new UploadRefusedError("damaged", DAMAGED_MESSAGE);
    throw error;
  }
};

export type NewUploadRefusal = {
  readonly tenantId: number;
  readonly projectId: number;
  readonly uploadedBy: string | null;
  readonly fileId: number | null;
  readonly name: string;
  readonly type: string;
  readonly detail: string;
};

export type UploadRefusalRecord = NewUploadRefusal & { readonly at: string };

const refusalDir = (dataDir: string) => join(dataDir, "review", "upload-refusals");
const markerPath = (dataDir: string) => join(dataDir, "review", "stored-files-scanned");

export const recordUploadRefusal = async (
  dataDir: string,
  refusal: NewUploadRefusal
): Promise<UploadRefusalRecord> => {
  const dir = refusalDir(dataDir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const record = { ...refusal, at: new Date().toISOString() };
  const name = `${record.at.replace(/[:.]/g, "-")}-${randomUUID()}.json`;
  await writeFile(join(dir, name), JSON.stringify(record), { mode: 0o600 });
  return record;
};

export const listUploadRefusals = async (
  dataDir: string
): Promise<readonly UploadRefusalRecord[]> => {
  const names = await readdir(refusalDir(dataDir)).catch(() => [] as string[]);
  const records = await Promise.all(
    names
      .filter((name) => name.endsWith(".json"))
      .map(async (name) => {
        try {
          return JSON.parse(
            await readFile(join(refusalDir(dataDir), name), "utf8")
          ) as UploadRefusalRecord;
        } catch {
          return undefined;
        }
      })
  );
  return records
    .filter((record) => record !== undefined)
    .sort((left, right) => left.at.localeCompare(right.at));
};

export type StoredUpload = {
  readonly id: number;
  readonly tenantId: number;
  readonly projectId: number;
  readonly uploadedBy: string | null;
  readonly type: FileType;
  readonly originalName: string;
  readonly owner: FileOwner;
  readonly purpose: FilePurpose;
};

export const scanStoredOnce = async (input: {
  readonly dataDir: string;
  readonly stamp: string;
  readonly load: () => Promise<readonly StoredUpload[]>;
  readonly read: (file: StoredUpload) => Promise<Buffer>;
  readonly remove: (file: StoredUpload) => Promise<void>;
  readonly replace: (file: StoredUpload, bytes: Buffer) => Promise<void>;
  readonly scanner: FileScanner;
  readonly record: (file: StoredUpload, detail: string) => Promise<unknown>;
}): Promise<{ readonly status: "already" | "scanned"; readonly removed: number }> => {
  const marker = markerPath(input.dataDir);
  if (existsSync(marker) && (await readFile(marker, "utf8")) === input.stamp)
    return { status: "already", removed: 0 };
  const files = await input.load();
  let removed = 0;
  for (const file of files) {
    let bytes: Buffer;
    try {
      bytes = await input.read(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        await input.remove(file);
        removed += 1;
        continue;
      }
      throw error;
    }
    try {
      const stored = await acceptUpload({
        type: file.type,
        bytes,
        owner: file.owner,
        purpose: file.purpose,
        scanner: input.scanner,
      });
      if (!stored.equals(bytes)) await input.replace(file, stored);
    } catch (error) {
      if (error instanceof UploadRefusedError && error.code === "scan_unavailable") throw error;
      if (error instanceof UploadRefusedError) {
        await input.record(file, error.detail ?? error.message);
        await input.remove(file);
        removed += 1;
        continue;
      }
      throw error;
    }
  }
  await mkdir(join(input.dataDir, "review"), { recursive: true, mode: 0o700 });
  await writeFile(marker, input.stamp, { mode: 0o600 });
  return { status: "scanned", removed };
};

const loadStored = (db: Db): Promise<readonly StoredUpload[]> =>
  db
    .select({
      id: fileRows.id,
      tenantId: projects.tenantId,
      projectId: fileRows.projectId,
      uploadedBy: fileRows.uploadedBy,
      type: fileRows.type,
      originalName: fileRows.originalName,
      owner: fileRows.owner,
      purpose: fileRows.purpose,
    })
    .from(fileRows)
    .innerJoin(projects, eq(projects.id, fileRows.projectId));

export const scanStoredFiles = (deps: {
  readonly db: Db;
  readonly files: FileStore;
  readonly dataDir: string;
  readonly scanner: FileScanner;
  readonly stamp: string;
}): Promise<{ readonly status: "already" | "scanned"; readonly removed: number }> =>
  scanStoredOnce({
    dataDir: deps.dataDir,
    stamp: deps.stamp,
    scanner: deps.scanner,
    load: () => loadStored(deps.db),
    read: (file) =>
      deps.files.get({ tenantId: file.tenantId, projectId: file.projectId, fileId: file.id }),
    remove: async (file) => {
      await deps.db.delete(fileRows).where(eq(fileRows.id, file.id));
      await deps.files.remove({
        tenantId: file.tenantId,
        projectId: file.projectId,
        fileId: file.id,
      });
    },
    replace: (file, bytes) =>
      deps.files.put(
        { tenantId: file.tenantId, projectId: file.projectId, fileId: file.id },
        bytes
      ),
    record: (file, detail) =>
      recordUploadRefusal(deps.dataDir, {
        tenantId: file.tenantId,
        projectId: file.projectId,
        uploadedBy: file.uploadedBy,
        fileId: file.id,
        name: file.originalName,
        type: file.type,
        detail,
      }),
  });
