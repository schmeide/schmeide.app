import { useMutation } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";

import { copy } from "../data/copy";
import { useRefreshProjects, useTRPC, type Project, type Usage } from "../trpc";
import { ErrorNote } from "./ErrorNote";

import stepStyles from "./Step.module.css";
import styles from "./LiveStep.module.css";

const count = new Intl.NumberFormat("en-US");
const TOKEN_FIELDS = [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheCreationTokens",
] as const;

type Props = { readonly project: Project; readonly usage: Usage };

// During and after a build: a box to request a change (it waits its turn while a build runs), and
// what the project has cost so far.
export function LiveStep({ project, usage }: Props) {
  const trpc = useTRPC();
  const refresh = useRefreshProjects();
  const [request, setRequest] = useState("");
  const change = useMutation(
    trpc.projects.requestChange.mutationOptions({
      onSuccess: () => setRequest(""),
      onSettled: () => refresh(),
    })
  );
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    change.mutate({ id: project.id, request });
  };

  return (
    <section aria-labelledby="live" className={stepStyles.step}>
      <h2 id="live">{copy.project.liveTitle}</h2>

      <form onSubmit={onSubmit} className={stepStyles.form}>
        <h3 className={styles.formTitle}>{copy.project.changeTitleForm}</h3>
        <p className={stepStyles.muted}>
          {project.status === "failed"
            ? copy.project.changeRetryIntro
            : project.status === "building"
              ? copy.project.changeQueueIntro
              : copy.project.changeIntro}
        </p>
        <label htmlFor="change-request">{copy.project.changeLabel}</label>
        <textarea
          id="change-request"
          rows={3}
          required
          maxLength={5000}
          value={request}
          onChange={(event) => setRequest(event.target.value)}
          placeholder={copy.project.changePlaceholder}
        />
        <div className={stepStyles.actions}>
          <button
            type="submit"
            data-variant="primary"
            disabled={change.isPending || !request.trim()}
          >
            {change.isPending ? copy.project.requesting : copy.project.requestChange}
          </button>
        </div>
        <ErrorNote error={change.error} />
      </form>

      <h3>{copy.project.usageTitle}</h3>
      <dl className={styles.usage}>
        {TOKEN_FIELDS.map((field) => (
          <div key={field}>
            <dt>{copy.project.usage[field]}</dt>
            <dd>{count.format(usage[field])}</dd>
          </div>
        ))}
        <div>
          <dt>{copy.project.usage.costUsd}</dt>
          <dd>${usage.costUsd.toFixed(2)}</dd>
        </div>
      </dl>
    </section>
  );
}
