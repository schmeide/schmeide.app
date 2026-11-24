import { createElement } from "react";

import { copy } from "../data/copy";
import type { PlannedFeature } from "../trpc";
import { parseMarkdown, type Block } from "../utils/markdown";
import { CheckWords } from "./CheckWords";

import styles from "./Step.module.css";
import specStyles from "./Spec.module.css";

// Renders **bold** runs; everything else is plain text.
const inline = (text: string) =>
  text
    .split(/\*\*(.+?)\*\*/)
    .map((part, index) => (index % 2 ? <strong key={index}>{part}</strong> : part));

// The list under the "Features" heading, which the checks are written one entry per item for.
const featuresList = (blocks: readonly Block[]): number =>
  blocks.findIndex(
    (block, index) =>
      block.kind === "list" &&
      [...blocks.slice(0, index)]
        .reverse()
        .find((before) => before.kind === "heading")
        ?.text.trim()
        .toLowerCase() === "features"
  );

// A feature's acceptance checks, folded away under "How we will know it works".
function HowWeWillKnow({ feature }: { readonly feature: PlannedFeature }) {
  return (
    <details className={specStyles.checks}>
      <summary>{copy.project.specChecks.title}</summary>
      <ol className={specStyles.checkList}>
        {feature.checks.map((check) => (
          <li key={check.id}>
            <CheckWords given={check.given} steps={check.steps} expect={check.expect} />
          </li>
        ))}
      </ol>
    </details>
  );
}

type Props = {
  readonly source: string;
  // The acceptance checks of each feature (#357), shown under the feature they belong to. When
  // they cannot be matched to the spec's list of features, they follow the spec.
  readonly checks?: readonly PlannedFeature[];
};

// A spec's markdown, readably: headings (one level down, under the section's), lists, paragraphs.
export function Spec({ source, checks = [] }: Props) {
  const blocks = parseMarkdown(source);
  const listIndex = featuresList(blocks);
  const list = blocks[listIndex];
  const matched = list?.kind === "list" && list.items.length === checks.length;
  return (
    <div className={styles.spec}>
      {blocks.map((block, index) => {
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
                <li key={itemIndex}>
                  {inline(item)}
                  {matched && index === listIndex && <HowWeWillKnow feature={checks[itemIndex]} />}
                </li>
              ))}
            </ul>
          );
        }
        return <p key={index}>{inline(block.text)}</p>;
      })}
      {!matched && checks.length > 0 && (
        <>
          <h3>{copy.project.specChecks.listTitle}</h3>
          <ul>
            {checks.map((feature) => (
              <li key={feature.number}>
                {feature.name}
                <HowWeWillKnow feature={feature} />
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
