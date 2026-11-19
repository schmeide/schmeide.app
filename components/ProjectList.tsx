import { useQuery } from "@tanstack/react-query";

import { copy } from "../data/copy";
import { useTRPC } from "../trpc";
import { pathTo } from "../utils/routes";
import { appName } from "../utils/appName";
import { ErrorNote } from "./ErrorNote";
import { Link } from "./Link";
import { StartPage } from "./StartPage";

import styles from "./ProjectList.module.css";

export function ProjectList() {
  const trpc = useTRPC();
  const list = useQuery(trpc.projects.list.queryOptions());
  if (list.data?.length === 0) return <StartPage />;

  return (
    <>
      <header className={styles.header}>
        <h1>{copy.list.title}</h1>
        <Link to={pathTo("start")} className={styles.newApp}>
          {copy.list.newApp}
        </Link>
      </header>
      <ErrorNote error={list.error} />
      {list.isPending && <p>{copy.loading}</p>}
      {list.data && (
        <ul className={styles.projects}>
          {list.data.map((project) => {
            const canceled =
              project.status === "failed" && project.latestBuildStatus === "canceled";
            return (
              <li key={project.id} className={styles.project}>
                <Link to={pathTo("project", { id: project.id })} className={styles.name}>
                  {appName(project)}
                </Link>
                <span
                  className={styles.status}
                  data-status={canceled ? "canceled" : project.status}
                >
                  {canceled ? copy.project.buildStatus.canceled : copy.status[project.status].label}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
