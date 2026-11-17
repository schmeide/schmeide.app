import { createInflateRaw } from "node:zlib";
import { DamagedFileError } from "./errors.ts";

export type ZipEntry = {
  readonly name: string;
  readonly method: number;
  readonly compressedSize: number;
  readonly offset: number;
  readonly encrypted: boolean;
};

export const ZIP_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const END_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const END_SIZE = 22;
const MAX_COMMENT = 0xffff;
const MAX_ENTRIES = 10_000;
const STORED = 0;
const DEFLATED = 8;
const ZIP64 = 0xffffffff;

const damaged: (what: string) => never = (what) => {
  throw new DamagedFileError(what);
};

const endOfCentralDirectory = (bytes: Buffer): number => {
  const first = Math.max(0, bytes.length - END_SIZE - MAX_COMMENT);
  for (let at = bytes.length - END_SIZE; at >= first; at--) {
    if (bytes.readUInt32LE(at) === END_SIGNATURE) return at;
  }
  return damaged("The file has no table of contents");
};

export const zipEntries = (bytes: Buffer): readonly ZipEntry[] => {
  if (bytes.length < END_SIZE) damaged("The file is too short");
  const end = endOfCentralDirectory(bytes);
  const count = bytes.readUInt16LE(end + 10);
  const start = bytes.readUInt32LE(end + 16);
  if (start === ZIP64 || count === 0xffff) damaged("The file is too large to open");
  if (count > MAX_ENTRIES) damaged("The file holds too many parts");
  const entries: ZipEntry[] = [];
  let at = start;
  for (let index = 0; index < count; index++) {
    if (at + 46 > bytes.length || bytes.readUInt32LE(at) !== CENTRAL_SIGNATURE)
      damaged("The file's table of contents is broken");
    const nameLength = bytes.readUInt16LE(at + 28);
    const next = at + 46 + nameLength + bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32);
    if (next > bytes.length) damaged("The file's table of contents is broken");
    entries.push({
      name: bytes.subarray(at + 46, at + 46 + nameLength).toString("utf8"),
      method: bytes.readUInt16LE(at + 10),
      compressedSize: bytes.readUInt32LE(at + 20),
      offset: bytes.readUInt32LE(at + 42),
      encrypted: (bytes.readUInt16LE(at + 8) & 1) === 1,
    });
    at = next;
  }
  return entries;
};

const inflatePrefix = (data: Buffer, limit: number): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const inflate = createInflateRaw();
    const chunks: Buffer[] = [];
    let total = 0;
    const done = () => resolve(Buffer.concat(chunks).subarray(0, limit));
    inflate.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      total += chunk.length;
      if (total >= limit) {
        inflate.destroy();
        done();
      }
    });
    inflate.on("end", done);
    inflate.on("error", () => reject(new DamagedFileError("A part of the file is broken")));
    inflate.end(data);
  });

export const readZipEntry = async (
  bytes: Buffer,
  entry: ZipEntry,
  limit: number
): Promise<Buffer> => {
  if (entry.encrypted) damaged("The file is protected with a password");
  if (entry.compressedSize === ZIP64 || entry.offset === ZIP64)
    damaged("The file is too large to open");
  const at = entry.offset;
  if (at + 30 > bytes.length || bytes.readUInt32LE(at) !== LOCAL_SIGNATURE)
    damaged("A part of the file is missing");
  const start = at + 30 + bytes.readUInt16LE(at + 26) + bytes.readUInt16LE(at + 28);
  const end = start + entry.compressedSize;
  if (end > bytes.length) damaged("A part of the file is cut short");
  const data = bytes.subarray(start, end);
  if (entry.method === STORED) return data.subarray(0, limit);
  if (entry.method === DEFLATED) return inflatePrefix(data, limit);
  return damaged("A part of the file is packed in a way that cannot be opened");
};
