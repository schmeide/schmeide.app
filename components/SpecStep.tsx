import { useMutation } from "@tanstack/react-query";
import { createElement } from "react";

import { copy } from "../data/copy";
import { useRefreshProjects, useTRPC, type Project } from "../trpc";
import { parseMarkdown } from "../utils/markdown";
import { ErrorNote } from "./ErrorNote";

import styles from "./Step.module.css";

// Renders **bold** runs; everything else is plain text.
const inline = (text: string) =>
  text
    .split(/\*\*(.+?)\*\*/)
    .map((part, index) => (index % 2 ? <strong key={index}>{part}</strong> : part));

function Spec({ source }: { readonly source: string }) {
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

type Props = { readonly project: Project; readonly onChangeFeatures: () => void };

export function SpecStep({ project, onChangeFeatures }: Props) {
  const trpc = useTRPC();
  const refresh = useRefreshProjects();
  const approve = useMutation(
    trpc.projects.approveSpec.mutationOptions({ onSettled: () => refresh() })
  );

  return (
    <section aria-labelledby="spec" className={styles.step}>
      <h2 id="spec">{copy.project.specTitle}</h2>
      {project.status === "spec_generating" && <p>{copy.project.specWriting}</p>}
      {project.status === "spec_ready" && project.spec && (
        <>
          <p className={styles.muted}>{copy.project.specIntro}</p>
          <Spec source={project.spec} />
          <div className={styles.actions}>
            <button
              type="button"
              data-variant="primary"
              onClick={() => approve.mutate({ id: project.id })}
              disabled={approve.isPending}
            >
              {approve.isPending ? copy.project.approving : copy.project.approve}
            </button>
            <button type="button" onClick={onChangeFeatures} disabled={approve.isPending}>
              {copy.project.changeFeatures}
            </button>
          </div>
          <ErrorNote error={approve.error} />
        </>
      )}
      {project.status !== "spec_ready" && project.spec && (
        <details>
          <summary>{copy.project.builtFrom}</summary>
          <Spec source={project.spec} />
        </details>
      )}
    </section>
  );
}
