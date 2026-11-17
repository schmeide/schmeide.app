import { describe, expect, it } from "vitest";
import { DamagedFileError } from "../errors.ts";
import {
  exifOrientation,
  orientationSegment,
  stripJpeg,
  stripMetadata,
  stripPng,
  stripWebp,
} from "../stripMetadata.ts";
import {
  JPEG,
  PDF,
  PNG,
  PROGRESSIVE_JPEG,
  WEBP,
  WEBP_IMAGE_CHUNK,
  exifPayload,
  jpegSegment,
  jpegWith,
  pngChunk,
  pngWith,
  riffChunk,
  vp8x,
  webpOf,
} from "./fileFixtures.ts";

const text = (value: string) => Buffer.from(value, "latin1");

const EXIF = jpegSegment(0xe1, exifPayload(1));
const XMP = jpegSegment(
  0xe1,
  text("http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>Ada Example, Berlin</x:xmpmeta>")
);
const IPTC = jpegSegment(0xed, text("Photoshop 3.0\x008BIM Ada Example"));
const MPF = jpegSegment(0xe2, text("MPF\0II*\0 second picture"));
const MAKER = jpegSegment(0xe5, text("vendor block with a serial number 12345"));
const COMMENT = jpegSegment(0xfe, text("taken at home"));
const ICC = jpegSegment(0xe2, text("ICC_PROFILE\0\x01\x01 colour profile"));
const ADOBE = jpegSegment(0xee, text("Adobe\0d\0\0\0\0\x01"));

describe("stripJpeg", () => {
  it("leaves a picture without metadata exactly as it was", () => {
    expect(stripJpeg(JPEG).equals(JPEG)).toBe(true);
    expect(stripJpeg(PROGRESSIVE_JPEG).equals(PROGRESSIVE_JPEG)).toBe(true);
  });

  it("removes location, device, author, and comment sections and nothing else", () => {
    const loaded = jpegWith(JPEG, EXIF, XMP, IPTC, MPF, MAKER, COMMENT);
    expect(loaded.includes("SecretCam")).toBe(true);
    expect(loaded.includes("GPS 52.5200")).toBe(true);

    const stripped = stripJpeg(loaded);

    expect(stripped.equals(JPEG)).toBe(true);
  });

  it("removes them from a picture stored in several scans", () => {
    const stripped = stripJpeg(jpegWith(PROGRESSIVE_JPEG, EXIF, COMMENT, XMP));

    expect(stripped.equals(PROGRESSIVE_JPEG)).toBe(true);
  });

  it("keeps what the picture needs to look right: colour profile and colour transform", () => {
    const stripped = stripJpeg(jpegWith(JPEG, EXIF, ICC, ADOBE, COMMENT));

    expect(stripped.equals(jpegWith(JPEG, ICC, ADOBE))).toBe(true);
  });

  it("keeps which way up the picture is, and nothing else from the camera", () => {
    const sideways = jpegWith(JPEG, jpegSegment(0xe1, exifPayload(6)), XMP);

    const stripped = stripJpeg(sideways);

    expect(stripped.equals(jpegWith(JPEG, orientationSegment(6)))).toBe(true);
    expect(exifOrientation(stripped.subarray(JPEG.readUInt16BE(4) + 8))).toBe(6);
    expect(stripped.includes("SecretCam")).toBe(false);
    expect(stripped.includes("GPS")).toBe(false);
  });

  it("drops whatever follows the end of the picture, such as a second picture with its own details", () => {
    const stripped = stripJpeg(Buffer.concat([JPEG, jpegWith(JPEG, EXIF), text("trailer")]));

    expect(stripped.equals(JPEG)).toBe(true);
  });

  it.each([
    ["cut off in its image data", JPEG.subarray(0, JPEG.length - 2)],
    ["cut off in a section", JPEG.subarray(0, 40)],
    ["not a JPEG", PNG],
    [
      "a section longer than the file",
      Buffer.concat([JPEG.subarray(0, 2), text("\xff\xe1\xff\xff")]),
    ],
  ])("refuses a picture that is %s", (_, bytes) => {
    expect(() => stripJpeg(bytes)).toThrow(DamagedFileError);
  });
});

const GAMMA = pngChunk("gAMA", Buffer.from([0, 0, 0xb1, 0x8f]));
const TRANSPARENCY = pngChunk("tRNS", Buffer.from([0, 0, 0, 0, 0, 0]));

describe("stripPng", () => {
  it("leaves a picture without metadata exactly as it was", () => {
    expect(stripPng(PNG).equals(PNG)).toBe(true);
  });

  it("removes text, camera details, and the time, and keeps what the picture needs", () => {
    const loaded = pngWith(
      GAMMA,
      pngChunk("tEXt", text("Author\0Ada Example")),
      pngChunk("iTXt", text("XML:com.adobe.xmp\0\0\0\0\0<x:xmpmeta>Berlin</x:xmpmeta>")),
      pngChunk("zTXt", text("Comment\0\0compressed")),
      pngChunk("eXIf", exifPayload(1).subarray(6)),
      pngChunk("tIME", Buffer.from([7, 0xea, 11, 16, 9, 30, 0])),
      pngChunk("prVt", text("a vendor's own block")),
      TRANSPARENCY
    );

    const stripped = stripPng(loaded);

    expect(stripped.equals(pngWith(GAMMA, TRANSPARENCY))).toBe(true);
    expect(stripped.includes("Ada Example")).toBe(false);
    expect(stripped.includes("SecretCam")).toBe(false);
  });

  it("drops whatever follows the end of the picture", () => {
    expect(stripPng(Buffer.concat([PNG, text("GPS 52.5200 13.4050")])).equals(PNG)).toBe(true);
  });

  it.each([
    ["cut off", PNG.subarray(0, PNG.length - 6)],
    ["missing its header", Buffer.concat([PNG.subarray(0, 8), PNG.subarray(33)])],
    ["not a PNG", JPEG],
  ])("refuses a picture that is %s", (_, bytes) => {
    expect(() => stripPng(bytes)).toThrow(DamagedFileError);
  });
});

const ICC_FLAG = 0x20;
const EXIF_FLAG = 0x08;
const XMP_FLAG = 0x04;
const PROFILE = riffChunk("ICCP", text("colour profile"));

describe("stripWebp", () => {
  it("leaves a picture without metadata exactly as it was", () => {
    expect(stripWebp(WEBP).equals(WEBP)).toBe(true);
  });

  it("removes camera details and descriptions, clears their flags, and keeps the image", () => {
    const loaded = webpOf(
      vp8x(ICC_FLAG | EXIF_FLAG | XMP_FLAG),
      PROFILE,
      WEBP_IMAGE_CHUNK,
      riffChunk("EXIF", exifPayload(1)),
      riffChunk("XMP ", text("<x:xmpmeta>Ada Example</x:xmpmeta>")),
      riffChunk("VNDR", text("odd"))
    );
    expect(loaded.includes("SecretCam")).toBe(true);

    const stripped = stripWebp(loaded);

    expect(stripped.equals(webpOf(vp8x(ICC_FLAG), PROFILE, WEBP_IMAGE_CHUNK))).toBe(true);
    expect(stripped.readUInt32LE(4)).toBe(stripped.length - 8);
    expect(stripped.includes(WEBP_IMAGE_CHUNK)).toBe(true);
    expect(stripped.includes("SecretCam")).toBe(false);
    expect(stripped.includes("Ada Example")).toBe(false);
  });

  it("drops whatever follows the end of the picture", () => {
    expect(stripWebp(Buffer.concat([WEBP, text("GPS 52.5200")])).equals(WEBP)).toBe(true);
  });

  it.each([
    ["cut off", WEBP.subarray(0, WEBP.length - 4)],
    ["without image data", webpOf(vp8x(EXIF_FLAG), riffChunk("EXIF", exifPayload(1)))],
    ["not a WebP", PNG],
  ])("refuses a picture that is %s", (_, bytes) => {
    expect(() => stripWebp(bytes)).toThrow(DamagedFileError);
  });
});

describe("stripMetadata", () => {
  it("strips each kind of picture and leaves other files alone", () => {
    expect(stripMetadata("jpeg", jpegWith(JPEG, EXIF)).equals(JPEG)).toBe(true);
    expect(stripMetadata("png", pngWith(pngChunk("tEXt", text("a\0b")))).equals(PNG)).toBe(true);
    expect(
      stripMetadata("webp", webpOf(vp8x(0), WEBP_IMAGE_CHUNK, riffChunk("EXIF", text("x")))).equals(
        webpOf(vp8x(0), WEBP_IMAGE_CHUNK)
      )
    ).toBe(true);
    expect(stripMetadata("pdf", PDF)).toBe(PDF);
  });
});
