import { copy } from "../data/copy";
import type { Build, BuiltChange, Project, TimeTotals, Usage } from "../trpc";
import { pathTo } from "../utils/routes";
import { AppFrame } from "./AppFrame";
import { BuildStep } from "./BuildStep";
import { ChangeForm } from "./ChangeForm";
import { Link } from "./Link";
import { LookStep } from "./LookStep";
import { QueuedChanges } from "./QueuedChanges";
import { Release } from "./Release";
import { Spec } from "./Spec";
import { StopButton } from "./StopButton";
import { UsageSummary } from "./UsageSummary";

import stepStyles from "./Step.module.css";
import styles from "./Designer.module.css";

export type DesignerView = "overview" | "changes";

const TABS = [
  { view: "overview", route: "project" },
  { view: "changes", route: "projectChanges" },
] as const;

type Props = {
  readonly view: DesignerView;
  readonly project: Project;
  readonly latestBuild: Build | null;
  readonly latestBuildBy: string | null;
  readonly queued: readonly Build[];
  readonly unreleased: number;
  readonly changes: readonly BuiltChange[];
  readonly usage: Usage;
  readonly time: TimeTotals;
  readonly request: string;
  readonly onRequestChange: (request: string) => void;
  readonly onStop: () => void;
};

const frameNote = (project: Project, build: Build | null): string | null =>
  project.status === "building"
    ? copy.project.designer.building
    : project.status === "failed" && build?.status === "canceled"
      ? copy.project.designer.canceled
      : project.status === "failed"
        ? copy.project.designer.failed
        : null;

export function Designer({
  view,
  project,
  latestBuild,
  latestBuildBy,
  queued,
  unreleased,
  changes,
  usage,
  time,
  request,
  onRequestChange,
  onStop,
}: Props) {
  const note = frameNote(project, latestBuild);
  const noChanges =
    changes.length === 0 && queued.length === 0 && (!latestBuild || latestBuild.kind === "initial");

  return (
    <>
      <div className={styles.designer} data-view={view}>
        <nav aria-label={copy.project.designer.tabsLabel} className={styles.tabs}>
          <ul>
            {TABS.map((tab) => (
              <li key={tab.view}>
                <Link
                  to={pathTo(tab.route, { id: project.id })}
                  aria-current={tab.view === view ? "page" : undefined}
                >
                  {copy.project.views[tab.view]}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <section aria-labelledby="your-app" className={`${stepStyles.step} ${styles.app}`}>
          <h2 id="your-app">{copy.project.designer.appTitle}</h2>
          {(project.stagingUrl ?? project.previewUrl) ? (
            <>
              {note && <p>{note}</p>}
              <Release project={project} unreleased={unreleased} />
              <AppFrame
                name={project.name}
                stagingUrl={project.stagingUrl}
                liveUrl={project.previewUrl}
                // A new version is a passed build that changed staging: every kind but a promote,
                // which changes only the live app. A discard returns staging to the live version.
                version={
                  latestBuild?.status === "passed" && latestBuild.kind !== "promote"
                    ? latestBuild.id
                    : null
                }
              />
            </>
          ) : (
            <>
              <p>
                {project.status === "building"
                  ? copy.project.designer.buildingNoApp
                  : copy.project.designer.offline}
              </p>
              <Release project={project} unreleased={unreleased} />
            </>
          )}
        </section>

        <div className={styles.changes}>
          <section aria-labelledby="request-change" className={stepStyles.step}>
            <h2 id="request-change">{copy.project.changeTitleForm}</h2>
            <ChangeForm
              project={project}
              request={request}
              onRequestChange={onRequestChange}
              note={copy.project.designer.buildsToStaging}
            />
            {noChanges && <p className={stepStyles.muted}>{copy.project.designer.noChanges}</p>}
          </section>
          {latestBuild && (
            <BuildStep
              key={latestBuild.id}
              build={latestBuild}
              by={latestBuildBy}
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
        </div>
      </div>

      <div className={styles.below}>
        {project.spec && (
          <section aria-labelledby="built-from" className={stepStyles.step}>
            <h2 id="built-from">{copy.project.builtFrom}</h2>
            {changes.length === 0 ? (
              <p className={stepStyles.muted}>{copy.project.builtFromUnchanged}</p>
            ) : (
              <>
                <p className={stepStyles.muted}>{copy.project.builtFromChanged}</p>
                <h3 id="changes-since">{copy.project.changesSince}</h3>
                <ol aria-labelledby="changes-since">
                  {changes.map((change) => (
                    <li key={change.id}>{change.request}</li>
                  ))}
                </ol>
              </>
            )}
            <details>
              <summary>{copy.project.showSpec}</summary>
              <Spec source={project.spec} />
            </details>
          </section>
        )}
        <LookStep project={project} />
        <UsageSummary
          usage={usage}
          time={time}
          runningSince={latestBuild?.status === "running" ? latestBuild.startedAt : null}
        />
      </div>
    </>
  );
}
