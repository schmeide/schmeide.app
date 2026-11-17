import { useMutation } from "@tanstack/react-query";
import type { FormEvent } from "react";

import { copy } from "../data/copy";
import { useRefreshProjects, useTRPC, type Project } from "../trpc";
import { ErrorNote } from "./ErrorNote";

import stepStyles from "./Step.module.css";

type Props = {
  readonly project: Project;
  // The text lives with the page, so it survives a move between the app's views.
  readonly request: string;
  readonly onRequestChange: (request: string) => void;
  readonly note?: string;
};

// A box to request a change. It is also the way to retry a failed build and to bring an offline
// app back; while a build runs, the change waits its turn.
export function ChangeForm({ project, request, onRequestChange, note }: Props) {
  const trpc = useTRPC();
  const refresh = useRefreshProjects();
  const change = useMutation(
    trpc.projects.requestChange.mutationOptions({
      onSuccess: () => onRequestChange(""),
      onSettled: () => refresh(),
    })
  );
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    change.mutate({ id: project.id, request });
  };

  return (
    <form onSubmit={onSubmit} className={stepStyles.form}>
      <p className={stepStyles.muted}>
        {project.status === "failed"
          ? copy.project.changeRetryIntro
          : project.status === "building"
            ? copy.project.changeQueueIntro
            : copy.project.changeIntro}
      </p>
      <label htmlFor="change-request">{copy.project.changeLabel}</label>
      <textarea
        id="change-request"
        rows={3}
        required
        maxLength={5000}
        value={request}
        onChange={(event) => onRequestChange(event.target.value)}
        placeholder={copy.project.changePlaceholder}
        aria-describedby={note ? "change-note" : undefined}
      />
      {note && <p id="change-note">{note}</p>}
      <div className={stepStyles.actions}>
        <button type="submit" data-variant="primary" disabled={change.isPending || !request.trim()}>
          {change.isPending ? copy.project.requesting : copy.project.requestChange}
        </button>
      </div>
      <ErrorNote error={change.error} />
    </form>
  );
}
