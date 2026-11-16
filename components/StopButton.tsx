import { useMutation } from "@tanstack/react-query";

import { copy } from "../data/copy";
import { useRefreshProjects, useTRPC, type Project } from "../trpc";
import { ErrorNote } from "./ErrorNote";

type Props = { readonly project: Project; readonly onStop: () => void };

// Cancels a running build, or takes a live app offline. Nothing in any other status.
export function StopButton({ project, onStop }: Props) {
  const trpc = useTRPC();
  const refresh = useRefreshProjects();
  const stop = useMutation(
    trpc.projects.stop.mutationOptions({ onSuccess: onStop, onSettled: () => refresh() })
  );
  const label =
    project.status === "building"
      ? copy.project.cancelBuild
      : project.status === "live"
        ? copy.project.takeOffline
        : null;
  if (!label) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => stop.mutate({ id: project.id })}
        disabled={stop.isPending}
      >
        {stop.isPending ? copy.project.stopping : label}
      </button>
      <ErrorNote error={stop.error} />
    </>
  );
}
