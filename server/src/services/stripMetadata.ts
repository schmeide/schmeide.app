import type { FileType } from "../db/schema.ts";
import { DamagedFileError } from "./errors.ts";

const damaged: (what: string) => never = (what) => {
  throw new DamagedFileError(what);
};

const SOI = 0xd8;
const EOI = 0xd9;
const SOS = 0xda;
const APP0 = 0xe0;
const APP1 = 0xe1;
const APP2 = 0xe2;
const APP14 = 0xee;
const APP15 = 0xef;
const COM = 0xfe;
const EXIF_HEADER = Buffer.from("Exif\0\0", "latin1");
const ICC_HEADER = Buffer.from("ICC_PROFILE\0", "latin1");
const ORIENTATION_TAG = 0x0112;
const SHORT = 3;

const startsWith = (bytes: Buffer, prefix: Buffer): boolean =>
  bytes.subarray(0, prefix.length).equals(prefix);

const isRestart = (marker: number): boolean => marker >= 0xd0 && marker <= 0xd7;

const keepsJpegSegment = (marker: number, payload: Buffer): boolean => {
  if (marker === COM) return false;
  if (marker < APP0 || marker > APP15) return true;
  return (
    marker === APP0 || marker === APP14 || (marker === APP2 && startsWith(payload, ICC_HEADER))
  );
};

export const exifOrientation = (payload: Buffer): number | undefined => {
  if (!startsWith(payload, EXIF_HEADER)) return undefined;
  const tiff = payload.subarray(EXIF_HEADER.length);
  const order = tiff.subarray(0, 2).toString("latin1");
  if (tiff.length < 8 || (order !== "II" && order !== "MM")) return undefined;
  const little = order === "II";
  const u16 = (at: number) => (little ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at));
  const u32 = (at: number) => (little ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at));
  const ifd = u32(4);
  if (ifd + 2 > tiff.length) return undefined;
  const entries = Array.from({ length: u16(ifd) }, (_, index) => ifd + 2 + index * 12);
  const entry = entries.find((at) => at + 12 <= tiff.length && u16(at) === ORIENTATION_TAG);
  if (entry === undefined || u16(entry + 2) !== SHORT) return undefined;
  const value = u16(entry + 8);
  return value >= 1 && value <= 8 ? value : undefined;
};

export const orientationSegment = (orientation: number): Buffer =>
  Buffer.concat([
    Buffer.from([0xff, APP1, 0x00, 34]),
    EXIF_HEADER,
    Buffer.from([0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08]),
    Buffer.from([0x00, 0x01]),
    Buffer.from([0x01, 0x12, 0x00, SHORT, 0x00, 0x00, 0x00, 0x01, 0x00, orientation, 0x00, 0x00]),
    Buffer.from([0x00, 0x00, 0x00, 0x00]),
  ]);

const endOfScan = (bytes: Buffer, from: number): number => {
  for (let at = bytes.indexOf(0xff, from); at !== -1; at = bytes.indexOf(0xff, at + 1)) {
    const next = bytes[at + 1];
    if (next === undefined) break;
    if (next !== 0x00 && next !== 0xff && !isRestart(next)) return at;
  }
  return damaged("The picture ends in the middle of its image data");
};

export const stripJpeg = (bytes: Buffer): Buffer => {
  if (bytes[0] !== 0xff || bytes[1] !== SOI) damaged("Not a JPEG picture");
  const parts: Buffer[] = [bytes.subarray(0, 2)];
  let orientationKept = false;
  let at = 2;
  for (;;) {
    if (at + 2 > bytes.length || bytes[at] !== 0xff) damaged("The picture has a broken section");
    const marker = bytes[at + 1];
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    if (marker === EOI) return Buffer.concat([...parts, bytes.subarray(at, at + 2)]);
    if (marker === 0x01 || isRestart(marker)) {
      parts.push(bytes.subarray(at, at + 2));
      at += 2;
      continue;
    }
    if (at + 4 > bytes.length) damaged("The picture has a broken section");
    const length = bytes.readUInt16BE(at + 2);
    const end = at + 2 + length;
    if (length < 2 || end > bytes.length) damaged("The picture has a broken section");
    const payload = bytes.subarray(at + 4, end);
    if (keepsJpegSegment(marker, payload)) {
      parts.push(bytes.subarray(at, end));
    } else if (marker === APP1 && !orientationKept) {
      const orientation = exifOrientation(payload);
      if (orientation !== undefined && orientation !== 1) {
        parts.push(orientationSegment(orientation));
        orientationKept = true;
      }
    }
    at = end;
    if (marker === SOS) {
      const stop = endOfScan(bytes, at);
      parts.push(bytes.subarray(at, stop));
      at = stop;
    }
  }
};

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const PNG_KEPT: ReadonlySet<string> = new Set([
  "IHDR",
  "PLTE",
  "IDAT",
  "IEND",
  "tRNS",
  "gAMA",
  "cHRM",
  "sRGB",
  "iCCP",
  "cICP",
  "sBIT",
  "bKGD",
  "pHYs",
  "hIST",
  "sPLT",
  "acTL",
  "fcTL",
  "fdAT",
]);

export const stripPng = (bytes: Buffer): Buffer => {
  if (!startsWith(bytes, PNG_SIGNATURE)) damaged("Not a PNG picture");
  const parts: Buffer[] = [PNG_SIGNATURE];
  let at = PNG_SIGNATURE.length;
  while (at + 12 <= bytes.length) {
    const end = at + 12 + bytes.readUInt32BE(at);
    const type = bytes.subarray(at + 4, at + 8).toString("latin1");
    if (end > bytes.length) break;
    if (at === PNG_SIGNATURE.length && type !== "IHDR") break;
    if (PNG_KEPT.has(type)) parts.push(bytes.subarray(at, end));
    if (type === "IEND") return Buffer.concat(parts);
    at = end;
  }
  return damaged("The picture has a broken section");
};

const WEBP_KEPT: ReadonlySet<string> = new Set([
  "VP8 ",
  "VP8L",
  "VP8X",
  "ALPH",
  "ANIM",
  "ANMF",
  "ICCP",
]);
const WEBP_IMAGE: ReadonlySet<string> = new Set(["VP8 ", "VP8L", "ANMF"]);
const VP8X_EXIF = 0x08;
const VP8X_XMP = 0x04;

export const isWebp = (bytes: Buffer): boolean =>
  bytes.length >= 12 &&
  bytes.subarray(0, 4).toString("latin1") === "RIFF" &&
  bytes.subarray(8, 12).toString("latin1") === "WEBP";

const withoutMetadataFlags = (chunk: Buffer): Buffer => {
  if (chunk.length < 9) return damaged("The picture has a broken section");
  const copy = Buffer.from(chunk);
  copy[8] = copy[8] & ~(VP8X_EXIF | VP8X_XMP);
  return copy;
};

export const stripWebp = (bytes: Buffer): Buffer => {
  if (!isWebp(bytes)) damaged("Not a WebP picture");
  const limit = 8 + bytes.readUInt32LE(4);
  if (limit > bytes.length) damaged("The picture is cut short");
  const parts: Buffer[] = [];
  let hasImage = false;
  let at = 12;
  while (at + 8 <= limit) {
    const type = bytes.subarray(at, at + 4).toString("latin1");
    const size = bytes.readUInt32LE(at + 4);
    const end = at + 8 + size;
    if (end > limit) damaged("The picture has a broken section");
    if (WEBP_KEPT.has(type)) {
      const chunk = bytes.subarray(at, end);
      parts.push(type === "VP8X" ? withoutMetadataFlags(chunk) : chunk);
      if (size % 2 === 1) parts.push(Buffer.alloc(1));
      hasImage = hasImage || WEBP_IMAGE.has(type);
    }
    at = end + (size % 2);
  }
  if (!hasImage) damaged("The picture holds no image data");
  const body = Buffer.concat(parts);
  const header = Buffer.alloc(12);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(4 + body.length, 4);
  header.write("WEBP", 8, "latin1");
  return Buffer.concat([header, body]);
};

export const stripMetadata = (type: FileType, bytes: Buffer): Buffer => {
  switch (type) {
    case "jpeg":
      return stripJpeg(bytes);
    case "png":
      return stripPng(bytes);
    case "webp":
      return stripWebp(bytes);
    default:
      return bytes;
  }
};
