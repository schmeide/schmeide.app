import { useMutation, useQuery } from "@tanstack/react-query";
import type { FormEvent } from "react";

import { copy } from "../data/copy";
import { useRefreshProjects, useTRPC } from "../trpc";
import { navigate } from "../utils/navigation";
import { pathTo } from "../utils/routes";
import { ErrorNote } from "./ErrorNote";
import { Link } from "./Link";

import styles from "./ProjectList.module.css";

export function ProjectList() {
  const trpc = useTRPC();
  const refresh = useRefreshProjects();
  const list = useQuery(trpc.projects.list.queryOptions());
  const create = useMutation(
    trpc.projects.create.mutationOptions({
      onSuccess: (project) => {
        void refresh();
        navigate(pathTo("project", { id: project.id }));
      },
    })
  );

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    create.mutate({ name: String(new FormData(event.currentTarget).get("name")) });
  };

  return (
    <>
      <header>
        <h1>{copy.list.title}</h1>
        <p className={styles.intro}>{copy.list.intro}</p>
      </header>

      <section aria-labelledby="how" className={styles.section}>
        <h2 id="how">{copy.list.howTitle}</h2>
        <ol>
          {copy.list.how.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="new-project" className={styles.section}>
        <h2 id="new-project">{copy.list.createTitle}</h2>
        <form onSubmit={onSubmit} className={styles.form}>
          <label htmlFor="project-name">{copy.list.nameLabel}</label>
          <div className={styles.row}>
            <input
              id="project-name"
              name="name"
              required
              maxLength={100}
              placeholder={copy.list.namePlaceholder}
              autoComplete="off"
            />
            <button type="submit" data-variant="primary" disabled={create.isPending}>
              {create.isPending ? copy.list.creating : copy.list.create}
            </button>
          </div>
        </form>
        <ErrorNote error={create.error} />
      </section>

      <section aria-labelledby="projects" className={styles.section}>
        <h2 id="projects">{copy.list.projectsTitle}</h2>
        <ErrorNote error={list.error} />
        {list.isPending && <p>{copy.loading}</p>}
        {list.data?.length === 0 && <p>{copy.list.empty}</p>}
        {list.data && list.data.length > 0 && (
          <ul className={styles.projects}>
            {list.data.map((project) => (
              <li key={project.id} className={styles.project}>
                <Link to={pathTo("project", { id: project.id })} className={styles.name}>
                  {project.name}
                </Link>
                <span className={styles.status} data-status={project.status}>
                  {copy.status[project.status].label}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
