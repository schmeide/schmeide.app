import { useState } from "react";

import { copy } from "../data/copy";
import type { Project } from "../trpc";
import { previousLive } from "../utils/versions";
import { RollBack } from "./RollBack";
import { useVersionHistory } from "./Versions";

import stepStyles from "./Step.module.css";

// The overview's shortcut back to the version live before the current one, through the same
// confirmation as the versions view. Nothing while the first version is live or a build runs.
// Mount it with a key on the latest build, so a finished build refreshes it.
export function GoBack({
  project,
  liveVersion,
}: {
  readonly project: Project;
  readonly liveVersion: number | null;
}) {
  const [open, setOpen] = useState(false);
  const history = useVersionHistory(project.id, liveVersion !== null && liveVersion > 1);
  const builds = history.data?.pages.flatMap((page) => page.builds) ?? [];
  const previous = previousLive(builds, liveVersion);
  if (previous === null || liveVersion === null || project.status === "building") return null;
  return open ? (
    <RollBack
      project={project}
      builds={builds}
      version={previous}
      live={liveVersion}
      onClose={() => setOpen(false)}
    />
  ) : (
    <div className={stepStyles.actions}>
      <button type="button" onClick={() => setOpen(true)}>
        {copy.project.versions.goBack(previous)}
      </button>
    </div>
  );
}
