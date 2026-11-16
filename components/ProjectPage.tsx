import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { copy } from "../data/copy";
import { POLL_MS, useTRPC } from "../trpc";
import { classifyError } from "../utils/apiError";
import { pathTo } from "../utils/routes";
import { ErrorNote } from "./ErrorNote";
import { Link } from "./Link";
import { ProjectSetup } from "./ProjectSetup";
import { ProjectWorkspace, type ProjectView } from "./ProjectWorkspace";
import { RouteProblem } from "./RouteProblem";

import styles from "./ProjectPage.module.css";

type Props = { readonly id: number; readonly view?: ProjectView };

// One project, in one of two phases: setup (until its first build passes), then the app's home
// with its views. `view` only matters in the second.
export function ProjectPage({ id, view = "overview" }: Props) {
  const trpc = useTRPC();
  // The change being typed; kept here so it survives a move between the views.
  const [request, setRequest] = useState("");
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

  // A project that has been live stays in its home when a later change fails or it goes offline;
  // one whose first build has not passed yet is still being set up.
  const inApp = Boolean(query.data?.hasBeenLive) || status === "live" || status === "stopped";

  // The tab is named after the project once it is known; until then it keeps the route's title.
  const name = query.data?.project.name;
  useEffect(() => {
    if (!name) return;
    document.title = copy.pageTitle(
      inApp && view !== "overview" ? copy.project.viewTitle(copy.project.views[view], name) : name
    );
  }, [name, inApp, view]);

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

  const { project, latestBuild, queued, changes, hasIcon, usage } = query.data;
  const onStop = () => setStoppingAt(project.updatedAt.getTime());
  const hint =
    inApp && project.status === "building"
      ? copy.project.appBuildingHint
      : inApp && project.status === "failed"
        ? copy.project.appFailedHint
        : copy.status[project.status].hint;
  return (
    <article className={inApp ? styles.wide : undefined}>
      {back}
      <h1 className={styles.title}>{project.name}</h1>
      <p role="status" className={styles.status} data-status={project.status}>
        <strong>
          {copy.project.statusPrefix} {copy.status[project.status].label}.
        </strong>{" "}
        {hint}
      </p>
      <ErrorNote error={query.error} />
      {inApp ? (
        <ProjectWorkspace
          view={view}
          project={project}
          latestBuild={latestBuild}
          queued={queued}
          changes={changes}
          hasIcon={hasIcon}
          usage={usage}
          request={request}
          onRequestChange={setRequest}
          onStop={onStop}
        />
      ) : (
        <ProjectSetup
          project={project}
          latestBuild={latestBuild}
          specFailed={seen.specFailed}
          request={request}
          onRequestChange={setRequest}
          onStop={onStop}
        />
      )}
    </article>
  );
}
