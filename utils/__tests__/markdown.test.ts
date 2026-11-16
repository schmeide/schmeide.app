import { parseMarkdown } from "../markdown";

describe("parseMarkdown", () => {
  it("splits a spec into headings, lists, and paragraphs", () => {
    const spec =
      "## Features\n- Clients\n  - nested\n* Invoices\n\n## Notes\nPlain text\nmore text\n1. first";
    expect(parseMarkdown(spec)).toEqual([
      { kind: "heading", level: 2, text: "Features" },
      { kind: "list", items: ["Clients", "nested", "Invoices"] },
      { kind: "heading", level: 2, text: "Notes" },
      { kind: "paragraph", text: "Plain text more text" },
      { kind: "list", items: ["first"] },
    ]);
  });

  it("returns nothing for an empty spec", () => {
    expect(parseMarkdown("  \n")).toEqual([]);
  });
});
