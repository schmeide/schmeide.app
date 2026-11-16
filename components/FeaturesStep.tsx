import { useMutation } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";

import { copy } from "../data/copy";
import { useRefreshProjects, useTRPC, type Project } from "../trpc";
import { ErrorNote } from "./ErrorNote";

import styles from "./Step.module.css";

type Props = {
  readonly project: Project;
  readonly editing: boolean;
  readonly onEditingChange: (editing: boolean) => void;
  readonly specFailed: boolean;
};

const lines = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

export function FeaturesStep({ project, editing, onEditingChange, specFailed }: Props) {
  const trpc = useTRPC();
  const refresh = useRefreshProjects();
  const [text, setText] = useState(project.features);
  const [empty, setEmpty] = useState(false);
  const save = useMutation(trpc.projects.setFeatures.mutationOptions());
  const generate = useMutation(trpc.projects.generateSpec.mutationOptions());
  const reviewing = project.status === "spec_ready";
  const editable = project.status === "draft" || (reviewing && editing);
  const dirty = text !== project.features;

  // Saving from spec_ready discards the spec, so only save when something changed.
  const saveIfChanged = async () => {
    if (dirty) await save.mutateAsync({ id: project.id, features: text });
  };
  const run = async (action: () => Promise<unknown>) => {
    try {
      await action();
      onEditingChange(false);
    } catch {
      // The mutation's error is rendered below.
    } finally {
      void refresh();
    }
  };
  const onSave = () => void run(saveIfChanged);
  const onWriteSpec = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setEmpty(!text.trim());
    if (!text.trim()) return;
    void run(async () => {
      await saveIfChanged();
      await generate.mutateAsync({ id: project.id });
    });
  };
  const pending = save.isPending || generate.isPending;

  return (
    <section aria-labelledby="features" className={styles.step}>
      <h2 id="features">{copy.project.featuresTitle}</h2>
      {editable ? (
        <form onSubmit={onWriteSpec} className={styles.form}>
          <p className={styles.muted}>{copy.project.featuresIntro}</p>
          {specFailed && <p role="alert">{copy.project.specFailed}</p>}
          <label htmlFor="features-text">{copy.project.featuresLabel}</label>
          <textarea
            id="features-text"
            rows={8}
            maxLength={5000}
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={copy.project.featuresPlaceholder}
            autoFocus={reviewing}
          />
          {reviewing && <p className={styles.warning}>{copy.project.discardWarning}</p>}
          <div className={styles.actions}>
            <button type="button" onClick={onSave} disabled={pending || !dirty}>
              {save.isPending ? copy.project.saving : copy.project.saveFeatures}
            </button>
            <button type="submit" data-variant="primary" disabled={pending}>
              {generate.isPending ? copy.project.startingSpec : copy.project.writeSpec}
            </button>
            {reviewing && (
              <button
                type="button"
                onClick={() => {
                  setText(project.features);
                  onEditingChange(false);
                }}
                disabled={pending}
              >
                {copy.project.cancelEdit}
              </button>
            )}
            {save.isSuccess && !dirty && <span className={styles.muted}>{copy.project.saved}</span>}
          </div>
          {empty && <p role="alert">{copy.project.needFeatures}</p>}
          <ErrorNote error={save.error ?? generate.error} />
        </form>
      ) : (
        <ul>
          {lines(project.features).map((line, index) => (
            <li key={index}>{line}</li>
          ))}
        </ul>
      )}
    </section>
  );
}
