import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { copy } from "../data/copy";
import { POLL_MS, useTRPC, type ProjectStatus } from "../trpc";
import { classifyError } from "../utils/apiError";
import { pathTo } from "../utils/routes";
import { BuildStep } from "./BuildStep";
import { ErrorNote } from "./ErrorNote";
import { FeaturesStep } from "./FeaturesStep";
import { LiveStep } from "./LiveStep";
import { ProjectActions } from "./ProjectActions";
import { Link } from "./Link";
import { QueuedChanges } from "./QueuedChanges";
import { RouteProblem } from "./RouteProblem";
import { SiteStep } from "./SiteStep";
import { SpecStep } from "./SpecStep";

import styles from "./ProjectPage.module.css";

// A change can be requested once a build exists; while one runs, it waits in the queue.
const CHANGEABLE: readonly ProjectStatus[] = ["building", "live", "failed", "stopped"];

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

  // The tab is named after the project once it is known; until then it keeps the route's title.
  const name = query.data?.project.name;
  useEffect(() => {
    if (name) document.title = copy.pageTitle(name);
  }, [name]);

  const back = (
    <Link to={pathTo("apps")} className={styles.back}>
      {copy.project.back}
    </Link>
  );
  if (!query.data) {
    // A project of a business the person is not in.
    if (query.error && classifyError(query.error) === "forbidden") {
      return <RouteProblem kind="noAccess" />;
    }
    return (
      <>
        {back}
        {query.isPending ? <p>{copy.loading}</p> : <ErrorNote error={query.error} />}
      </>
    );
  }

  const { project, latestBuild, queued, hasIcon, usage } = query.data;
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
      <QueuedChanges queued={queued} />
      {CHANGEABLE.includes(project.status) && <LiveStep project={project} usage={usage} />}
      <SiteStep project={project} hasIcon={hasIcon} />
      <ProjectActions project={project} onStop={() => setStoppingAt(project.updatedAt.getTime())} />
    </article>
  );
}
