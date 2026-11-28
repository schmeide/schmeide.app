import { useMutation } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";

import { copy } from "../data/copy";
import { useRefreshProjects, useTRPC, type Project } from "../trpc";
import { ErrorNote } from "./ErrorNote";

import styles from "./Step.module.css";

// The app's name in Schmeide. Its slug, and so its address, stays what it was made with.
export function NameStep({ project }: { readonly project: Project }) {
  const trpc = useTRPC();
  const refresh = useRefreshProjects();
  const [name, setName] = useState(project.name);
  const save = useMutation(trpc.projects.rename.mutationOptions({ onSettled: () => refresh() }));
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    save.mutate({ id: project.id, name });
  };

  return (
    <section aria-labelledby="name" className={styles.step}>
      <h2 id="name">{copy.project.name.title}</h2>
      <form onSubmit={onSubmit} className={styles.form}>
        <p className={styles.muted}>{copy.project.name.intro}</p>
        <label htmlFor="app-name">{copy.project.name.label}</label>
        <input
          id="app-name"
          type="text"
          required
          maxLength={100}
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            save.reset();
          }}
        />
        <div className={styles.actions}>
          <button type="submit" disabled={save.isPending}>
            {save.isPending ? copy.project.saving : copy.project.name.save}
          </button>
          {save.isSuccess && <span className={styles.muted}>{copy.project.name.saved}</span>}
        </div>
        <ErrorNote error={save.error} />
      </form>
    </section>
  );
}
