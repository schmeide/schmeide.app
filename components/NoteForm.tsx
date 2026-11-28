import { useId, useRef, useState, type FormEvent } from "react";

import { copy } from "../data/copy";
import { classifyError } from "../utils/apiError";
import { ErrorNote } from "./ErrorNote";
import { useDraft } from "./useDraft";
import { Working } from "./Working";

import stepStyles from "./Step.module.css";
import styles from "./NoteForm.module.css";

// The same limit as an answer in the person's own words (WORDS_MAX on the server).
const NOTE_MAX = 2000;

type Props = {
  readonly projectId: number;
  // Another turn is in flight: the box can be written in, not sent.
  readonly busy: boolean;
  readonly sending: boolean;
  readonly error: { readonly message: string } | null;
  // `sent` is called once the note is in, saying whether it changed the plan.
  readonly onSend: (text: string, sent: (changed: boolean) => void) => void;
};

// "Anything else?": a note of the person's own, outside the question waiting. On wide screens it is
// always open under the question; on narrow ones "Add something else" opens it, so it does not push
// the question down. Unsent words are kept as a draft, as answers are.
export function NoteForm({ projectId, busy, sending, error, onSend }: Props) {
  const fieldId = useId();
  const hintId = useId();
  const errorId = useId();
  const bodyId = useId();
  const field = useRef<HTMLTextAreaElement>(null);
  const [open, setOpen] = useState(false);
  const [words, setWords] = useDraft(`note:${projectId}`);
  const [missing, setMissing] = useState(false);
  const [unchanged, setUnchanged] = useState(false);
  const unavailable = error !== null && classifyError(error) === "unavailable";

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // Held with aria-disabled, so the button keeps focus while the note is sent.
    if (sending) return;
    const text = words.trim();
    setMissing(!text);
    setUnchanged(false);
    if (!text) {
      field.current?.focus();
      return;
    }
    onSend(text, (changed) => {
      setWords("");
      setUnchanged(!changed);
    });
  };

  return (
    <div className={styles.note}>
      <button
        type="button"
        className={styles.toggle}
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen(!open)}
      >
        {copy.interview.noteOpen}
      </button>
      <form
        id={bodyId}
        className={styles.body}
        data-open={open || undefined}
        onSubmit={onSubmit}
        noValidate
      >
        <label htmlFor={fieldId} className={styles.label}>
          {copy.interview.noteLabel}
        </label>
        <p id={hintId} className={stepStyles.muted}>
          {copy.interview.noteHint}
        </p>
        <textarea
          id={fieldId}
          ref={field}
          rows={3}
          maxLength={NOTE_MAX}
          value={words}
          readOnly={sending}
          aria-invalid={missing}
          aria-describedby={missing ? `${hintId} ${errorId}` : hintId}
          onChange={(event) => {
            setWords(event.target.value);
            setMissing(false);
            setUnchanged(false);
          }}
        />
        {missing && (
          <p id={errorId} role="alert">
            {copy.interview.noteEmpty}
          </p>
        )}
        <div className={stepStyles.actions}>
          <button type="submit" disabled={busy} aria-disabled={sending || undefined}>
            {sending ? <Working>{copy.interview.noteSending}</Working> : copy.interview.noteSend}
          </button>
        </div>
        {unchanged && (
          <p>
            <span>{copy.interview.noteUnchanged}</span>{" "}
            <a href="#plan">{copy.interview.noteToPlan}</a>
          </p>
        )}
        {unavailable ? (
          <p role="alert">{copy.interview.noteFailed}</p>
        ) : (
          <ErrorNote error={error} />
        )}
      </form>
    </div>
  );
}
