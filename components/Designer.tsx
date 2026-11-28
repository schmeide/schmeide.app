import { useState } from "react";

import { copy } from "../data/copy";
import type { Build, BuiltChange, Project, TimeTotals, Usage } from "../trpc";
import { navigate } from "../utils/navigation";
import { pathTo } from "../utils/routes";
import { appName } from "../utils/appName";
import { AppFrame } from "./AppFrame";
import { BuildHistory } from "./BuildHistory";
import { BuildStep, requestText, useBuildSummaries } from "./BuildStep";
import { ChangeForm } from "./ChangeForm";
import { GoBack } from "./GoBack";
import { Link } from "./Link";
import { LookStep } from "./LookStep";
import { QueuedChanges } from "./QueuedChanges";
import { Release } from "./Release";
import { Spec } from "./Spec";
import { StopButton } from "./StopButton";
import { UsageSummary } from "./UsageSummary";
import { useStagingFeatures, VersionFeatures } from "./VersionFeatures";
import { Working } from "./Working";

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
  readonly liveVersion: number | null;
  // Changes when the latest build does; it restarts the shortcut back to an earlier version.
  readonly latestKey: string | null;
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

// The builder's work takes the frame's place while it runs, and when it did not finish. Releases
// (put live, throw away) run no builder and stay in the side column.
const inPlaceOfFrame = (project: Project, build: Build | null): Build | null =>
  build &&
  (build.kind === "change" || build.kind === "initial") &&
  ((project.status === "building" && build.status === "running") || project.status === "failed")
    ? build
    : null;

// What a change built while the page was open came to, until it is dismissed.
function Built({ build, onDismiss }: { readonly build: Build; readonly onDismiss: () => void }) {
  const final = useBuildSummaries(build).find((summary) => summary.final);
  return (
    <>
      <p>
        <strong>{copy.project.designer.built}</strong> {final?.text}
      </p>
      <button type="button" onClick={onDismiss}>
        {copy.project.designer.dismiss}
      </button>
    </>
  );
}

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
  liveVersion,
  latestKey,
  request,
  onRequestChange,
  onStop,
}: Props) {
  const note = frameNote(project, latestBuild);
  const staging = useStagingFeatures(project, latestBuild);
  const notWorking = staging.features
    .filter((feature) => feature.state === "broken")
    .map((feature) => feature.name);
  // Bumped by "Ask for a fix", which moves the focus to the change request it wrote.
  const [fixAsked, setFixAsked] = useState(0);
  const askForFix = (text: string) => {
    const typed = request.trim();
    onRequestChange(typed && !typed.includes(text) ? `${typed}\n\n${text}` : text);
    if (view !== "changes") navigate(pathTo("projectChanges", { id: project.id }));
    setFixAsked((count) => count + 1);
  };
  const progress = inPlaceOfFrame(project, latestBuild);
  // "Show the app as it is now" holds for this build in this state: it ends when the build does.
  const progressKey = progress && `${progress.id} ${progress.status}`;
  const [frameFor, setFrameFor] = useState<string | null>(null);
  const showProgress = progress !== null && frameFor !== progressKey;
  // A change seen building here keeps its final summary above the frame until dismissed.
  const [watched, setWatched] = useState<number | null>(null);
  if (progress?.status === "running" && watched !== progress.id) setWatched(progress.id);
  const built = latestBuild?.status === "passed" && watched === latestBuild.id ? latestBuild : null;
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

        <div className={styles.app}>
          {(progress ?? built) && (
            <div className={styles.switch}>
              {built && <Built build={built} onDismiss={() => setWatched(null)} />}
              {progress && progress.status !== "running" && (
                <button type="button" onClick={() => askForFix(requestText(progress))}>
                  {copy.project.retryTitle}
                </button>
              )}
              {progress && (
                <button
                  type="button"
                  onClick={() => setFrameFor(showProgress ? progressKey : null)}
                >
                  {showProgress
                    ? copy.project.designer.showApp
                    : progress.status === "running"
                      ? copy.project.designer.showBuild
                      : copy.project.designer.showResult}
                </button>
              )}
            </div>
          )}
          {/* Both stay mounted in one grid cell, so switching keeps the app's place and its height. */}
          <div className={styles.panels}>
            {progress && (
              <div className={`${styles.panel} ${styles.progress}`} hidden={!showProgress}>
                <BuildStep
                  key={progress.id}
                  build={progress}
                  by={latestBuildBy}
                  title={copy.project.changeTitle}
                />
              </div>
            )}
            <section
              aria-labelledby="your-app"
              className={`${stepStyles.step} ${styles.panel}`}
              hidden={showProgress}
            >
              <h2 id="your-app">{copy.project.designer.appTitle}</h2>
              {(project.stagingUrl ?? project.previewUrl) ? (
                <>
                  {note && (
                    <p>
                      {project.status === "building" ? <Working size="page">{note}</Working> : note}
                    </p>
                  )}
                  <Release project={project} unreleased={unreleased} notWorking={notWorking} />
                  <GoBack key={latestKey} project={project} liveVersion={liveVersion} />
                  <AppFrame
                    // Loaded afresh each time it comes back from behind the build, so a change
                    // built while its progress showed comes back with its new version in.
                    key={showProgress ? "behind" : "shown"}
                    name={appName(project)}
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
                  <VersionFeatures features={staging.features} onAskForFix={askForFix} />
                </>
              ) : (
                <>
                  <p>
                    {project.status === "building" ? (
                      <Working size="page">{copy.project.designer.buildingNoApp}</Working>
                    ) : (
                      copy.project.designer.offline
                    )}
                  </p>
                  <Release project={project} unreleased={unreleased} notWorking={notWorking} />
                </>
              )}
            </section>
          </div>
        </div>

        <div className={styles.changes}>
          <section aria-labelledby="request-change" className={stepStyles.step}>
            <h2 id="request-change">{copy.project.changeTitleForm}</h2>
            <ChangeForm
              project={project}
              request={request}
              onRequestChange={onRequestChange}
              note={copy.project.designer.buildsToStaging}
              focusSignal={fixAsked}
            />
            {noChanges && <p className={stepStyles.muted}>{copy.project.designer.noChanges}</p>}
          </section>
          {latestBuild && !progress && (
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
          <QueuedChanges project={project} queued={queued} />
          {latestBuild && (
            <BuildHistory
              key={latestBuild.id}
              projectId={project.id}
              currentBuildId={latestBuild.id}
            />
          )}
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
            {project.need && (
              <details>
                <summary>{copy.project.showNeed}</summary>
                <p className={stepStyles.need}>{project.need}</p>
              </details>
            )}
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
