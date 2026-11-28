import { useQuery } from "@tanstack/react-query";
import { useId, useRef, useState, type FormEvent } from "react";

import { copy } from "../data/copy";
import { useTRPC, type ProjectStatus } from "../trpc";
import { clearCarried, IDEA_MAX, readCarried } from "../utils/carried";
import { pathTo } from "../utils/routes";
import { appName } from "../utils/appName";
import { ErrorNote } from "./ErrorNote";
import { Link } from "./Link";
import { StartWays } from "./StartWays";
import { useStartApp } from "./useStartApp";
import { Working } from "./Working";

import styles from "./StartPage.module.css";

const UNBUILT: readonly ProjectStatus[] = ["draft", "spec_generating", "spec_ready"];

export function StartPage() {
  const trpc = useTRPC();
  const titleId = useId();
  const errorId = useId();
  const field = useRef<HTMLTextAreaElement>(null);
  const [need, setNeed] = useState(() => readCarried() ?? "");
  const [missing, setMissing] = useState(false);
  const list = useQuery(trpc.projects.list.queryOptions());
  const { start, busy, error } = useStartApp();
  const unfinished = (list.data ?? []).filter((project) => UNBUILT.includes(project.status));

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = need.trim();
    setMissing(!text);
    if (!text) {
      field.current?.focus();
      return;
    }
    clearCarried();
    const point = copy.start.points.find((entry) => entry.need === text);
    start({ need: text, ...(point ? { name: point.name } : {}) });
  };

  return (
    <>
      <StartWays current="idea" />
      <form onSubmit={onSubmit} className={styles.form} noValidate>
        <h1 id={titleId} className={styles.title}>
          {copy.start.title}
        </h1>
        <p className={styles.intro}>{copy.start.intro}</p>
        <textarea
          ref={field}
          className={styles.need}
          rows={5}
          maxLength={IDEA_MAX}
          aria-labelledby={titleId}
          aria-invalid={missing}
          aria-describedby={missing ? errorId : undefined}
          placeholder={copy.start.needPlaceholder}
          value={need}
          disabled={busy}
          onChange={(event) => {
            setNeed(event.target.value);
            setMissing(false);
          }}
        />
        {missing && (
          <p id={errorId} className={styles.error}>
            {copy.start.needMissing}
          </p>
        )}

        <section aria-labelledby="starting-points" className={styles.points}>
          <h2 id="starting-points">{copy.start.pointsTitle}</h2>
          <p className={styles.muted}>{copy.start.pointsHint}</p>
          <ul>
            {copy.start.points.map((point) => (
              <li key={point.name}>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setNeed(point.need);
                    setMissing(false);
                    field.current?.focus();
                  }}
                >
                  {point.name}
                </button>
              </li>
            ))}
          </ul>
        </section>

        <div className={styles.actions}>
          <button type="submit" data-variant="primary" disabled={busy}>
            {copy.start.continue}
          </button>
          {busy && (
            <p role="status" className={styles.muted}>
              <Working>{copy.start.continuing}</Working>
            </p>
          )}
        </div>
        <ErrorNote error={error} />
        <p className={styles.muted}>
          {copy.start.builds} <Link to={pathTo("help")}>{copy.start.askForIt}</Link>
        </p>
      </form>

      {unfinished.length > 0 && (
        <section aria-labelledby="unfinished" className={styles.unfinished}>
          <h2 id="unfinished">{copy.start.unfinishedTitle}</h2>
          <ul>
            {unfinished.map((project) => (
              <li key={project.id}>
                <Link to={pathTo("project", { id: project.id })}>{appName(project)}</Link>
                <span className={styles.muted}>{copy.status[project.status].label}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
