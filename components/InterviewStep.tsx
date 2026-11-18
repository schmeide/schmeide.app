import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";

import { copy } from "../data/copy";
import {
  useRefreshProjects,
  useTRPC,
  type Answer,
  type Interview,
  type PlanItem,
  type Project,
  type Question,
} from "../trpc";
import { classifyError } from "../utils/apiError";
import { ErrorNote } from "./ErrorNote";
import { ReadBackStep } from "./ReadBack";
import { useDraft } from "./useDraft";

import stepStyles from "./Step.module.css";
import styles from "./InterviewStep.module.css";

const SECTIONS = ["who", "does", "screens", "keeps", "replaces"] as const;
const YES = "yes";
const NO = "no";

const answerText = (answer: Answer): string => {
  switch (answer.type) {
    case "choices":
      return new Intl.ListFormat(undefined, { type: "conjunction" }).format(answer.values);
    case "yes_no":
      return answer.value ? copy.interview.yes : copy.interview.no;
    case "text":
      return answer.value;
    case "you_decide":
      return copy.interview.answerYouDecide;
  }
};

type QuestionProps = {
  readonly question: Question;
  readonly busy: boolean;
  // Move focus to the question when it appears after an answer, not on the first page load.
  readonly focus: boolean;
  readonly onAnswer: (answer: Answer) => void;
};

// One question as a form. Every question can also be answered in the person's own words, or
// handed to Schmeide with “You decide”.
function QuestionForm({ question, busy, focus, onAnswer }: QuestionProps) {
  const errorId = useId();
  const questionId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const fields = useRef<HTMLDivElement>(null);
  const [picked, setPicked] = useState<readonly string[]>([]);
  // Own words not yet sent are kept as a draft; one restored to a question with choices reopens
  // "Other" so it shows. ponytail: a sent answer's draft stays until the tab closes; its question
  // never comes back, so it is never shown.
  const [words, setWords] = useDraft(`answer:${question.id}`);
  const [other, setOther] = useState(question.kind !== "text" && words !== "");
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    if (focus) heading.current?.focus();
  }, [focus]);

  const many = question.kind === "pick_many";
  const choices = question.kind === "yes_no" ? [YES, NO] : question.choices;
  const label = (choice: string) =>
    question.kind !== "yes_no" ? choice : choice === YES ? copy.interview.yes : copy.interview.no;
  const toggle = (choice: string, on: boolean) => {
    setMissing(false);
    if (!many) {
      setPicked([choice]);
      setOther(false);
    } else {
      setPicked(on ? [...picked, choice] : picked.filter((value) => value !== choice));
    }
  };

  const answer = (): Answer | null => {
    const own = words.trim();
    if (question.kind === "text") return own ? { type: "text", value: own } : null;
    if (other && own) {
      // Choices plus the person's own words go together as words, so nothing is dropped.
      return { type: "text", value: [...picked, own].join("; ") };
    }
    if (other || picked.length === 0) return null;
    return question.kind === "yes_no"
      ? { type: "yes_no", value: picked[0] === YES }
      : { type: "choices", values: [...picked] };
  };
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const given = answer();
    setMissing(!given);
    if (given) onAnswer(given);
    else fields.current?.querySelector<HTMLElement>("input, textarea")?.focus();
  };

  return (
    <form onSubmit={onSubmit} className={stepStyles.form} noValidate>
      <fieldset
        className={styles.question}
        disabled={busy}
        aria-labelledby={questionId}
        aria-describedby={missing ? errorId : undefined}
      >
        <h3 id={questionId} ref={heading} tabIndex={-1} className={styles.questionHeading}>
          {question.text}
        </h3>
        <div ref={fields} className={styles.choices}>
          {question.kind === "text" ? (
            <textarea
              aria-label={copy.interview.answerLabel}
              rows={3}
              maxLength={2000}
              value={words}
              aria-invalid={missing}
              onChange={(event) => {
                setWords(event.target.value);
                setMissing(false);
              }}
            />
          ) : (
            <>
              {choices.map((choice) => (
                <label key={choice} className={styles.choice}>
                  <input
                    type={many ? "checkbox" : "radio"}
                    name={`question-${question.id}`}
                    checked={picked.includes(choice)}
                    onChange={(event) => toggle(choice, event.target.checked)}
                  />
                  {label(choice)}
                </label>
              ))}
              <label className={styles.choice}>
                <input
                  type={many ? "checkbox" : "radio"}
                  name={`question-${question.id}`}
                  checked={other}
                  onChange={(event) => {
                    setMissing(false);
                    setOther(event.target.checked);
                    if (!many) setPicked([]);
                  }}
                />
                {copy.interview.other}
              </label>
              {other && (
                <input
                  type="text"
                  aria-label={copy.interview.otherLabel}
                  maxLength={500}
                  value={words}
                  aria-invalid={missing}
                  autoFocus
                  onChange={(event) => {
                    setWords(event.target.value);
                    setMissing(false);
                  }}
                />
              )}
            </>
          )}
        </div>
      </fieldset>
      {missing && (
        <p id={errorId} role="alert">
          {copy.interview.needAnswer}
        </p>
      )}
      <div className={stepStyles.actions}>
        <button type="submit" data-variant="primary" disabled={busy}>
          {copy.interview.continue}
        </button>
        <button type="button" disabled={busy} onClick={() => onAnswer({ type: "you_decide" })}>
          {copy.interview.youDecide}
        </button>
        <span className={stepStyles.muted}>{copy.interview.youDecideHint}</span>
      </div>
    </form>
  );
}

type PlanProps = {
  readonly interview: Interview;
  // Ids of the items added by the latest answer.
  readonly fresh: ReadonlySet<number>;
};

// The plan the answers are building: four sections, each with how complete it is.
function Plan({ interview, fresh }: PlanProps) {
  const tags = (item: PlanItem): readonly string[] => [
    ...(fresh.has(item.id) ? [copy.interview.tagNew] : []),
    ...(item.source === "schmeide" ? [copy.interview.tagSchmeide] : []),
    ...(item.phase === "later" ? [copy.interview.tagLater] : []),
  ];

  return (
    <section aria-labelledby="plan" className={styles.plan}>
      <h3 id="plan">{copy.interview.planTitle(interview.items.length)}</h3>
      {SECTIONS.map((section) => {
        const items = interview.items.filter((item) => item.section === section);
        const given = section === "replaces";
        if (given && items.length === 0) return null;
        return (
          <div key={section} className={styles.section}>
            <h4>
              {copy.interview.sections[section]}{" "}
              {!given && (
                <span className={styles.sectionStatus}>
                  {copy.interview.sectionStatus[interview.sections[section]]}
                </span>
              )}
            </h4>
            {items.length ? (
              <ul>
                {items.map((item) => (
                  <li key={item.id}>
                    {item.text}
                    {tags(item).map((tag) => (
                      <span
                        key={tag}
                        className={styles.tag}
                        data-new={tag === copy.interview.tagNew || undefined}
                      >
                        {tag}
                      </span>
                    ))}
                  </li>
                ))}
              </ul>
            ) : (
              <p className={stepStyles.muted}>{copy.interview.sectionEmpty}</p>
            )}
          </div>
        );
      })}
    </section>
  );
}

type RestartProps = {
  readonly need: string;
  readonly answers: number;
  readonly items: number;
  readonly busy: boolean;
  readonly onRestart: (need: string) => void;
};

// The prompt the questions follow from, and a way to change it and start them over. The warning
// sits beside the button that clears, so it is read before anything is lost.
function Restart({ need, answers, items, busy, onRestart }: RestartProps) {
  const fieldId = useId();
  const errorId = useId();
  const change = useRef<HTMLButtonElement>(null);
  const [editing, setEditing] = useState(false);
  const [words, setWords] = useState(need);
  const [missing, setMissing] = useState(false);
  // Set when the form is closed by hand, so focus goes back to the button that opened it.
  const closed = useRef(false);
  useEffect(() => {
    if (!editing && closed.current) change.current?.focus();
  }, [editing]);
  const close = () => {
    closed.current = true;
    setEditing(false);
    setMissing(false);
  };
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = words.trim();
    setMissing(!text);
    if (text) onRestart(text);
  };

  if (!editing) {
    return (
      <div className={styles.restart}>
        {need && (
          <details>
            <summary>{copy.project.showNeed}</summary>
            <p className={stepStyles.need}>{need}</p>
          </details>
        )}
        <div className={stepStyles.actions}>
          <button
            type="button"
            ref={change}
            disabled={busy}
            onClick={() => {
              setWords(need);
              setEditing(true);
            }}
          >
            {copy.interview.changeNeed}
          </button>
        </div>
      </div>
    );
  }
  return (
    <form onSubmit={onSubmit} className={stepStyles.form} noValidate>
      <label htmlFor={fieldId}>{copy.interview.needLabel}</label>
      <textarea
        id={fieldId}
        rows={4}
        maxLength={2000}
        value={words}
        autoFocus
        aria-invalid={missing}
        aria-describedby={missing ? errorId : undefined}
        onChange={(event) => {
          setWords(event.target.value);
          setMissing(false);
        }}
      />
      {missing && (
        <p id={errorId} role="alert">
          {copy.interview.needEmpty}
        </p>
      )}
      <p className={stepStyles.warning}>{copy.interview.restartWarning(answers, items)}</p>
      <div className={stepStyles.actions}>
        <button type="submit" data-variant="primary" disabled={busy}>
          {copy.interview.restart}
        </button>
        <button type="button" onClick={close}>
          {copy.interview.keepQuestions}
        </button>
      </div>
    </form>
  );
}

type Props = {
  readonly project: Project;
  readonly interview: Interview;
  // The spec exists and the person asked to change what it was written from.
  readonly editing: boolean;
  readonly onEditingChange: (editing: boolean) => void;
  readonly onWriteMyself: () => void;
  readonly specFailed: Project["specError"];
};

// Describes the app by answering questions: one question at a time on one side, and the plan the
// answers are building on the other. The plan is the subject of the page, not a transcript.
export function InterviewStep({
  project,
  interview,
  editing,
  onEditingChange,
  onWriteMyself,
  specFailed,
}: Props) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const refresh = useRefreshProjects();
  // The item ids from before the latest turn; null until a turn has been taken on this page.
  const [known, setKnown] = useState<ReadonlySet<number> | null>(null);
  const [needPlan, setNeedPlan] = useState(false);
  // The plan is said back before the spec is written from it.
  const [checking, setChecking] = useState(false);
  const store = (next: Interview) => {
    queryClient.setQueryData(trpc.interview.get.queryKey({ id: project.id }), next);
    // An answer that changes the plan can send a reviewed project back to describing.
    void refresh();
  };
  const start = useMutation(trpc.interview.start.mutationOptions({ onSuccess: store }));
  const answer = useMutation(trpc.interview.answer.mutationOptions({ onSuccess: store }));
  const restart = useMutation(trpc.interview.restart.mutationOptions({ onSuccess: store }));
  const generate = useMutation(
    trpc.projects.generateSpec.mutationOptions({ onSettled: () => refresh() })
  );
  const remember = () => setKnown(new Set(interview.items.map((item) => item.id)));

  const reviewing = project.status === "spec_ready";
  const open = project.status === "draft" || (reviewing && editing);
  const started = interview.current !== null || interview.questions.length > 0;
  const thinking = start.isPending || answer.isPending || restart.isPending;
  const failure = answer.error ?? start.error ?? restart.error;
  const unavailable = failure !== null && classifyError(failure) === "unavailable";
  const fresh = new Set(
    known ? interview.items.filter((item) => !known.has(item.id)).map((item) => item.id) : []
  );
  const added = interview.items.filter((item) => fresh.has(item.id)).map((item) => item.text);

  const onStart = () => {
    remember();
    start.mutate({ id: project.id });
  };
  const onAnswer = (question: Question) => (given: Answer) => {
    remember();
    answer.mutate({ id: project.id, questionId: question.id, answer: given });
  };
  const onRestart = (need: string) => {
    remember();
    restart.mutate({ id: project.id, need });
  };
  const onCheck = () => {
    const ready = interview.items.some((item) => item.section === "does");
    setNeedPlan(!ready);
    setChecking(ready);
  };
  const onWriteSpec = () =>
    generate.mutate({ id: project.id }, { onSuccess: () => onEditingChange(false) });

  if (open && checking) {
    return (
      <>
        <ReadBackStep
          project={project}
          writing={generate.isPending}
          onWriteSpec={onWriteSpec}
          onBack={() => setChecking(false)}
        />
        <ErrorNote error={generate.error} />
      </>
    );
  }

  return (
    <section aria-labelledby="features" className={stepStyles.step}>
      <h2 id="features" className={styles.stepTitle}>
        {copy.project.featuresTitle}
      </h2>
      {/* One polite announcement per answer, so the plan's changes are heard as well as seen. */}
      <p role="status" className={styles.announce}>
        {added.length > 0 && copy.interview.added(added)}
      </p>
      <div className={styles.layout} data-open={open || undefined}>
        {open && (
          <div className={styles.ask}>
            {specFailed && <p role="alert">{copy.project.specFailed[specFailed]}</p>}
            {project.status === "draft" && started && !restart.isPending && (
              <Restart
                need={project.need}
                answers={interview.questions.length}
                items={interview.items.length}
                busy={thinking}
                onRestart={onRestart}
              />
            )}
            {reviewing && <p className={stepStyles.warning}>{copy.interview.discardWarning}</p>}
            {!started && !thinking && (
              <>
                <p>{copy.interview.intro}</p>
                <div className={stepStyles.actions}>
                  <button type="button" data-variant="primary" onClick={onStart}>
                    {copy.interview.start}
                  </button>
                  <button type="button" onClick={onWriteMyself}>
                    {copy.interview.writeMyself}
                  </button>
                </div>
              </>
            )}
            {interview.current && (
              <QuestionForm
                key={interview.current.id}
                question={interview.current}
                busy={thinking}
                focus={known !== null}
                onAnswer={onAnswer(interview.current)}
              />
            )}
            {thinking && (
              <p role="status" className={stepStyles.muted}>
                {started ? copy.interview.thinking : copy.interview.starting}
              </p>
            )}
            {unavailable ? (
              <div role="alert">
                <p>{copy.interview.unavailable}</p>
                {/* An answer is sent again from its own form; a missing question is asked for here. */}
                {!interview.current && (
                  <button type="button" onClick={onStart}>
                    {copy.interview.retry}
                  </button>
                )}
              </div>
            ) : (
              <ErrorNote error={failure} />
            )}
            {started && !interview.current && !thinking && !unavailable && (
              <p>{interview.finished ? copy.interview.finished : copy.interview.paused}</p>
            )}
            {started && !interview.current && !interview.finished && !thinking && !unavailable && (
              <button type="button" onClick={onStart}>
                {copy.interview.resume}
              </button>
            )}
          </div>
        )}
        <Plan interview={interview} fresh={fresh} />
      </div>
      {interview.questions.length > 0 && (
        <details className={styles.answers}>
          <summary>{copy.interview.answersTitle(interview.questions.length)}</summary>
          <dl>
            {interview.questions.map((question) => (
              <div key={question.id}>
                <dt>{question.text}</dt>
                <dd>{question.answer && answerText(question.answer)}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}
      {open && started && (
        <>
          <div className={stepStyles.actions}>
            <button
              type="button"
              data-variant={interview.current ? undefined : "primary"}
              disabled={thinking}
              onClick={onCheck}
            >
              {copy.readBack.open}
            </button>
            <button type="button" onClick={onWriteMyself}>
              {copy.interview.writeMyself}
            </button>
            {reviewing && (
              <button type="button" onClick={() => onEditingChange(false)}>
                {copy.project.cancelEdit}
              </button>
            )}
          </div>
          {needPlan && <p role="alert">{copy.interview.needPlan}</p>}
          <ErrorNote error={generate.error} />
        </>
      )}
    </section>
  );
}
