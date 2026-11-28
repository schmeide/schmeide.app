import { useMutation } from "@tanstack/react-query";
import { TRPCClientError } from "@trpc/client";
import { useId, useState, type FormEvent } from "react";

import { copy } from "../data/copy";
import { useRefreshProjects, useTRPC, type ListedBuild, type Project } from "../trpc";
import { appName } from "../utils/appName";
import { between } from "../utils/versions";
import { requestText } from "./BuildStep";
import { ErrorNote } from "./ErrorNote";
import { Working } from "./Working";

import stepStyles from "./Step.module.css";
import styles from "./RollBack.module.css";

// What a version was asked for, in the person's words where they gave some.
export const versionText = (build: Pick<ListedBuild, "kind" | "request">): string =>
  build.kind === "initial" ? copy.project.history.firstBuild : requestText(build);

type Offer = { readonly id: number; readonly takenAt: Date };
type Refusal = { readonly reason: string; readonly copies: readonly Offer[] };

// A roll back the server refused because it cannot keep today's information (#228): why, and the
// copies of the information it can go back with instead.
const refusalOf = (error: unknown): Refusal | null => {
  if (!(error instanceof TRPCClientError)) return null;
  const data: unknown = error.data;
  if (typeof data !== "object" || data === null || !("reason" in data) || !("copies" in data))
    return null;
  const { reason, copies } = data;
  if (typeof reason !== "string" || !Array.isArray(copies)) return null;
  return {
    reason,
    copies: copies.flatMap((offer: unknown) =>
      typeof offer === "object" &&
      offer !== null &&
      "id" in offer &&
      typeof offer.id === "number" &&
      "takenAt" in offer &&
      offer.takenAt instanceof Date
        ? [{ id: offer.id, takenAt: offer.takenAt }]
        : []
    ),
  };
};

type Props = {
  readonly project: Project;
  // The project's builds, newest first, as builds.list answers them.
  readonly builds: readonly ListedBuild[];
  readonly version: number;
  readonly live: number;
  readonly onClose: () => void;
};

// The confirmation before putting `version` live in place of `live`: what customers will see,
// then what happens to the information. Going back without today's information asks for the
// app's name.
export function RollBack({ project, builds, version, live, onClose }: Props) {
  const trpc = useTRPC();
  const refresh = useRefreshProjects();
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [chosen, setChosen] = useState<number | null>(null);
  const [typed, setTyped] = useState("");
  const [mismatch, setMismatch] = useState(false);
  const rollBack = useMutation(
    trpc.projects.rollBack.mutationOptions({
      onSuccess: onClose,
      onError: (error) => setRefusal((before) => refusalOf(error) ?? before),
      onSettled: refresh,
    })
  );
  const id = useId();
  const name = appName(project);
  const copyId = chosen ?? refusal?.copies[0]?.id ?? null;
  const pending = rollBack.isPending;
  const other = refusalOf(rollBack.error) ? null : rollBack.error;

  const withCopy = (event: FormEvent) => {
    event.preventDefault();
    if (copyId === null || pending) return;
    if (typed.trim() !== name) {
      setMismatch(true);
      return;
    }
    rollBack.mutate({ id: project.id, version, withInformationFrom: copyId });
  };
  const cancel = (
    <button
      type="button"
      onClick={onClose}
      disabled={pending}
      autoFocus={!refusal || refusal.copies.length === 0}
    >
      {copy.project.versions.cancel(live)}
    </button>
  );
  const undo = <p>{copy.project.versions.undo(live)}</p>;

  return (
    <section aria-labelledby={`${id}-title`} className={`${stepStyles.warning} ${styles.confirm}`}>
      <h3 id={`${id}-title`}>{copy.project.versions.confirmTitle(version)}</h3>
      <h4>{copy.project.versions.customersTitle}</h4>
      <p>
        {version < live
          ? copy.project.versions.goesBack(version)
          : copy.project.versions.goesForward(version)}
      </p>
      <ul>
        {between(builds, live, version).map((build) => (
          <li key={build.id}>{versionText(build)}</li>
        ))}
      </ul>
      <h4>{copy.project.versions.informationTitle}</h4>
      {!refusal ? (
        <>
          <p>{copy.project.versions.keeps(Math.min(version, live))}</p>
          {undo}
          <div className={stepStyles.actions}>
            <button
              type="button"
              data-variant="primary"
              onClick={() => rollBack.mutate({ id: project.id, version })}
              disabled={pending}
            >
              {pending ? (
                <Working>{copy.project.versions.starting}</Working>
              ) : (
                copy.project.versions.confirm(version)
              )}
            </button>
            {cancel}
          </div>
        </>
      ) : (
        <>
          <p id={`${id}-reason`}>{refusal.reason}</p>
          {refusal.copies.length === 0 ? (
            <>
              <p>{copy.project.versions.noCopies(version)}</p>
              <div className={stepStyles.actions}>{cancel}</div>
            </>
          ) : (
            <form onSubmit={withCopy} className={stepStyles.form} noValidate>
              <fieldset className={styles.copies} aria-describedby={`${id}-reason`}>
                <legend>{copy.project.versions.copiesLegend}</legend>
                {refusal.copies.map((offer, index) => (
                  <label key={offer.id}>
                    <input
                      type="radio"
                      name={`${id}-copy`}
                      checked={offer.id === copyId}
                      onChange={() => setChosen(offer.id)}
                      autoFocus={index === 0}
                    />
                    {copy.project.versions.withCopy(
                      version,
                      copy.project.versions.when(offer.takenAt)
                    )}
                  </label>
                ))}
              </fieldset>
              <p>{copy.project.versions.loses}</p>
              <label htmlFor={`${id}-name`}>{copy.project.versions.typeName(name)}</label>
              <input
                id={`${id}-name`}
                type="text"
                autoComplete="off"
                spellCheck={false}
                value={typed}
                onChange={(event) => {
                  setTyped(event.target.value);
                  setMismatch(false);
                }}
                aria-invalid={mismatch || undefined}
                aria-describedby={mismatch ? `${id}-mismatch` : undefined}
              />
              {mismatch && (
                <p id={`${id}-mismatch`} className={stepStyles.fieldError}>
                  {copy.project.versions.nameMismatch(name)}
                </p>
              )}
              {undo}
              <div className={stepStyles.actions}>
                <button type="submit" data-variant="danger" aria-disabled={pending || undefined}>
                  {pending ? (
                    <Working>{copy.project.versions.starting}</Working>
                  ) : (
                    copy.project.versions.confirmWithCopy(version)
                  )}
                </button>
                {cancel}
              </div>
            </form>
          )}
        </>
      )}
      <ErrorNote error={other} />
    </section>
  );
}
