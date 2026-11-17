import { copy } from "../data/copy";
import type { Build, BuiltChange, Project, TimeTotals, Usage } from "../trpc";
import { pathTo } from "../utils/routes";
import { canDelete, DeleteProject } from "./DeleteProject";
import { Designer } from "./Designer";
import { Link } from "./Link";
import { SiteStep } from "./SiteStep";
import { StopButton } from "./StopButton";

import stepStyles from "./Step.module.css";
import styles from "./ProjectWorkspace.module.css";

export type ProjectView = "overview" | "changes" | "settings";

type Props = {
  readonly view: ProjectView;
  readonly project: Project;
  readonly latestBuild: Build | null;
  readonly queued: readonly Build[];
  readonly changes: readonly BuiltChange[];
  readonly hasIcon: boolean;
  readonly usage: Usage;
  readonly time: TimeTotals;
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
  queued,
  changes,
  hasIcon,
  usage,
  time,
  request,
  onRequestChange,
  onStop,
}: Props) {
  const designerView = view === "settings" ? null : view;

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
          queued={queued}
          changes={changes}
          usage={usage}
          time={time}
          request={request}
          onRequestChange={onRequestChange}
          onStop={onStop}
        />
      )}

      {view === "settings" && (
        <div className={styles.settings}>
          <SiteStep project={project} hasIcon={hasIcon} />
          <section aria-labelledby="manage" className={stepStyles.step}>
            <h2 id="manage">{copy.project.manageTitle}</h2>
            {!canDelete(project) && <p className={stepStyles.muted}>{copy.project.manageBusy}</p>}
            <div className={styles.manage}>
              {project.status === "live" && <StopButton project={project} onStop={onStop} />}
              <DeleteProject project={project} />
            </div>
          </section>
        </div>
      )}
    </>
  );
}
