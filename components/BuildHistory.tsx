import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { inferRouterOutputs } from "@trpc/server";
import { useId, useState } from "react";

import { copy } from "../data/copy";
import type { AppRouter } from "../server/src/router.ts";
import { useTRPC } from "../trpc";
import { formatCost, formatDuration } from "../utils/usage";
import { BuildLog } from "./BuildLog";
import { requestText } from "./BuildStep";
import { ErrorNote } from "./ErrorNote";
import { FeatureResults } from "./FeatureResults";

import stepStyles from "./Step.module.css";
import styles from "./BuildHistory.module.css";

type PastBuild = inferRouterOutputs<AppRouter>["builds"]["list"]["builds"][number];

const when = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" });

// Which features worked in a past build's version (#357), fetched only once it is opened.
function PastFeatures({ build }: { readonly build: PastBuild }) {
  const trpc = useTRPC();
  const features = useQuery(trpc.builds.acceptance.queryOptions({ buildId: build.id }));
  if (features.error) return <ErrorNote error={features.error} />;
  if (!features.data) return <p className={stepStyles.muted}>{copy.loading}</p>;
  return features.data.length === 0 ? (
    <p className={stepStyles.muted}>{copy.project.features.noneInHistory}</p>
  ) : (
    <FeatureResults features={features.data} headingLevel={3} />
  );
}

// The builds a tester may have followed checks in: those that built a version of the app.
const TESTED_KINDS: readonly PastBuild["kind"][] = ["initial", "change"];

function PastBuildItem({ build }: { readonly build: PastBuild }) {
  const [featuresOpen, setFeaturesOpen] = useState(false);
  const id = useId();
  const tested = build.status === "passed" && TESTED_KINDS.includes(build.kind);
  return (
    <li className={styles.item}>
      <p id={`${id}-request`} className={styles.request}>
        {build.kind === "initial" ? copy.project.history.firstBuild : requestText(build)}
      </p>
      <p className={styles.facts} data-status={build.status}>
        <strong>{copy.project.buildStatus[build.status]}</strong>
        <time dateTime={build.startedAt.toISOString()} className={stepStyles.muted}>
          {when.format(build.startedAt)}
        </time>
        {build.finishedAt && (
          <span>
            <span className={stepStyles.muted}>{copy.project.history.took}</span>{" "}
            {formatDuration(build.finishedAt.getTime() - build.startedAt.getTime())}
          </span>
        )}
        <span>
          <span className={stepStyles.muted}>{copy.project.history.cost}</span>{" "}
          {formatCost(build.costUsd)}
        </span>
      </p>
      {build.status === "failed" && build.error && (
        <pre className={styles.error}>{build.error}</pre>
      )}
      <BuildLog build={build} describedBy={`${id}-request`} />
      {tested && (
        <>
          <button
            type="button"
            className={styles.toggle}
            aria-expanded={featuresOpen}
            aria-controls={`${id}-features`}
            aria-describedby={`${id}-request`}
            onClick={() => setFeaturesOpen((shown) => !shown)}
          >
            {copy.project.features.showInHistory}
          </button>
          <div id={`${id}-features`} hidden={!featuresOpen}>
            {featuresOpen && <PastFeatures build={build} />}
          </div>
        </>
      )}
    </li>
  );
}

// Builds before the latest one (shown above it), newest first, a page at a time. Mount it with
// key={currentBuildId} so a new build refreshes the list.
export function BuildHistory({
  projectId,
  currentBuildId,
}: {
  readonly projectId: number;
  readonly currentBuildId: number;
}) {
  const trpc = useTRPC();
  const history = useInfiniteQuery(
    trpc.builds.list.infiniteQueryOptions(
      { id: projectId },
      { getNextPageParam: (page) => page.nextCursor }
    )
  );
  const past =
    history.data?.pages
      .flatMap((page) => page.builds)
      .filter((build) => build.id !== currentBuildId) ?? [];

  return (
    <section aria-labelledby="history" className={stepStyles.step}>
      <h2 id="history">{copy.project.history.title}</h2>
      <ErrorNote error={history.error} />
      {history.isPending && <p className={stepStyles.muted}>{copy.loading}</p>}
      {history.isSuccess && past.length === 0 && (
        <p className={stepStyles.muted}>{copy.project.history.empty}</p>
      )}
      {past.length > 0 && (
        <>
          <p className={stepStyles.muted}>{copy.project.history.intro}</p>
          <ol aria-labelledby="history" className={styles.list}>
            {past.map((build) => (
              <PastBuildItem key={build.id} build={build} />
            ))}
          </ol>
        </>
      )}
      {history.hasNextPage && (
        <div className={stepStyles.actions}>
          <button
            type="button"
            disabled={history.isFetchingNextPage}
            onClick={() => void history.fetchNextPage()}
          >
            {history.isFetchingNextPage ? copy.loading : copy.project.history.more}
          </button>
        </div>
      )}
    </section>
  );
}
