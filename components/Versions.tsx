import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";

import { copy } from "../data/copy";
import { useTRPC, type Build, type ListedBuild, type Project } from "../trpc";
import { formatDate } from "../utils/formatDate";
import { isRelease, isVersion } from "../utils/versions";
import { BuildLog } from "./BuildLog";
import { BuildStep } from "./BuildStep";
import { ErrorNote } from "./ErrorNote";
import { RollBack, versionText } from "./RollBack";

import stepStyles from "./Step.module.css";
import styles from "./Versions.module.css";

// ponytail: a page of 100 builds covers the versions most apps have; "Show older versions" pages on.
const PAGE = 100;

// The project's builds, newest first, shared by the versions view and the overview's shortcut.
export const useVersionHistory = (projectId: number, enabled = true) => {
  const trpc = useTRPC();
  return useInfiniteQuery(
    trpc.builds.list.infiniteQueryOptions(
      { id: projectId, limit: PAGE },
      { getNextPageParam: (page) => page.nextCursor, enabled }
    )
  );
};

// Keep in sync with --breakpoint-sm. Read once: a picture does not swap when the window resizes.
const NARROW = "(max-width: 639.98px)";
const pictureWidth = (): "phone" | "desktop" =>
  typeof window.matchMedia === "function" && window.matchMedia(NARROW).matches
    ? "phone"
    : "desktop";
// What services/pictures.ts saves: 1280×800 and 390×844, no wider than 640 px.
const SIZE = { desktop: { width: 640, height: 400 }, phone: { width: 390, height: 844 } } as const;

// The version's home page at the screen's width, or a neutral placeholder.
function Picture({ build }: { readonly build: ListedBuild }) {
  const trpc = useTRPC();
  const [width] = useState(pictureWidth);
  const picture = useQuery(
    trpc.builds.picture.queryOptions(
      { buildId: build.id, width },
      { enabled: build.version !== null }
    )
  );
  if (!picture.data || build.version === null)
    return <div className={styles.placeholder} data-width={width} aria-hidden="true" />;
  return (
    <img
      src={picture.data}
      alt={copy.project.versions.pictureAlt(build.version)}
      {...SIZE[width]}
      className={styles.picture}
      data-width={width}
    />
  );
}

// A promote, throw-away or roll back, as a line between the versions.
const releaseText = (build: ListedBuild): string =>
  copy.project.versions.event(
    build.kind === "discard"
      ? copy.project.versions.discardEvent
      : build.movedTo === null
        ? copy.project.versions.putLiveUnnumbered
        : copy.project.versions.putLiveEvent(build.movedTo),
    build.by,
    formatDate(build.startedAt)
  );

type Props = {
  readonly project: Project;
  readonly latestBuild: Build | null;
  readonly latestBuildBy: string | null;
  // The version numbers of what is live and what is being worked on; null for a commit from
  // before versions were kept.
  readonly liveVersion: number | null;
  readonly workingVersion: number | null;
};

// Every version of the app, newest first, with the releases between them, and putting one live.
// Mount it with a key on the latest build, so a finished build refreshes the list.
export function Versions({
  project,
  latestBuild,
  latestBuildBy,
  liveVersion,
  workingVersion,
}: Props) {
  const history = useVersionHistory(project.id);
  const [choosing, setChoosing] = useState<number | null>(null);
  const id = useId();
  const builds = history.data?.pages.flatMap((page) => page.builds) ?? [];
  const shown = builds.filter((build) => isVersion(build) || isRelease(build));
  const versions = shown.filter(isVersion);
  const building = project.status === "building";
  const rollingBack =
    latestBuild?.kind === "rollback" && latestBuild.status !== "passed" ? latestBuild : null;

  return (
    <>
      {rollingBack && (
        <BuildStep
          build={rollingBack}
          by={latestBuildBy}
          title={copy.project.versions.rollBackTitle}
        />
      )}
      <section aria-labelledby={`${id}-title`} className={stepStyles.step}>
        <h2 id={`${id}-title`}>{copy.project.versions.title}</h2>
        <ErrorNote error={history.error} />
        {history.isPending && <p className={stepStyles.muted}>{copy.loading}</p>}
        {history.isSuccess && (
          <p className={stepStyles.muted}>
            {versions.length <= 1
              ? copy.project.versions.only
              : liveVersion === null
                ? copy.project.versions.noLiveVersion
                : copy.project.versions.intro}
          </p>
        )}
        {building && versions.length > 1 && <p>{copy.project.versions.building}</p>}
        {shown.length > 0 && (
          <ol aria-labelledby={`${id}-title`} className={styles.list}>
            {shown.map((build) => {
              if (isRelease(build))
                return (
                  <li key={build.id} className={styles.release}>
                    {releaseText(build)}
                  </li>
                );
              const { version } = build;
              const heading = `${id}-${build.id}`;
              const choosable =
                version !== null &&
                liveVersion !== null &&
                version !== liveVersion &&
                versions.length > 1;
              return (
                <li key={build.id} className={styles.version}>
                  <Picture build={build} />
                  <div className={styles.about}>
                    <h3 id={heading}>
                      {version === null
                        ? copy.project.versions.unnumbered
                        : copy.project.versions.version(version)}
                    </h3>
                    {version !== null &&
                      (version === liveVersion || version === workingVersion) && (
                        <p className={styles.badges}>
                          {version === liveVersion && (
                            <span className={styles.badge} data-badge="live">
                              {copy.project.versions.live}
                            </span>
                          )}
                          {version === workingVersion && (
                            <span className={styles.badge}>{copy.project.versions.working}</span>
                          )}
                        </p>
                      )}
                    <p className={styles.request}>{versionText(build)}</p>
                    <p className={styles.facts}>
                      <time dateTime={build.startedAt.toISOString()}>
                        {formatDate(build.startedAt)}
                      </time>
                      {build.by && <span>{copy.project.release.askedBy(build.by)}</span>}
                    </p>
                    {version === null && (
                      <p className={stepStyles.muted}>{copy.project.versions.unnumberedWhy}</p>
                    )}
                    <div className={stepStyles.actions}>
                      {choosable && choosing !== version && (
                        <button
                          type="button"
                          disabled={building}
                          aria-describedby={heading}
                          onClick={() => setChoosing(version)}
                        >
                          {copy.project.versions.putLive}
                        </button>
                      )}
                      <BuildLog build={build} describedBy={heading} />
                    </div>
                    {choosable && choosing === version && (
                      <RollBack
                        project={project}
                        builds={builds}
                        version={version}
                        live={liveVersion}
                        onClose={() => setChoosing(null)}
                      />
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
        {history.hasNextPage && (
          <div className={stepStyles.actions}>
            <button
              type="button"
              disabled={history.isFetchingNextPage}
              onClick={() => void history.fetchNextPage()}
            >
              {history.isFetchingNextPage ? copy.loading : copy.project.versions.more}
            </button>
          </div>
        )}
      </section>
    </>
  );
}
