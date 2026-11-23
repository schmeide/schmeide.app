import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import { copy } from "../data/copy";
import { useTRPC, type Build, type Project, type StagingFeatures } from "../trpc";
import { FeatureResults } from "./FeatureResults";

import stepStyles from "./Step.module.css";

const NONE: StagingFeatures = { buildId: null, features: [] };

// Which features work in the version being worked on (#357). Asked again whenever staging runs
// another version or the latest build ends.
export function useStagingFeatures(project: Project, latestBuild: Build | null): StagingFeatures {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const options = trpc.projects.acceptance.queryOptions({ id: project.id });
  const { data } = useQuery(options);
  const seen = `${project.stagingCommit ?? ""} ${latestBuild?.id ?? ""} ${latestBuild?.status ?? ""}`;
  const last = useRef(seen);
  useEffect(() => {
    if (last.current === seen) return;
    last.current = seen;
    void queryClient.invalidateQueries({ queryKey: options.queryKey });
  }, [seen, queryClient, options.queryKey]);
  return data ?? NONE;
}

type Props = {
  readonly features: StagingFeatures["features"];
  readonly onAskForFix: (request: string) => void;
};

// The features of the version being worked on, under "Your app". Nothing when no tester has
// followed its checks.
export function VersionFeatures({ features, onAskForFix }: Props) {
  if (features.length === 0) return null;
  return (
    <section aria-labelledby="version-features">
      <h3 id="version-features">{copy.project.features.title}</h3>
      <p className={stepStyles.muted}>{copy.project.features.intro}</p>
      <FeatureResults features={features} headingLevel={4} onAskForFix={onAskForFix} />
    </section>
  );
}
