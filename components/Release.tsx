import { useMutation } from "@tanstack/react-query";
import { useState } from "react";

import { copy } from "../data/copy";
import { useRefreshProjects, useTRPC, type Project } from "../trpc";
import { ErrorNote } from "./ErrorNote";
import { Working } from "./Working";

import stepStyles from "./Step.module.css";

type Props = {
  readonly project: Project;
  // Changes on the version being worked on that customers do not see yet.
  readonly unreleased: number;
  // The features not working yet in the version being worked on (#357), which putting it live
  // names first.
  readonly notWorking?: readonly string[];
};

// Says how the version being worked on differs from the live app, and puts it live or throws its
// changes away. Neither while a change is built; throwing away asks first.
export function Release({ project, unreleased, notWorking = [] }: Props) {
  const trpc = useTRPC();
  const refresh = useRefreshProjects();
  const [confirming, setConfirming] = useState(false);
  const [confirmingLive, setConfirmingLive] = useState(false);
  const promote = useMutation(
    trpc.projects.promote.mutationOptions({
      onSuccess: () => setConfirmingLive(false),
      onSettled: refresh,
    })
  );
  const discard = useMutation(
    trpc.projects.discard.mutationOptions({
      onSuccess: () => setConfirming(false),
      onSettled: refresh,
    })
  );
  const idle = project.status !== "building";
  const pending = promote.isPending || discard.isPending;
  const offline = project.previewUrl === null;
  const canPromote = idle && project.stagingCommit !== null && (unreleased > 0 || offline);
  const canDiscard = idle && unreleased > 0 && project.productionCommit !== null;

  return (
    <>
      {(project.stagingUrl ?? project.previewUrl) && (
        <p>
          {copy.project.release.showing}{" "}
          <strong>
            {unreleased > 0 ? copy.project.release.ahead(unreleased) : copy.project.release.same}
          </strong>
        </p>
      )}
      {canPromote && (
        <>
          <p className={stepStyles.muted}>{copy.project.release.promoteHint}</p>
          <div className={stepStyles.actions}>
            {!confirmingLive && (
              <button
                type="button"
                onClick={() =>
                  notWorking.length > 0
                    ? setConfirmingLive(true)
                    : promote.mutate({ id: project.id })
                }
                disabled={pending}
              >
                {promote.isPending ? (
                  <Working>{copy.project.release.promoting}</Working>
                ) : (
                  copy.project.release.promote
                )}
              </button>
            )}
            {canDiscard && !confirming && (
              <button
                type="button"
                data-variant="danger"
                onClick={() => setConfirming(true)}
                disabled={pending}
              >
                {copy.project.release.discard}
              </button>
            )}
          </div>
        </>
      )}
      {canPromote && confirmingLive && (
        <div role="group" aria-labelledby="live-confirm" className={stepStyles.warning}>
          <p id="live-confirm">{copy.project.release.notWorking(notWorking)}</p>
          <div className={stepStyles.actions}>
            <button
              type="button"
              onClick={() => promote.mutate({ id: project.id })}
              disabled={pending}
            >
              {promote.isPending ? (
                <Working>{copy.project.release.promoting}</Working>
              ) : (
                copy.project.release.notWorkingYes
              )}
            </button>
            <button
              type="button"
              onClick={() => setConfirmingLive(false)}
              disabled={pending}
              autoFocus
            >
              {copy.project.release.notWorkingNo}
            </button>
          </div>
        </div>
      )}
      {idle && unreleased > 0 && project.productionCommit === null && (
        <p className={stepStyles.muted}>{copy.project.release.noDiscardYet}</p>
      )}
      {confirming && (
        <div role="group" aria-labelledby="discard-confirm" className={stepStyles.warning}>
          <p id="discard-confirm">{copy.project.release.discardConfirm(unreleased)}</p>
          <div className={stepStyles.actions}>
            <button
              type="button"
              data-variant="danger"
              onClick={() => discard.mutate({ id: project.id })}
              disabled={pending}
            >
              {discard.isPending ? (
                <Working>{copy.project.release.discarding}</Working>
              ) : (
                copy.project.release.discardYes
              )}
            </button>
            <button type="button" onClick={() => setConfirming(false)} disabled={pending} autoFocus>
              {copy.project.release.discardNo}
            </button>
          </div>
        </div>
      )}
      <ErrorNote error={promote.error ?? discard.error} />
    </>
  );
}
