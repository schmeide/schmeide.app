import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const html = readFileSync(resolve(__dirname, "../../index.html"), "utf8");
const publicFile = (name: string) => resolve(__dirname, "../../public", name);
const meta = (key: string) =>
  new RegExp(`<meta\\s+(?:name|property)="${key}"\\s+content="([^"]*)"`).exec(html)?.[1];

const title = "Schmeide: software for your small business, built and run for you";
const description =
  "Schmeide builds software for small businesses. We ask questions, show you designs, build only what you approve, and keep it running.";

describe("index.html head", () => {
  it("has a real title and description", () => {
    expect(html).toContain(`<title>${title}</title>`);
    expect(meta("description")).toBe(description);
  });

  it("has Open Graph tags", () => {
    expect(meta("og:title")).toBe(title);
    expect(meta("og:description")).toBe(description);
    expect(meta("og:image")).toBe("https://schmeide.app/og.png");
    expect(meta("og:image:alt")).toBeTruthy();
  });

  it("has Twitter tags with a large image", () => {
    expect(meta("twitter:card")).toBe("summary_large_image");
    expect(meta("twitter:title")).toBe(title);
    expect(meta("twitter:description")).toBe(description);
    expect(meta("twitter:image")).toBe("https://schmeide.app/og.png");
  });

  it("ships the self-hosted social image", () => {
    expect(readFileSync(publicFile("og.png")).subarray(1, 4).toString()).toBe("PNG");
  });
});

describe("robots.txt", () => {
  it("turns every crawler away", () => {
    expect(readFileSync(publicFile("robots.txt"), "utf8")).toBe("User-agent: *\nDisallow: /\n");
  });
});
