import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { photograph } from "../pictures.ts";

// Real Chromium, so only where `make doctor` would pass: `npx playwright install chromium`.
const installed = existsSync(chromium.executablePath());

// The width and height of a simple lossy (VP8), lossless (VP8L), or extended (VP8X) WebP.
const webpSize = (data: Buffer) => {
  expect(data.subarray(0, 4).toString()).toBe("RIFF");
  expect(data.subarray(8, 12).toString()).toBe("WEBP");
  const chunk = data.subarray(12, 16).toString();
  if (chunk === "VP8 ")
    return { width: data.readUInt16LE(26) & 0x3fff, height: data.readUInt16LE(28) & 0x3fff };
  if (chunk === "VP8L") {
    const bits = data.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X")
    return { width: data.readUIntLE(24, 3) + 1, height: data.readUIntLE(27, 3) + 1 };
  throw new Error(`Unexpected WebP chunk ${chunk}`);
};

describe.skipIf(!installed)("photograph", () => {
  let server: Server;
  let url: string;
  beforeAll(async () => {
    server = createServer((request, response) => {
      response.writeHead(request.url === "/" ? 200 : 401, { "content-type": "text/html" });
      response.end("<h1 style='color:teal'>Bakery</h1>");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise((resolve) => server.close(resolve)));

  it("answers a desktop and a phone WebP, no wider than 640 px", async () => {
    const pictures = await photograph(`${url}/`);
    expect(pictures.map(({ width, data }) => ({ width, size: webpSize(data) }))).toEqual([
      { width: "desktop", size: { width: 640, height: 400 } },
      { width: "phone", size: { width: 390, height: 844 } },
    ]);
  }, 60_000);

  it("refuses a page that does not answer 200", async () => {
    await expect(photograph(`${url}/private`)).rejects.toThrow(/answered 401/);
  }, 60_000);
});
