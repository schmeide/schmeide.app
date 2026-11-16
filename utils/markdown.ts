// Just enough markdown for a spec: headings, bullet or numbered lists, and paragraphs.
export type Block =
  | { readonly kind: "heading"; readonly level: number; readonly text: string }
  | { readonly kind: "list"; readonly items: readonly string[] }
  | { readonly kind: "paragraph"; readonly text: string };

const HEADING = /^(#{1,6})\s+(.*)$/;
const ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/;

export const parseMarkdown = (source: string): readonly Block[] =>
  source
    .split("\n")
    .reduce<readonly Block[]>((blocks, raw) => {
      const line = raw.trimEnd();
      const last = blocks.at(-1);
      const heading = HEADING.exec(line.trim());
      if (heading)
        return [...blocks, { kind: "heading", level: heading[1].length, text: heading[2] }];
      const item = ITEM.exec(line);
      if (item) {
        return last?.kind === "list"
          ? [...blocks.slice(0, -1), { kind: "list", items: [...last.items, item[1]] }]
          : [...blocks, { kind: "list", items: [item[1]] }];
      }
      if (!line.trim())
        return last && last.kind !== "heading"
          ? [...blocks, { kind: "paragraph", text: "" }]
          : blocks;
      return last?.kind === "paragraph" && last.text
        ? [...blocks.slice(0, -1), { kind: "paragraph", text: `${last.text} ${line.trim()}` }]
        : [...blocks, { kind: "paragraph", text: line.trim() }];
    }, [])
    .filter((block) => block.kind !== "paragraph" || block.text);
