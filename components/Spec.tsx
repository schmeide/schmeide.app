import { createElement } from "react";

import { parseMarkdown } from "../utils/markdown";

import styles from "./Step.module.css";

// Renders **bold** runs; everything else is plain text.
const inline = (text: string) =>
  text
    .split(/\*\*(.+?)\*\*/)
    .map((part, index) => (index % 2 ? <strong key={index}>{part}</strong> : part));

// A spec's markdown, readably: headings (one level down, under the section's), lists, paragraphs.
export function Spec({ source }: { readonly source: string }) {
  return (
    <div className={styles.spec}>
      {parseMarkdown(source).map((block, index) => {
        if (block.kind === "heading") {
          return createElement(
            `h${Math.min(block.level + 1, 6)}`,
            { key: index },
            inline(block.text)
          );
        }
        if (block.kind === "list") {
          return (
            <ul key={index}>
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex}>{inline(item)}</li>
              ))}
            </ul>
          );
        }
        return <p key={index}>{inline(block.text)}</p>;
      })}
    </div>
  );
}
