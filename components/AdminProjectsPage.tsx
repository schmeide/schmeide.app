import { useInfiniteQuery, useQueries } from "@tanstack/react-query";
import { useState } from "react";

import { copy } from "../data/copy";
import { useTRPC } from "../trpc";
import {
  describeFigure,
  formatBytes,
  formatCount,
  formatPercent,
  UNKNOWN_FIGURES,
  type Figures,
} from "../utils/resources";
import { pathTo } from "../utils/routes";
import { AdminSearch } from "./AdminSearch";
import { AdminTable } from "./AdminTable";
import { ErrorNote } from "./ErrorNote";
import { Link } from "./Link";
import { useSession } from "./SessionProvider";

import styles from "./AdminTable.module.css";

const day = new Intl.DateTimeFormat("en-US", { dateStyle: "medium" });

// Every hosted project across businesses. The rows come first; what each takes up is a second,
// slower read that fills in its columns when it answers.
export function AdminProjectsPage() {
  const trpc = useTRPC();
  const [search, setSearch] = useState("");
  const { session } = useSession();
  const list = useInfiniteQuery(
    trpc.admin.projects.list.infiniteQueryOptions(
      { search: search || undefined },
      { getNextPageParam: (page) => page.nextCursor }
    )
  );
  const pages = list.data?.pages ?? [];
  const entries = pages.flatMap((page) => page.entries);
  // One read per page, so showing more never reads the earlier pages again.
  const resources = useQueries({
    queries: pages.map((page) =>
      trpc.admin.projects.resources.queryOptions(
        { ids: page.entries.map(({ id }) => id) },
        { enabled: page.entries.length > 0 }
      )
    ),
  });
  // Empty while being read; a read that failed is unknown, as a figure the server could not read.
  const figuresById = new Map<number, Partial<Figures>>(
    pages.flatMap((page, index) =>
      page.entries.map(({ id }) => [
        id,
        resources[index]?.isError
          ? UNKNOWN_FIGURES
          : (resources[index]?.data?.find((figures) => figures.id === id) ?? {}),
      ])
    )
  );

  return (
    <>
      <header>
        <h1>{copy.routes.adminProjects}</h1>
        <p className={styles.intro}>{copy.hosting.intro}</p>
        {session.buildsOff && <p className={styles.intro}>{copy.resources.buildsOff}</p>}
      </header>
      <AdminSearch hint={copy.hosting.searchHint} onSearch={setSearch} />
      <ErrorNote error={list.error} />
      {list.isPending && <p>{copy.loading}</p>}
      {list.isSuccess && entries.length === 0 && <p>{copy.hosting.empty}</p>}
      {entries.length > 0 && (
        <AdminTable caption={copy.hosting.caption} columns={copy.hosting.columns}>
          {entries.map((project) => {
            const figures = figuresById.get(project.id) ?? {};
            return (
              <tr key={project.id}>
                <td>{project.name}</td>
                <td>
                  <Link to={pathTo("adminBusiness", { id: project.business.id })}>
                    {project.business.name || project.business.id}
                  </Link>
                </td>
                <td>{copy.status[project.status].label}</td>
                <td className={styles.number}>{project.webPort}</td>
                <td>
                  {project.lastBuild ? (
                    <>
                      <span className={styles.stacked}>
                        {copy.project.buildStatus[project.lastBuild.status]}
                      </span>
                      <time dateTime={project.lastBuild.startedAt.toISOString()}>
                        {day.format(project.lastBuild.startedAt)}
                      </time>
                    </>
                  ) : (
                    copy.hosting.neverBuilt
                  )}
                </td>
                <td className={styles.number}>{describeFigure(figures.containers, formatCount)}</td>
                <td className={styles.number}>
                  {describeFigure(figures.memoryBytes, formatBytes)}
                </td>
                <td className={styles.number}>
                  {describeFigure(figures.cpuPercent, formatPercent)}
                </td>
                <td className={styles.number}>
                  {describeFigure(figures.workspaceBytes, formatBytes)}
                </td>
              </tr>
            );
          })}
        </AdminTable>
      )}
      {list.hasNextPage && (
        <button
          type="button"
          className={styles.more}
          disabled={list.isFetchingNextPage}
          onClick={() => void list.fetchNextPage()}
        >
          {list.isFetchingNextPage ? copy.loading : copy.adminSearch.more}
        </button>
      )}
    </>
  );
}
