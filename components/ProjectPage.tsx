import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { copy } from "../data/copy";
import { POLL_MS, useTRPC, type ProjectStatus } from "../trpc";
import { BuildStep } from "./BuildStep";
import { ErrorNote } from "./ErrorNote";
import { FeaturesStep } from "./FeaturesStep";
import { LiveStep } from "./LiveStep";
import { ProjectActions } from "./ProjectActions";
import { SpecStep } from "./SpecStep";

import styles from "./ProjectPage.module.css";

const AFTER_BUILD: readonly ProjectStatus[] = ["live", "failed", "stopped"];

// One project, walked through in order: features, spec, build, the live app.
export function ProjectPage({ id }: { readonly id: number }) {
  const trpc = useTRPC();
  const [editingFeatures, setEditingFeatures] = useState(false);
  // The updatedAt of a live project the owner asked to take offline; polled until it changes.
  const [stoppingAt, setStoppingAt] = useState<number | null>(null);
  const query = useQuery(
    trpc.projects.get.queryOptions(
      { id },
      {
        refetchInterval: ({ state }) => {
          const project = state.data?.project;
          const busy =
            project?.status === "spec_generating" ||
            project?.status === "building" ||
            state.data?.latestBuild?.status === "running" ||
            (project?.status === "live" && project.updatedAt.getTime() === stoppingAt);
          return busy ? POLL_MS : false;
        },
      }
    )
  );
  const status = query.data?.project.status;
  // A spec run that ends back in draft failed; remember that until the status moves on.
  const [seen, setSeen] = useState({ status, specFailed: false });
  if (status !== seen.status) {
    setSeen({ status, specFailed: seen.status === "spec_generating" && status === "draft" });
  }

  const back = (
    <a href="#/" className={styles.back}>
      {copy.project.back}
    </a>
  );
  if (!query.data) {
    return (
      <>
        {back}
        {query.isPending ? <p>{copy.loading}</p> : <ErrorNote error={query.error} />}
      </>
    );
  }

  const { project, latestBuild, usage } = query.data;
  return (
    <article>
      {back}
      <h1 className={styles.title}>{project.name}</h1>
      <p role="status" className={styles.status} data-status={project.status}>
        <strong>
          {copy.project.statusPrefix} {copy.status[project.status].label}.
        </strong>{" "}
        {copy.status[project.status].hint}
      </p>
      {/* The live app comes first: it is what the owner came back for. */}
      {project.status === "live" && project.previewUrl && (
        <p className={styles.preview}>
          <a href={project.previewUrl} target="_blank" rel="noreferrer" className={styles.open}>
            {copy.project.open} <span className={styles.hint}>{copy.project.opensInNewTab}</span>
          </a>
          <span className={styles.muted}>{project.previewUrl}</span>
        </p>
      )}
      <ErrorNote error={query.error} />

      <FeaturesStep
        project={project}
        editing={editingFeatures}
        onEditingChange={setEditingFeatures}
        specFailed={seen.specFailed}
      />
      {(project.spec || project.status === "spec_generating") && (
        <SpecStep project={project} onChangeFeatures={() => setEditingFeatures(true)} />
      )}
      {latestBuild && <BuildStep key={latestBuild.id} build={latestBuild} />}
      {AFTER_BUILD.includes(project.status) && <LiveStep project={project} usage={usage} />}
      <ProjectActions project={project} onStop={() => setStoppingAt(project.updatedAt.getTime())} />
    </article>
  );
}
