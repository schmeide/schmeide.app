import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useRef, useState, type FormEvent } from "react";

import { copy } from "../data/copy";
import { useRefreshProjects, useTRPC, type ProjectStatus } from "../trpc";
import { navigate } from "../utils/navigation";
import { pathTo } from "../utils/routes";
import { ErrorNote } from "./ErrorNote";
import { Link } from "./Link";

import styles from "./StartPage.module.css";

type Kind = keyof typeof copy.start.replacing.kinds;

const KINDS = Object.keys(copy.start.replacing.kinds) as readonly Kind[];
const UNBUILT: readonly ProjectStatus[] = ["draft", "spec_generating", "spec_ready"];

const replacedBy = (kind: Kind, name: string): string =>
  kind === "product" && name.trim()
    ? copy.start.replacing.named(name.trim())
    : copy.start.replacing.kinds[kind].replaces;

export function StartPage() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const refresh = useRefreshProjects();
  const titleId = useId();
  const errorId = useId();
  const field = useRef<HTMLTextAreaElement>(null);
  const [need, setNeed] = useState("");
  const [missing, setMissing] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [kind, setKind] = useState<Kind | null>(null);
  const [productName, setProductName] = useState("");
  const list = useQuery(trpc.projects.list.queryOptions());
  const create = useMutation(trpc.projects.create.mutationOptions());
  const start = useMutation(trpc.interview.start.mutationOptions());
  const busy = create.isPending || start.isPending;
  const unfinished = (list.data ?? []).filter((project) => UNBUILT.includes(project.status));

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = need.trim();
    setMissing(!text);
    if (!text) {
      field.current?.focus();
      return;
    }
    const point = copy.start.points.find((entry) => entry.need === text);
    create.mutate(
      {
        need: text,
        ...(point ? { name: point.name } : {}),
        ...(replacing && kind ? { replaces: replacedBy(kind, productName) } : {}),
      },
      {
        onSuccess: (project) => {
          const open = () => {
            void refresh();
            navigate(pathTo("project", { id: project.id }));
          };
          start.mutate(
            { id: project.id },
            {
              onSuccess: (interview) =>
                queryClient.setQueryData(
                  trpc.interview.get.queryKey({ id: project.id }),
                  interview
                ),
              onSettled: open,
            }
          );
        },
      }
    );
  };

  return (
    <>
      <form onSubmit={onSubmit} className={styles.form} noValidate>
        <h1 id={titleId} className={styles.title}>
          {copy.start.title}
        </h1>
        <p className={styles.intro}>{copy.start.intro}</p>
        <textarea
          ref={field}
          className={styles.need}
          rows={5}
          maxLength={2000}
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

        <div className={styles.replacing}>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={replacing}
              disabled={busy}
              onChange={(event) => setReplacing(event.target.checked)}
            />
            {copy.start.replacing.toggle}
          </label>
          {replacing && (
            <fieldset className={styles.kinds} disabled={busy}>
              <legend>{copy.start.replacing.legend}</legend>
              {KINDS.map((entry) => (
                <label key={entry} className={styles.check}>
                  <input
                    type="radio"
                    name="replacing"
                    checked={kind === entry}
                    onChange={() => setKind(entry)}
                  />
                  {copy.start.replacing.kinds[entry].label}
                </label>
              ))}
              {kind === "product" && (
                <>
                  <label className={styles.name}>
                    {copy.start.replacing.nameLabel}
                    <input
                      type="text"
                      maxLength={100}
                      autoComplete="off"
                      value={productName}
                      onChange={(event) => setProductName(event.target.value)}
                    />
                  </label>
                  <p className={styles.note}>{copy.start.replacing.productNote}</p>
                </>
              )}
            </fieldset>
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
        <ErrorNote error={create.error} />
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
                <Link to={pathTo("project", { id: project.id })}>{project.name}</Link>
                <span className={styles.muted}>{copy.status[project.status].label}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
