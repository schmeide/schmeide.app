import { describe, expect, it } from "vitest";
import { ICON_MAX_BYTES, iconType, siteSchema, withSite } from "../site.ts";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const ICO = Buffer.from("0000010001001010000001002000", "hex");
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Notes</title>
  </head>
  <body></body>
</html>
`;

describe("iconType", () => {
  it("knows PNG and ICO by their bytes, and nothing else", () => {
    expect(iconType(PNG)).toBe("png");
    expect(iconType(ICO)).toBe("ico");
    expect(iconType(SVG)).toBeUndefined();
    expect(iconType(Buffer.from("GIF89a"))).toBeUndefined();
    expect(iconType(Buffer.alloc(0))).toBeUndefined();
  });
});

describe("siteSchema", () => {
  const parse = (input: Record<string, unknown>) => siteSchema.safeParse({ id: 1, ...input });

  it("trims the title and caps its length", () => {
    expect(parse({ title: "  Invoices  " }).data?.title).toBe("Invoices");
    expect(parse({ title: "x".repeat(101) }).success).toBe(false);
  });

  it("takes a PNG or ICO icon, null to remove it, or none to keep it", () => {
    expect(parse({ title: "", icon: PNG.toString("base64") }).success).toBe(true);
    expect(parse({ title: "", icon: ICO.toString("base64") }).success).toBe(true);
    expect(parse({ title: "", icon: null }).data?.icon).toBeNull();
    expect(parse({ title: "" }).data?.icon).toBeUndefined();
  });

  it("refuses an SVG named .png, a file that is too big, and text that is not base64", () => {
    expect(parse({ title: "", icon: SVG.toString("base64") }).success).toBe(false);
    const big = Buffer.concat([PNG, Buffer.alloc(ICON_MAX_BYTES)]);
    expect(parse({ title: "", icon: big.toString("base64") }).success).toBe(false);
    expect(parse({ title: "", icon: "not base64!" }).success).toBe(false);
  });
});

describe("withSite", () => {
  it("escapes the title", () => {
    const html = withSite(HTML, `</title><script>alert("x")</script> & $1 'q'`, undefined);
    expect(html).toContain(
      "<title>&lt;/title&gt;&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; $1 &#39;q&#39;</title>"
    );
    expect(html).not.toContain("<script>");
  });

  it("adds a title when the page has none", () => {
    expect(withSite("<html><head></head></html>", "Mine", undefined)).toContain(
      "<title>Mine</title>"
    );
  });

  it("links the icon in place of any other, and takes only its own link away again", () => {
    const own = HTML.replace("</head>", '<link rel="icon" href="/vite.svg" />\n  </head>');

    const linked = withSite(own, "Notes", "png");
    expect(linked).toContain('<link rel="icon" type="image/png" href="/site-icon.png" />');
    expect(linked).not.toContain("vite.svg");
    expect(withSite(linked, "Notes", "ico").match(/rel="icon"/g)).toHaveLength(1);

    expect(withSite(linked, "Notes", undefined)).toBe(HTML);
    expect(withSite(own, "Notes", undefined)).toBe(own);
  });
});
