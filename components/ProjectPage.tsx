import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { copy } from "../data/copy";
import { POLL_MS, useTRPC, type Build, type Project } from "../trpc";
import { classifyError } from "../utils/apiError";
import { pathTo } from "../utils/routes";
import { appName } from "../utils/appName";
import { ErrorNote } from "./ErrorNote";
import { Link } from "./Link";
import { ProjectSetup } from "./ProjectSetup";
import { ProjectWorkspace, type ProjectView } from "./ProjectWorkspace";
import { useDraft } from "./useDraft";
import { NotFoundPage } from "./NotFoundPage";
import { Working } from "./Working";

import styles from "./ProjectPage.module.css";

type Props = { readonly id: number; readonly view?: ProjectView };

// The page polls, and its status line shows a spinner, while the server is working on the project.
const isWorking = (
  project: Project | undefined,
  latestBuild: Build | null | undefined,
  stoppingAt: number | null
) =>
  project?.status === "spec_generating" ||
  project?.status === "building" ||
  latestBuild?.status === "running" ||
  (project?.status === "live" && project.updatedAt.getTime() === stoppingAt);

// One project, in one of two phases: setup (until its first build passes), then the app's home
// with its views. `view` only matters in the second.
export function ProjectPage({ id, view = "overview" }: Props) {
  const trpc = useTRPC();
  // The change being typed; kept here so it survives a move between the views, and as a draft so
  // it survives the page giving way.
  const [request, setRequest] = useDraft(`change:${id}`);
  // The updatedAt of a live project the owner asked to take offline; polled until it changes.
  const [stoppingAt, setStoppingAt] = useState<number | null>(null);
  const query = useQuery(
    trpc.projects.get.queryOptions(
      { id },
      {
        refetchInterval: ({ state }) =>
          isWorking(state.data?.project, state.data?.latestBuild, stoppingAt) ? POLL_MS : false,
      }
    )
  );
  const status = query.data?.project.status;

  // A project that has been live stays in its home when a later change fails or it goes offline;
  // one whose first build has not passed yet is still being set up.
  const inApp = Boolean(query.data?.hasBeenLive) || status === "live" || status === "stopped";

  // The tab is named after the project once it is known; until then it keeps the route's title.
  const name = query.data && appName(query.data.project);
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
    // Gone, or of a business the person is not in: the same page, so neither says which.
    const problem = query.error && classifyError(query.error);
    if (problem === "notFound" || problem === "forbidden") return <NotFoundPage />;
    return (
      <>
        {back}
        {query.isPending ? <p>{copy.loading}</p> : <ErrorNote error={query.error} />}
      </>
    );
  }

  const {
    project,
    latestBuild,
    latestBuildBy,
    queued,
    unreleased,
    changes,
    hasIcon,
    usage,
    time,
    liveVersion,
    workingVersion,
  } = query.data;
  const onStop = () => setStoppingAt(project.updatedAt.getTime());
  // The project stays `failed` so a retry still starts, but a cancel is not a failure.
  const canceled = latestBuild?.status === "canceled";
  const hint = canceled
    ? copy.project.canceledHint
    : inApp && project.status === "building"
      ? copy.project.appBuildingHint
      : inApp && project.status === "failed"
        ? copy.project.appFailedHint
        : copy.status[project.status].hint;
  const label = canceled ? copy.project.buildStatus.canceled : copy.status[project.status].label;
  return (
    <article className={inApp ? styles.wide : undefined}>
      {back}
      <h1 className={styles.title}>{appName(project)}</h1>
      <p
        role="status"
        className={styles.status}
        data-status={canceled ? "canceled" : project.status}
      >
        {/* Beside the words rather than around them, so they are not replaced and announced
            again when the spinner comes or goes. */}
        {isWorking(project, latestBuild, stoppingAt) && <Working />}
        <strong>
          {copy.project.statusPrefix} {label}.
        </strong>{" "}
        {hint}
      </p>
      <ErrorNote error={query.error} />
      {inApp ? (
        <ProjectWorkspace
          view={view}
          project={project}
          latestBuild={latestBuild}
          latestBuildBy={latestBuildBy}
          queued={queued}
          unreleased={unreleased}
          changes={changes}
          hasIcon={hasIcon}
          usage={usage}
          time={time}
          liveVersion={liveVersion}
          workingVersion={workingVersion}
          request={request}
          onRequestChange={setRequest}
          onStop={onStop}
        />
      ) : (
        <ProjectSetup
          project={project}
          latestBuild={latestBuild}
          specFailed={project.specError}
          request={request}
          onRequestChange={setRequest}
          onStop={onStop}
        />
      )}
    </article>
  );
}
