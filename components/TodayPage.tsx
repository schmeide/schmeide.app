import { useQuery } from "@tanstack/react-query";
import { useId, useRef, useState, type FormEvent } from "react";

import { copy } from "../data/copy";
import { useTRPC } from "../trpc";
import { pathTo } from "../utils/routes";
import { ErrorNote } from "./ErrorNote";
import { Link } from "./Link";
import { StartWays } from "./StartWays";
import { useStartApp } from "./useStartApp";

import styles from "./StartPage.module.css";

type Use = keyof typeof copy.today.uses;

const USES = Object.keys(copy.today.uses) as readonly Use[];

export function TodayPage() {
  const trpc = useTRPC();
  const hintId = useId();
  const usesErrorId = useId();
  const fixId = useId();
  const fixErrorId = useId();
  const keepId = useId();
  const usesField = useRef<HTMLFieldSetElement>(null);
  const fixField = useRef<HTMLTextAreaElement>(null);
  const [chosen, setChosen] = useState<readonly Use[]>([]);
  const [keep, setKeep] = useState("");
  const [keepDecided, setKeepDecided] = useState(false);
  const [fix, setFix] = useState("");
  const [checked, setChecked] = useState(false);
  const list = useQuery(trpc.projects.list.queryOptions());
  const { start, busy, error } = useStartApp();
  const picked = USES.filter((use) => chosen.includes(use));
  const usesMissing = checked && picked.length === 0;
  const fixMissing = checked && !fix.trim();

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setChecked(true);
    if (picked.length === 0) {
      usesField.current?.querySelector("input")?.focus();
      return;
    }
    if (!fix.trim()) {
      fixField.current?.focus();
      return;
    }
    start({
      name: copy.today.uses[picked[0]].appName,
      today: {
        uses: picked.map((use) => copy.today.uses[use].label),
        ...(keepDecided ? { keepDecided: true } : keep.trim() ? { keep: keep.trim() } : {}),
        fix: fix.trim(),
      },
    });
  };

  return (
    <>
      <StartWays current="existing" />
      <form onSubmit={onSubmit} className={styles.form} noValidate>
        <h1 className={styles.title}>{copy.today.title}</h1>
        <p className={styles.intro}>{copy.today.intro}</p>

        <fieldset
          ref={usesField}
          className={styles.kinds}
          disabled={busy}
          aria-describedby={usesMissing ? `${hintId} ${usesErrorId}` : hintId}
        >
          <legend>{copy.today.usesLegend}</legend>
          <p id={hintId} className={styles.muted}>
            {copy.today.usesHint}
          </p>
          {USES.map((use) => (
            <div key={use}>
              <label className={styles.check}>
                <input
                  type="checkbox"
                  checked={chosen.includes(use)}
                  onChange={(event) =>
                    setChosen(
                      event.target.checked
                        ? [...chosen, use]
                        : chosen.filter((entry) => entry !== use)
                    )
                  }
                />
                {copy.today.uses[use].label}
              </label>
              {chosen.includes(use) && copy.today.uses[use].note && (
                <p className={styles.note}>{copy.today.uses[use].note}</p>
              )}
            </div>
          ))}
          {usesMissing && (
            <p id={usesErrorId} className={styles.error}>
              {copy.today.usesMissing}
            </p>
          )}
        </fieldset>

        <div className={styles.field}>
          <label htmlFor={keepId}>{copy.today.keepLabel}</label>
          <textarea
            id={keepId}
            rows={3}
            maxLength={500}
            value={keep}
            disabled={busy || keepDecided}
            onChange={(event) => setKeep(event.target.value)}
          />
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={keepDecided}
              disabled={busy}
              onChange={(event) => setKeepDecided(event.target.checked)}
            />
            {copy.today.keepDecide}
          </label>
          {keepDecided && <p className={styles.muted}>{copy.today.keepDecideHint}</p>}
        </div>

        <div className={styles.field}>
          <label htmlFor={fixId}>{copy.today.fixLabel}</label>
          <textarea
            ref={fixField}
            id={fixId}
            rows={3}
            maxLength={500}
            value={fix}
            disabled={busy}
            aria-invalid={fixMissing}
            aria-describedby={fixMissing ? fixErrorId : undefined}
            onChange={(event) => setFix(event.target.value)}
          />
          {fixMissing && (
            <p id={fixErrorId} className={styles.error}>
              {copy.today.fixMissing}
            </p>
          )}
        </div>

        <div className={styles.actions}>
          <button type="submit" data-variant="primary" disabled={busy}>
            {copy.start.continue}
          </button>
          {busy && (
            <p role="status" className={styles.muted}>
              {copy.start.continuing}
            </p>
          )}
        </div>
        <ErrorNote error={error} />
        {list.data && list.data.length > 0 && (
          <p className={styles.muted}>
            {copy.today.builtHere} <Link to={pathTo("apps")}>{copy.today.builtHereLink}</Link>.
          </p>
        )}
      </form>
    </>
  );
}
