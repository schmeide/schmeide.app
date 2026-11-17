import type { FileType } from "../db/schema.ts";
import { DamagedFileError } from "./errors.ts";
import { isXlsx, looksLikeCsv } from "./spreadsheet.ts";
import { isWebp, PNG_SIGNATURE } from "./stripMetadata.ts";
import { ZIP_SIGNATURE, zipEntries } from "./zip.ts";

const JPEG = Buffer.from([0xff, 0xd8, 0xff]);
const PDF = Buffer.from("%PDF-", "latin1");

const startsWith = (bytes: Buffer, prefix: Buffer): boolean =>
  bytes.length > prefix.length && bytes.subarray(0, prefix.length).equals(prefix);

const holdsWorkbook = (bytes: Buffer): boolean => {
  try {
    return isXlsx(zipEntries(bytes));
  } catch (error) {
    if (error instanceof DamagedFileError) return false;
    throw error;
  }
};

export const sniffType = (bytes: Buffer): FileType | undefined => {
  if (startsWith(bytes, PNG_SIGNATURE)) return "png";
  if (startsWith(bytes, JPEG)) return "jpeg";
  if (isWebp(bytes)) return "webp";
  if (startsWith(bytes, PDF)) return "pdf";
  if (startsWith(bytes, ZIP_SIGNATURE)) return holdsWorkbook(bytes) ? "xlsx" : undefined;
  return looksLikeCsv(bytes) ? "csv" : undefined;
};

export const MIME: Readonly<Record<FileType, string>> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
  pdf: "application/pdf",
  csv: "text/csv",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

export const UNDECLARED: readonly string[] = [
  "application/octet-stream",
  "application/vnd.ms-excel",
];

const DECLARED: Readonly<Record<string, FileType>> = {
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/jpg": "jpeg",
  "image/webp": "webp",
  "application/pdf": "pdf",
  "text/csv": "csv",
  "application/csv": "csv",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
};

export const declaredType = (contentType: string | undefined): FileType | "any" | undefined => {
  const mime = (contentType ?? "").split(";")[0].trim().toLowerCase();
  return UNDECLARED.includes(mime) ? "any" : DECLARED[mime];
};

export const TYPE_LABEL: Readonly<Record<FileType, string>> = {
  png: "a PNG picture",
  jpeg: "a JPEG picture",
  webp: "a WebP picture",
  pdf: "a PDF",
  csv: "a CSV file",
  xlsx: "an Excel spreadsheet (XLSX)",
};

export const isPicture = (type: FileType): boolean =>
  type === "png" || type === "jpeg" || type === "webp";
