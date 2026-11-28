import { copy } from "../data/copy";
import type { Build, BuiltChange, Project, TimeTotals, Usage } from "../trpc";
import { pathTo } from "../utils/routes";
import { canDelete, DeleteProject } from "./DeleteProject";
import { Designer } from "./Designer";
import { Link } from "./Link";
import { NameStep } from "./NameStep";
import { OfflineStep } from "./OfflineStep";
import { SiteStep } from "./SiteStep";
import { Versions } from "./Versions";

import stepStyles from "./Step.module.css";
import styles from "./ProjectWorkspace.module.css";

export type ProjectView = "overview" | "changes" | "versions" | "settings";

type Props = {
  readonly view: ProjectView;
  readonly project: Project;
  readonly latestBuild: Build | null;
  readonly latestBuildBy: string | null;
  readonly queued: readonly Build[];
  readonly unreleased: number;
  readonly changes: readonly BuiltChange[];
  readonly hasIcon: boolean;
  readonly usage: Usage;
  readonly time: TimeTotals;
  // The version numbers of what is live and what is being worked on.
  readonly liveVersion: number | null;
  readonly workingVersion: number | null;
  readonly request: string;
  readonly onRequestChange: (request: string) => void;
  readonly onStop: () => void;
};

// The home of an app that has been live: the designer and its settings, each with at most one
// primary button.
export function ProjectWorkspace({
  view,
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
  request,
  onRequestChange,
  onStop,
}: Props) {
  const designerView = view === "overview" || view === "changes" ? view : null;
  // A finished build changes the versions, so the views that list them start again.
  const latestKey = latestBuild && `${latestBuild.id} ${latestBuild.status}`;

  return (
    <>
      <nav aria-label={copy.project.views.label} className={styles.views}>
        <ul>
          <li>
            <Link
              to={pathTo("project", { id: project.id })}
              aria-current={view === "overview" ? "page" : view === "changes" ? "true" : undefined}
            >
              {copy.project.views.designer}
            </Link>
          </li>
          <li>
            <Link
              to={pathTo("projectVersions", { id: project.id })}
              aria-current={view === "versions" ? "page" : undefined}
            >
              {copy.project.views.versions}
            </Link>
          </li>
          <li>
            <Link
              to={pathTo("projectSettings", { id: project.id })}
              aria-current={view === "settings" ? "page" : undefined}
            >
              {copy.project.views.settings}
            </Link>
          </li>
        </ul>
      </nav>

      {designerView && (
        <Designer
          view={designerView}
          project={project}
          latestBuild={latestBuild}
          latestBuildBy={latestBuildBy}
          queued={queued}
          unreleased={unreleased}
          changes={changes}
          usage={usage}
          time={time}
          liveVersion={liveVersion}
          latestKey={latestKey}
          request={request}
          onRequestChange={onRequestChange}
          onStop={onStop}
        />
      )}

      {view === "versions" && (
        <Versions
          key={latestKey}
          project={project}
          latestBuild={latestBuild}
          latestBuildBy={latestBuildBy}
          liveVersion={liveVersion}
          workingVersion={workingVersion}
        />
      )}

      {view === "settings" && (
        // Each section saves by itself, in the order of #56. A rename starts the page title over,
        // since an unset title follows the name.
        <div className={styles.settings}>
          <NameStep project={project} />
          <SiteStep key={project.name} project={project} hasIcon={hasIcon} />
          <OfflineStep project={project} onStop={onStop} />
          <section aria-labelledby="delete" className={stepStyles.step}>
            <h2 id="delete">{copy.project.deleteTitle}</h2>
            {!canDelete(project) && <p className={stepStyles.muted}>{copy.project.manageBusy}</p>}
            <div className={styles.manage}>
              <DeleteProject project={project} />
            </div>
          </section>
        </div>
      )}
    </>
  );
}
