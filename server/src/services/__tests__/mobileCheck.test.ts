import { describe, expect, it } from "vitest";
import { mobileProblems } from "../mobileCheck.ts";

const VIEWPORT = `<meta name="viewport" content="width=device-width, initial-scale=1.0" />`;
const page = (head: string) => `<!doctype html><html><head>${head}</head><body></body></html>`;
const CSS = ":root{--space:16px}body{margin:0;font-size:1rem}";

describe("mobileProblems", () => {
  it("finds nothing wrong with a phone-first build", () => {
    expect(
      mobileProblems({
        html: page(VIEWPORT),
        css: [
          `${CSS}.page{max-width:720px;width:100%}.grid{grid-template-columns:repeat(auto-fit,minmax(min(280px,100%),1fr))}`,
        ],
      })
    ).toEqual([]);
  });

  it("asks for a viewport tag when there is none or it does not follow the device", () => {
    expect(mobileProblems({ html: page(""), css: [CSS] })).toEqual([
      expect.stringContaining("width=device-width"),
    ]);
    expect(
      mobileProblems({ html: page(`<meta name="viewport" content="width=1024">`), css: [CSS] })
    ).toEqual([expect.stringContaining("width=device-width")]);
  });

  it.each([
    "width=device-width, user-scalable=no",
    "width=device-width, user-scalable=0",
    "width=device-width, initial-scale=1, maximum-scale=1",
  ])("refuses a viewport tag that blocks zoom: %s", (content) => {
    expect(
      mobileProblems({ html: page(`<meta content="${content}" name="viewport">`), css: [CSS] })
    ).toEqual([expect.stringContaining("zoom")]);
  });

  it("lets a viewport tag cap zoom at 2 or more", () => {
    expect(
      mobileProblems({
        html: page(`<meta name="viewport" content="width=device-width, maximum-scale=5">`),
        css: [CSS],
      })
    ).toEqual([]);
  });

  it("asks for a stylesheet when the build has none", () => {
    expect(mobileProblems({ html: page(VIEWPORT), css: [] })).toEqual([
      expect.stringContaining("no stylesheet"),
    ]);
    expect(mobileProblems({ html: page(VIEWPORT), css: ["  \n", "/* empty */"] })).toEqual([
      expect.stringContaining("no stylesheet"),
    ]);
  });

  it("counts a style block in the page as a stylesheet", () => {
    expect(mobileProblems({ html: page(`${VIEWPORT}<style>${CSS}</style>`), css: [] })).toEqual([]);
  });

  it("names each rule that is wider than a small phone", () => {
    const problems = mobileProblems({
      html: page(VIEWPORT),
      css: [`${CSS}.table{min-width:600px}.side{width:25rem;color:red}.icon{width:24px}`],
    });

    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain(".table");
    expect(problems[0]).toContain("min-width: 600px");
    expect(problems[1]).toContain(".side");
    expect(problems[1]).toContain("width: 25rem");
  });

  it("allows a fixed width that only applies on a wider screen, or is capped in the same rule", () => {
    expect(
      mobileProblems({
        html: page(VIEWPORT),
        css: [
          `${CSS}@media (min-width:768px){.side{width:400px}}` +
            `@media (width >= 48rem){.side{min-width:400px}}` +
            `@container (min-width:600px){.card{width:500px}}` +
            `.dialog{width:480px;max-width:100%}` +
            `.wide{width:min(600px,100%)}` +
            `.note::after{content:"{ width: 900px }"}`,
        ],
      })
    ).toEqual([]);
  });

  it("still names a fixed width inside a query that is not about width", () => {
    expect(
      mobileProblems({
        html: page(VIEWPORT),
        css: [`${CSS}@media (prefers-color-scheme:dark){.table{min-width:640px}}`],
      })
    ).toEqual([expect.stringContaining(".table")]);
  });

  it("lists at most ten fixed widths and says how many more there are", () => {
    const rules = Array.from({ length: 14 }, (_, index) => `.c${index}{width:500px}`).join("");

    const problems = mobileProblems({ html: page(VIEWPORT), css: [CSS + rules] });

    expect(problems).toHaveLength(11);
    expect(problems[10]).toContain("4 more");
  });
});
