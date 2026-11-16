import { copy } from "../data/copy";
import type { Build, Project, Usage } from "../trpc";
import { pathTo, type RouteName } from "../utils/routes";
import { BuildStep } from "./BuildStep";
import { ChangeForm } from "./ChangeForm";
import { canDelete, DeleteProject } from "./DeleteProject";
import { Link } from "./Link";
import { QueuedChanges } from "./QueuedChanges";
import { SiteStep } from "./SiteStep";
import { Spec } from "./Spec";
import { StopButton } from "./StopButton";
import { UsageSummary } from "./UsageSummary";

import stepStyles from "./Step.module.css";
import styles from "./ProjectWorkspace.module.css";

export type ProjectView = "overview" | "changes" | "settings";

const VIEWS: readonly { readonly view: ProjectView; readonly route: RouteName }[] = [
  { view: "overview", route: "project" },
  { view: "changes", route: "projectChanges" },
  { view: "settings", route: "projectSettings" },
];

type Props = {
  readonly view: ProjectView;
  readonly project: Project;
  readonly latestBuild: Build | null;
  readonly queued: readonly Build[];
  readonly hasIcon: boolean;
  readonly usage: Usage;
  readonly request: string;
  readonly onRequestChange: (request: string) => void;
  readonly onStop: () => void;
};

// The home of an app that has been live: three views, each with at most one primary button.
export function ProjectWorkspace({
  view,
  project,
  latestBuild,
  queued,
  hasIcon,
  usage,
  request,
  onRequestChange,
  onStop,
}: Props) {
  const changes = pathTo("projectChanges", { id: project.id });
  const live = project.status === "live" && project.previewUrl;

  return (
    <>
      <nav aria-label={copy.project.views.label} className={styles.views}>
        <ul>
          {VIEWS.map((entry) => (
            <li key={entry.view}>
              <Link
                to={pathTo(entry.route, { id: project.id })}
                aria-current={entry.view === view ? "page" : undefined}
              >
                {copy.project.views[entry.view]}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      {view === "overview" && (
        <>
          {/* Opening the app is the one primary action while it is live; otherwise the way on is
              a change, which also retries a failed build and brings an offline app back. */}
          <div className={styles.actions}>
            {live && (
              <a
                href={live}
                target="_blank"
                rel="noreferrer"
                className={styles.action}
                data-variant="primary"
              >
                {copy.project.open}{" "}
                <span className={styles.hint}>{copy.project.opensInNewTab}</span>
              </a>
            )}
            <Link
              to={changes}
              className={styles.action}
              data-variant={live ? undefined : "primary"}
            >
              {project.status === "failed" ? copy.project.seeChanges : copy.project.toChanges}
            </Link>
          </div>
          {live && <p className={styles.address}>{live}</p>}
          <UsageSummary usage={usage} />
          {project.spec && (
            <section aria-labelledby="built-from" className={stepStyles.step}>
              <h2 id="built-from">{copy.project.builtFrom}</h2>
              <details>
                <summary>{copy.project.showSpec}</summary>
                <Spec source={project.spec} />
              </details>
            </section>
          )}
        </>
      )}

      {view === "changes" && (
        <>
          <section aria-labelledby="request-change" className={stepStyles.step}>
            <h2 id="request-change">{copy.project.changeTitleForm}</h2>
            <ChangeForm project={project} request={request} onRequestChange={onRequestChange} />
          </section>
          {latestBuild && (
            <BuildStep
              key={latestBuild.id}
              build={latestBuild}
              title={
                latestBuild.kind === "initial"
                  ? copy.project.firstBuildTitle
                  : copy.project.changeTitle
              }
            />
          )}
          {project.status === "building" && (
            <div className={styles.cancel}>
              <StopButton project={project} onStop={onStop} />
            </div>
          )}
          <QueuedChanges queued={queued} />
        </>
      )}

      {view === "settings" && (
        <>
          <SiteStep project={project} hasIcon={hasIcon} />
          <section aria-labelledby="manage" className={stepStyles.step}>
            <h2 id="manage">{copy.project.manageTitle}</h2>
            {!canDelete(project) && <p className={stepStyles.muted}>{copy.project.manageBusy}</p>}
            <div className={styles.manage}>
              {project.status === "live" && <StopButton project={project} onStop={onStop} />}
              <DeleteProject project={project} />
            </div>
          </section>
        </>
      )}
    </>
  );
}
