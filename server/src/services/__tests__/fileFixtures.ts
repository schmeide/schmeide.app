import { crc32, deflateRawSync, deflateSync } from "node:zlib";

const u16be = (value: number): Buffer => {
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16BE(value);
  return bytes;
};
const u32be = (value: number): Buffer => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
};
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

export const JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wAARCAAIAAgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDN0Pwb9391+lFFFFOcuUvKsyxP1Ze8f//Z",
  "base64"
);
export const PROGRESSIVE_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wgARCAAIAAgDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAT/xAAVAQEBAAAAAAAAAAAAAAAAAAAAAf/aAAwDAQACEAMQAAABmC//xAAWEAADAAAAAAAAAAAAAAAAAAAAAwT/2gAIAQEAAQUCRGf/xAAYEQACAwAAAAAAAAAAAAAAAAAABAMTMf/aAAgBAwEBPwFVmSvT/8QAFxEBAAMAAAAAAAAAAAAAAAAAAQACEf/aAAgBAgEBPwGq5P/EABUQAQEAAAAAAAAAAAAAAAAAAAAx/9oACAEBAAY/Ao//xAAVEAEBAAAAAAAAAAAAAAAAAAAAMf/aAAgBAQABPyGJ/9oADAMBAAIAAwAAABAH/8QAFREBAQAAAAAAAAAAAAAAAAAAABH/2gAIAQMBAT8Qln//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/ECf/xAAVEAEBAAAAAAAAAAAAAAAAAAAA8f/aAAgBAQABPxCC/9k=",
  "base64"
);

export const jpegSegment = (marker: number, payload: Buffer): Buffer =>
  Buffer.concat([Buffer.from([0xff, marker]), u16be(payload.length + 2), payload]);

const ascii = (text: string): Buffer => Buffer.from(text, "latin1");

type TiffEntry = { readonly tag: number; readonly type: number; readonly value: Buffer };

export const exifPayload = (orientation: number): Buffer => {
  const camera = ascii("SecretCam 3000\0\0");
  const entries: readonly TiffEntry[] = [
    { tag: 0x010f, type: 2, value: u32le(8 + 2 + 3 * 12 + 4) },
    { tag: 0x0112, type: 3, value: Buffer.concat([u16le(orientation), u16le(0)]) },
    { tag: 0x8825, type: 4, value: u32le(8 + 2 + 3 * 12 + 4 + camera.length) },
  ];
  const directory = Buffer.concat([
    u16le(entries.length),
    ...entries.map(({ tag, type, value }, index) =>
      Buffer.concat([u16le(tag), u16le(type), u32le(index === 0 ? camera.length : 1), value])
    ),
    u32le(0),
  ]);
  const gps = Buffer.concat([
    u16le(1),
    u16le(0x0001),
    u16le(2),
    u32le(2),
    ascii("N\0\0\0"),
    u32le(0),
    ascii("GPS 52.5200 13.4050"),
  ]);
  return Buffer.concat([
    ascii("Exif\0\0"),
    ascii("II"),
    u16le(42),
    u32le(8),
    directory,
    camera,
    gps,
  ]);
};

export const jpegWith = (jpeg: Buffer, ...segments: readonly Buffer[]): Buffer => {
  const afterHeader = 4 + jpeg.readUInt16BE(4);
  return Buffer.concat([jpeg.subarray(0, afterHeader), ...segments, jpeg.subarray(afterHeader)]);
};

export const pngChunk = (type: string, data: Buffer): Buffer => {
  const body = Buffer.concat([ascii(type), data]);
  return Buffer.concat([u32be(data.length), body, u32be(crc32(body))]);
};

export const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const PNG_IHDR = pngChunk(
  "IHDR",
  Buffer.concat([u32be(2), u32be(2), Buffer.from([8, 2, 0, 0, 0])])
);
export const PNG_IDAT = pngChunk(
  "IDAT",
  deflateSync(Buffer.from([0, 255, 0, 0, 0, 255, 0, 0, 0, 0, 255, 255, 255, 255]))
);
export const PNG_IEND = pngChunk("IEND", Buffer.alloc(0));

export const pngWith = (...chunks: readonly Buffer[]): Buffer =>
  Buffer.concat([PNG_HEAD, PNG_IHDR, ...chunks, PNG_IDAT, PNG_IEND]);
export const PNG = pngWith();

export const WEBP = Buffer.from(
  "UklGRiwAAABXRUJQVlA4TCAAAAAvB8ABALmM6H/sClGIgvc/ICQgLPF/qObAeERMANjeAA==",
  "base64"
);
export const WEBP_IMAGE_CHUNK = WEBP.subarray(12);

export const riffChunk = (type: string, data: Buffer): Buffer =>
  Buffer.concat([ascii(type), u32le(data.length), data, Buffer.alloc(data.length % 2)]);

export const webpOf = (...chunks: readonly Buffer[]): Buffer => {
  const body = Buffer.concat(chunks);
  return Buffer.concat([ascii("RIFF"), u32le(4 + body.length), ascii("WEBP"), body]);
};

export const vp8x = (flags: number): Buffer =>
  riffChunk("VP8X", Buffer.from([flags, 0, 0, 0, 7, 0, 0, 7, 0, 0]));

export const PDF = Buffer.from(
  "%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n",
  "latin1"
);

type ZipPart = { readonly name: string; readonly data: Buffer; readonly stored?: boolean };

export const zipOf = (parts: readonly ZipPart[]): Buffer => {
  const packed = parts.map((part) => ({
    ...part,
    body: part.stored ? part.data : deflateRawSync(part.data),
  }));
  const offsets = packed.map((_, index) =>
    packed
      .slice(0, index)
      .reduce((total, part) => total + 30 + part.name.length + part.body.length, 0)
  );
  const shared = (part: (typeof packed)[number]) =>
    Buffer.concat([
      u16le(0),
      u16le(part.stored ? 0 : 8),
      u16le(0),
      u16le(0),
      u32le(crc32(part.data)),
      u32le(part.body.length),
      u32le(part.data.length),
      u16le(part.name.length),
      u16le(0),
    ]);
  const locals = packed.map((part) =>
    Buffer.concat([u32le(0x04034b50), u16le(20), shared(part), ascii(part.name), part.body])
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
      u32le(offsets[index]),
      ascii(part.name),
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

const xml = (text: string): Buffer => Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>${text}`);

const escapeXml = (text: string): string =>
  text.replace(/[&<>"]/g, (char) => `&#${char.charCodeAt(0)};`);

const columnName = (index: number): string => String.fromCharCode(65 + index);

export const xlsxOf = (
  rows: readonly (readonly (string | number)[])[],
  sheetName = "Clients"
): Buffer => {
  const strings = [...new Set(rows.flat().filter((cell) => typeof cell === "string"))];
  const sheet = rows
    .map(
      (row, at) =>
        `<row r="${at + 1}">${row
          .map((cell, column) =>
            typeof cell === "number"
              ? `<c r="${columnName(column)}${at + 1}"><v>${cell}</v></c>`
              : cell === ""
                ? `<c r="${columnName(column)}${at + 1}" s="1"/>`
                : `<c r="${columnName(column)}${at + 1}" t="s"><v>${strings.indexOf(cell)}</v></c>`
          )
          .join("")}</row>`
    )
    .join("");
  return zipOf([
    {
      name: "[Content_Types].xml",
      data: xml('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),
    },
    {
      name: "xl/workbook.xml",
      data: xml(
        `<workbook><sheets><sheet name="${escapeXml(sheetName)}" sheetId="1" r:id="rId7"/><sheet name="Other" sheetId="2" r:id="rId8"/></sheets></workbook>`
      ),
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      stored: true,
      data: xml(
        '<Relationships><Relationship Id="rId8" Target="worksheets/sheet1.xml"/><Relationship Id="rId7" Target="worksheets/first.xml"/></Relationships>'
      ),
    },
    {
      name: "xl/sharedStrings.xml",
      data: xml(
        `<sst>${strings.map((text) => `<si><t xml:space="preserve">${escapeXml(text)}</t></si>`).join("")}</sst>`
      ),
    },
    {
      name: "xl/worksheets/sheet1.xml",
      data: xml(
        '<worksheet><sheetData><row r="1"><c r="A1"><v>999</v></c></row></sheetData></worksheet>'
      ),
    },
    {
      name: "xl/worksheets/first.xml",
      data: xml(
        `<worksheet><cols><col min="1" max="1"/></cols><sheetData>${sheet}</sheetData></worksheet>`
      ),
    },
  ]);
};
