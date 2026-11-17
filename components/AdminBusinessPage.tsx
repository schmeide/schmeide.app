import { useQuery } from "@tanstack/react-query";

import { copy } from "../data/copy";
import { useTRPC } from "../trpc";
import {
  describeFigure,
  formatBytes,
  formatCount,
  formatPercent,
  sumResources,
} from "../utils/resources";
import { AdminTable } from "./AdminTable";
import { ErrorNote } from "./ErrorNote";
import { ViewAsDisclosure } from "./ViewAsDisclosure";

import styles from "./AdminTable.module.css";

const day = new Intl.DateTimeFormat("en-US", { dateStyle: "medium" });

// One business: who is in it, with a way to view the app as each customer, and what it has made.
// Later admin tickets add their sections here.
export function AdminBusinessPage({ id }: { readonly id: number }) {
  const trpc = useTRPC();
  const query = useQuery(trpc.admin.businesses.get.queryOptions({ id }));
  const ids = query.data?.projects.map((project) => project.id).slice(0, 100) ?? [];
  const resources = useQuery(
    trpc.admin.projects.resources.queryOptions({ ids }, { enabled: ids.length > 0 })
  );

  if (!query.data)
    return (
      <>
        <h1>{copy.routes.adminBusiness}</h1>
        <ErrorNote error={query.error} />
        {query.isPending && <p>{copy.loading}</p>}
      </>
    );

  const { business, members, projects } = query.data;
  // Over more than the hundred apps read at once, the sums are unknown rather than short.
  const totals =
    projects.length === 0 || resources.data
      ? sumResources(resources.data ?? [], projects.length)
      : resources.isError
        ? sumResources([], projects.length)
        : undefined;
  const tiles = [
    [copy.resources.containers, describeFigure(totals?.containers, formatCount)],
    [copy.resources.memory, describeFigure(totals?.memoryBytes, formatBytes)],
    [copy.resources.cpu, describeFigure(totals?.cpuPercent, formatPercent)],
    [copy.resources.workspace, describeFigure(totals?.workspaceBytes, formatBytes)],
  ] as const;
  return (
    <>
      <header>
        <h1>{business.name || business.slug}</h1>
        <dl className={styles.facts}>
          <div>
            <dt>{copy.business.slug}</dt>
            <dd>{business.slug}</dd>
          </div>
          <div>
            <dt>{copy.business.created}</dt>
            <dd>
              <time dateTime={business.createdAt.toISOString()}>
                {day.format(business.createdAt)}
              </time>
            </dd>
          </div>
        </dl>
      </header>

      <section aria-labelledby="business-members" className={styles.section}>
        <h2 id="business-members">{copy.business.membersTitle}</h2>
        {members.length === 0 ? (
          <p>{copy.business.noMembers}</p>
        ) : (
          <AdminTable caption={copy.business.membersTitle} columns={copy.business.memberColumns}>
            {members.map((member) => (
              <tr key={member.email}>
                <td>{member.name}</td>
                <td>{member.email}</td>
                <td>{copy.business.roles[member.role]}</td>
                <td>
                  <ViewAsDisclosure name={member.name} email={member.email} admin={member.admin} />
                </td>
              </tr>
            ))}
          </AdminTable>
        )}
      </section>

      <section aria-labelledby="business-projects" className={styles.section}>
        <h2 id="business-projects">{copy.business.projectsTitle}</h2>
        {projects.length === 0 ? (
          <p>{copy.business.noProjects}</p>
        ) : (
          <AdminTable caption={copy.business.projectsTitle} columns={copy.business.projectColumns}>
            {projects.map((project) => (
              <tr key={project.id}>
                <td>{project.name}</td>
                <td>{copy.status[project.status].label}</td>
              </tr>
            ))}
          </AdminTable>
        )}
      </section>

      <section aria-labelledby="business-resources" className={styles.section}>
        <h2 id="business-resources">{copy.resources.title}</h2>
        <p className={styles.note}>{copy.resources.intro}</p>
        <dl className={styles.tiles}>
          {tiles.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      </section>
    </>
  );
}
