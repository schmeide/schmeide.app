import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useState, type FormEvent, type ReactNode } from "react";

import { copy } from "../data/copy";
import { useRefreshProjects, useTRPC, type PlanItem, type Project, type ReadBack } from "../trpc";
import { classifyError } from "../utils/apiError";
import { ErrorNote } from "./ErrorNote";
import { Working } from "./Working";

import stepStyles from "./Step.module.css";
import styles from "./ReadBack.module.css";

type Target =
  { readonly part: "business" | "steps"; readonly index: number } | { readonly itemId: number };

const sameTarget = (a: Target | null, b: Target): boolean =>
  a !== null && JSON.stringify(a) === JSON.stringify(b);

// The longest plan item the server keeps (ITEM_MAX in server/src/db/schema.ts).
export const ITEM_MAX = 300;

type AnswerProps = {
  readonly label: string;
  readonly initial?: string;
  readonly submit: string;
  readonly busy: boolean;
  readonly maxLength?: number;
  // A plan item is one line, so Enter saves it instead of starting a new one.
  readonly line?: boolean;
  readonly onSend: (text: string) => void;
  readonly onCancel: () => void;
};

// One short answer: a correction, an open point, or a new wording for a plan item. Escape cancels.
// While it is sent the words stay focused and read-only, so a failure keeps them in place.
export function AnswerForm({
  label,
  initial = "",
  submit,
  busy,
  maxLength = 2000,
  line = false,
  onSend,
  onCancel,
}: AnswerProps) {
  const fieldId = useId();
  const errorId = useId();
  const [words, setWords] = useState(initial);
  const [missing, setMissing] = useState(false);
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const text = words.trim();
    setMissing(!text);
    if (text) onSend(text);
  };
  return (
    <form
      onSubmit={onSubmit}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !busy) onCancel();
      }}
      className={stepStyles.form}
      noValidate
    >
      <label htmlFor={fieldId}>{label}</label>
      <textarea
        id={fieldId}
        rows={2}
        maxLength={maxLength}
        value={words}
        autoFocus
        readOnly={busy}
        onKeyDown={(event) => {
          if (line && event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }
        }}
        aria-invalid={missing}
        aria-describedby={missing ? errorId : undefined}
        onChange={(event) => {
          setWords(event.target.value);
          setMissing(false);
        }}
      />
      {missing && (
        <p id={errorId} role="alert">
          {copy.readBack.needAnswer}
        </p>
      )}
      <div className={stepStyles.actions}>
        <button type="submit" disabled={busy}>
          {submit}
        </button>
        <button type="button" onClick={onCancel} disabled={busy}>
          {copy.readBack.cancel}
        </button>
      </div>
    </form>
  );
}

type Props = {
  readonly project: Project;
  readonly writing: boolean;
  readonly onWriteSpec: () => void;
  readonly onBack: () => void;
};

// After the questions and before the spec: what was understood, said back in the owner's terms,
// with every sentence open to one correction. Written from the plan, never ahead of it.
export function ReadBackStep({ project, writing, onWriteSpec, onBack }: Props) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const refresh = useRefreshProjects();
  const id = project.id;
  const [correcting, setCorrecting] = useState<Target | null>(null);
  const [changing, setChanging] = useState<number | null>(null);
  const readBack = useQuery(trpc.readBack.get.queryOptions({ id }));
  const store = (next: ReadBack) => {
    queryClient.setQueryData(trpc.readBack.get.queryKey({ id }), next);
    void queryClient.invalidateQueries({ queryKey: trpc.interview.get.queryKey({ id }) });
    void refresh();
  };
  const write = useMutation(trpc.readBack.write.mutationOptions({ onSuccess: store }));
  const correct = useMutation(
    trpc.readBack.correct.mutationOptions({
      onSuccess: (next) => {
        store(next);
        setCorrecting(null);
      },
    })
  );
  const update = useMutation(
    trpc.interview.updateItem.mutationOptions({
      onSuccess: () => {
        setChanging(null);
        // The plan changed, so the account goes; write it again from the new plan.
        void queryClient.invalidateQueries({ queryKey: trpc.interview.get.queryKey({ id }) });
        void refresh();
        write.mutate({ id });
      },
    })
  );

  const unwritten = readBack.data !== undefined && readBack.data.account === null;
  const { mutate } = write;
  useEffect(() => {
    if (unwritten) mutate({ id });
  }, [unwritten, mutate, id]);

  const data = readBack.data;
  const account = data?.account ?? null;
  const busy = write.isPending || correct.isPending || update.isPending || writing;
  const failure = write.error ?? correct.error ?? update.error;
  const failed = failure !== null && classifyError(failure) === "unavailable" && !account;

  const sentences = (part: "business" | "steps") =>
    account?.[part].map((sentence, index) => {
      const target = { part, index };
      const sentenceId = `readback-${part}-${index}`;
      return (
        <li key={`${part}-${index}`}>
          <div className={styles.row}>
            <span id={sentenceId}>{sentence.text}</span>
            {sameTarget(correcting, target) ? (
              <AnswerForm
                label={sentence.ask}
                submit={copy.readBack.send}
                busy={busy}
                onSend={(answer) => correct.mutate({ id, target, answer })}
                onCancel={() => setCorrecting(null)}
              />
            ) : (
              <button
                type="button"
                className={styles.mark}
                aria-describedby={sentenceId}
                disabled={busy}
                onClick={() => setCorrecting(target)}
              >
                {copy.readBack.notRight}
              </button>
            )}
          </div>
        </li>
      );
    });

  const listSection = (
    key: string,
    title: string,
    intro: string,
    items: readonly PlanItem[],
    row: (item: PlanItem) => ReactNode
  ) =>
    items.length > 0 && (
      <section aria-labelledby={`readback-${key}`} className={styles.part}>
        <h3 id={`readback-${key}`}>{title}</h3>
        <p className={stepStyles.muted}>{intro}</p>
        <ul>
          {items.map((item) => (
            <li key={item.id}>
              <div className={styles.row}>{row(item)}</div>
            </li>
          ))}
        </ul>
      </section>
    );

  return (
    <section aria-labelledby="readback" className={stepStyles.step}>
      <h2 id="readback">{copy.readBack.title}</h2>
      {(readBack.isPending || (write.isPending && !account)) && (
        <p role="status">
          <Working>{copy.readBack.writing}</Working>
        </p>
      )}
      {failed && (
        <div role="alert">
          <p>{copy.readBack.failed}</p>
          <div className={stepStyles.actions}>
            <button type="button" onClick={() => write.mutate({ id })} disabled={busy}>
              {copy.readBack.retry}
            </button>
            <button type="button" onClick={onWriteSpec} disabled={busy}>
              {copy.readBack.skip}
            </button>
          </div>
        </div>
      )}
      {account && data && (
        <>
          <p className={stepStyles.muted}>{copy.readBack.intro}</p>
          <section aria-labelledby="readback-business" className={styles.part}>
            <h3 id="readback-business">{copy.readBack.businessTitle}</h3>
            <ul aria-labelledby="readback-business">{sentences("business")}</ul>
          </section>
          <section aria-labelledby="readback-steps" className={styles.part}>
            <h3 id="readback-steps">{copy.readBack.stepsTitle}</h3>
            <ol aria-labelledby="readback-steps">{sentences("steps")}</ol>
          </section>
          {(correct.isPending || (write.isPending && update.isSuccess)) && (
            <p role="status">
              <Working>{copy.readBack.rewriting}</Working>
            </p>
          )}
          {listSection(
            "chosen",
            copy.readBack.chosenTitle,
            copy.readBack.chosenIntro,
            data.chosen,
            (item) =>
              changing === item.id ? (
                <AnswerForm
                  label={copy.readBack.changeLabel}
                  initial={item.text}
                  submit={copy.readBack.save}
                  busy={busy}
                  maxLength={ITEM_MAX}
                  line
                  onSend={(text) => update.mutate({ id, itemId: item.id, text })}
                  onCancel={() => setChanging(null)}
                />
              ) : (
                <>
                  <span id={`readback-item-${item.id}`}>{item.text}</span>
                  <button
                    type="button"
                    className={styles.mark}
                    aria-describedby={`readback-item-${item.id}`}
                    disabled={busy}
                    onClick={() => setChanging(item.id)}
                  >
                    {copy.readBack.change}
                  </button>
                </>
              )
          )}
          {listSection(
            "open",
            copy.readBack.openTitle,
            copy.readBack.openIntro,
            data.open,
            (item) => (
              <>
                <span id={`readback-item-${item.id}`}>{item.text}</span>
                {sameTarget(correcting, { itemId: item.id }) ? (
                  <AnswerForm
                    label={copy.readBack.openLabel}
                    submit={copy.readBack.send}
                    busy={busy}
                    onSend={(answer) => correct.mutate({ id, target: { itemId: item.id }, answer })}
                    onCancel={() => setCorrecting(null)}
                  />
                ) : (
                  <button
                    type="button"
                    className={styles.mark}
                    aria-describedby={`readback-item-${item.id}`}
                    disabled={busy}
                    onClick={() => setCorrecting({ itemId: item.id })}
                  >
                    {copy.readBack.answer}
                  </button>
                )}
              </>
            )
          )}
          {listSection(
            "later",
            copy.readBack.laterTitle,
            copy.readBack.laterIntro,
            data.later,
            (item) => (
              <span>{item.text}</span>
            )
          )}
          {data.open.length > 0 && <p>{copy.readBack.openLeft(data.open.length)}</p>}
          <div className={`${stepStyles.actions} ${styles.actions}`}>
            <button type="button" data-variant="primary" onClick={onWriteSpec} disabled={busy}>
              {writing ? <Working>{copy.project.startingSpec}</Working> : copy.readBack.confirm}
            </button>
            <button type="button" onClick={() => window.print()}>
              {copy.readBack.print}
            </button>
            <button type="button" onClick={onBack} disabled={busy}>
              {copy.readBack.back}
            </button>
          </div>
        </>
      )}
      {!failed && <ErrorNote error={failure} />}
    </section>
  );
}
