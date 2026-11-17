import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";

import { copy } from "../data/copy";
import { useRefreshProjects, useTRPC, type Project } from "../trpc";
import { ErrorNote } from "./ErrorNote";

import stepStyles from "./Step.module.css";
import styles from "./LookStep.module.css";

type Props = { readonly project: Project };

// The look of the app, in plain words, and picking another. Nothing shows while the design team
// is off. Picking restyles a built app as a change, which the server starts or queues.
export function LookStep({ project }: Props) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const refresh = useRefreshProjects();
  const design = useQuery(trpc.design.get.queryOptions({ id: project.id }));
  const [picked, setPicked] = useState<string | null>(null);
  const pick = useMutation(
    trpc.design.pick.mutationOptions({
      onSuccess: () => setPicked(null),
      onSettled: async () => {
        await queryClient.invalidateQueries({ queryKey: trpc.design.pathKey() });
        await refresh();
      },
    })
  );
  if (!design.data?.enabled) return null;
  const { current, styles: looks } = design.data;
  const chosen = picked ?? current?.style ?? null;
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (picked) pick.mutate({ id: project.id, style: picked });
  };

  return (
    <section aria-labelledby="look" className={stepStyles.step}>
      <h2 id="look">{copy.project.look.title}</h2>
      {current ? (
        <>
          <p>
            {copy.project.look.current(current.name)} {current.summary}
          </p>
          <p className={stepStyles.muted}>
            {copy.project.look.why[current.chosenBy](current.reason)}
          </p>
        </>
      ) : (
        <p>{copy.project.look.none}</p>
      )}
      <form onSubmit={onSubmit} className={stepStyles.form}>
        <fieldset className={styles.looks} disabled={pick.isPending}>
          <legend>{copy.project.look.pickLabel}</legend>
          {looks.map((look) => (
            <label key={look.id} className={styles.look}>
              <input
                type="radio"
                name="look"
                value={look.id}
                checked={chosen === look.id}
                onChange={() => setPicked(look.id)}
              />
              <span>
                <strong>{look.name}</strong> {look.summary}
              </span>
            </label>
          ))}
        </fieldset>
        <p className={stepStyles.muted}>{copy.project.look.note}</p>
        <ErrorNote error={pick.error} />
        <div className={stepStyles.actions}>
          <button type="submit" disabled={!picked || picked === current?.style || pick.isPending}>
            {copy.project.look.use}
          </button>
        </div>
      </form>
    </section>
  );
}
