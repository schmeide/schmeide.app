import { useMutation } from "@tanstack/react-query";
import {
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
} from "react";

import { copy } from "../data/copy";
import { useRefreshProjects, useTRPC, type Project } from "../trpc";
import { ErrorNote } from "./ErrorNote";

import stepStyles from "./Step.module.css";
import styles from "./FeaturesStep.module.css";

type Props = {
  readonly project: Project;
  readonly onEditingChange: (editing: boolean) => void;
  readonly specFailed: boolean;
};

const lines = (text: string) =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

// The boxes to start from: one per saved line, or a single empty one.
const boxes = (features: string): readonly string[] => {
  const saved = lines(features);
  return saved.length ? saved : [""];
};

export function FeaturesStep({ project, onEditingChange, specFailed }: Props) {
  const trpc = useTRPC();
  const refresh = useRefreshProjects();
  const [requests, setRequests] = useState(() => boxes(project.features));
  const inputs = useRef<(HTMLInputElement | null)[]>([]);
  // The box to focus once the boxes have rendered: a new one, or the one before a removed one.
  const focusNext = useRef<number | null>(null);
  useEffect(() => {
    if (focusNext.current === null) return;
    inputs.current[focusNext.current]?.focus();
    focusNext.current = null;
  }, [requests]);
  // ponytail: the API takes one newline-joined string, so a request can never contain a newline;
  // the boxes are single-line inputs and a pasted list splits into boxes. Send an array if a
  // request ever needs more than one line.
  const text = requests
    .map((request) => request.trim())
    .filter(Boolean)
    .join("\n");
  const [empty, setEmpty] = useState(false);
  const save = useMutation(trpc.projects.setFeatures.mutationOptions());
  const generate = useMutation(trpc.projects.generateSpec.mutationOptions());
  // Shown in draft, and from a ready spec to change the requests (which discards that spec).
  const reviewing = project.status === "spec_ready";
  const dirty = text !== lines(project.features).join("\n");

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
    setEmpty(!text);
    if (!text) return;
    void run(async () => {
      await saveIfChanged();
      await generate.mutateAsync({ id: project.id });
    });
  };
  const pending = save.isPending || generate.isPending;

  // Replaces box `index` with `values`, then focuses box `focus`.
  const splice = (index: number, values: readonly string[], focus: number) => {
    focusNext.current = focus;
    setRequests([...requests.slice(0, index), ...values, ...requests.slice(index + 1)]);
  };
  const onKeyDown = (index: number) => (event: KeyboardEvent<HTMLInputElement>) => {
    // Enter starts a new box below instead of submitting the form; IME composition keeps it.
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
    event.preventDefault();
    splice(index, [requests[index], ""], index + 1);
  };
  const onPaste = (index: number) => (event: ClipboardEvent<HTMLInputElement>) => {
    const pasted = lines(event.clipboardData.getData("text/plain"));
    if (pasted.length < 2) return;
    event.preventDefault();
    const kept = requests[index].trim() ? [requests[index]] : [];
    splice(index, [...kept, ...pasted], index + kept.length + pasted.length - 1);
  };

  return (
    <section aria-labelledby="features" className={stepStyles.step}>
      <h2 id="features">{copy.project.featuresTitle}</h2>
      <form onSubmit={onWriteSpec} className={stepStyles.form}>
        <p className={stepStyles.muted}>{copy.project.featuresIntro}</p>
        {specFailed && <p role="alert">{copy.project.specFailed}</p>}
        <fieldset className={styles.requests}>
          <legend>{copy.project.featuresLabel}</legend>
          <ol className={styles.list}>
            {requests.map((request, index) => (
              // Index keys are safe: the inputs are controlled, so values follow the state.
              <li key={index} className={styles.row}>
                <input
                  ref={(input) => {
                    inputs.current[index] = input;
                  }}
                  type="text"
                  aria-label={copy.project.requestLabel(index + 1)}
                  maxLength={1000}
                  value={request}
                  onChange={(event) =>
                    setRequests(
                      requests.map((old, at) => (at === index ? event.target.value : old))
                    )
                  }
                  onKeyDown={onKeyDown(index)}
                  onPaste={onPaste(index)}
                  placeholder={copy.project.requestPlaceholders[index]}
                  autoFocus={reviewing && index === 0}
                />
                {index > 0 && (
                  <button
                    type="button"
                    className={styles.remove}
                    aria-label={copy.project.removeRequestLabel(index + 1)}
                    onClick={() => splice(index, [], index - 1)}
                  >
                    {copy.project.removeRequest}
                  </button>
                )}
              </li>
            ))}
          </ol>
          <button
            type="button"
            className={styles.add}
            onClick={() => splice(requests.length, [""], requests.length)}
          >
            {copy.project.addRequest}
          </button>
        </fieldset>
        {reviewing && <p className={stepStyles.warning}>{copy.project.discardWarning}</p>}
        <div className={stepStyles.actions}>
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
                setRequests(boxes(project.features));
                onEditingChange(false);
              }}
              disabled={pending}
            >
              {copy.project.cancelEdit}
            </button>
          )}
          {save.isSuccess && !dirty && (
            <span className={stepStyles.muted}>{copy.project.saved}</span>
          )}
        </div>
        {empty && <p role="alert">{copy.project.needFeatures}</p>}
        <ErrorNote error={save.error ?? generate.error} />
      </form>
    </section>
  );
}
