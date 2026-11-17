import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";

import { copy } from "../data/copy";
import { useTRPC } from "../trpc";
import { pathTo } from "../utils/routes";
import { currentMonth } from "../utils/usage";
import { AdminUsageTable } from "./AdminUsageTable";
import { ErrorNote } from "./ErrorNote";
import { Link } from "./Link";

import styles from "./AdminTable.module.css";

// Tokens and cost across businesses for a period, the current month in UTC unless chosen.
export function AdminUsagePage() {
  const trpc = useTRPC();
  const id = useId();
  const [period, setPeriod] = useState(() => currentMonth(new Date()));
  const summary = useQuery(trpc.admin.usage.summary.queryOptions(period));
  // A cleared date input keeps the last day chosen.
  const choose = (end: "from" | "to") => (value: string) => {
    if (value) setPeriod((current) => ({ ...current, [end]: value }));
  };
  const data = summary.data;

  return (
    <>
      <header>
        <h1>{copy.routes.adminUsage}</h1>
        <p className={styles.intro}>{copy.usage.intro}</p>
      </header>
      <fieldset className={styles.period}>
        <legend>{copy.usage.period}</legend>
        <div>
          <label htmlFor={`${id}-from`}>{copy.usage.from}</label>
          <input
            id={`${id}-from`}
            type="date"
            value={period.from}
            max={period.to}
            onChange={(event) => choose("from")(event.target.value)}
          />
          <label htmlFor={`${id}-to`}>{copy.usage.to}</label>
          <input
            id={`${id}-to`}
            type="date"
            value={period.to}
            min={period.from}
            onChange={(event) => choose("to")(event.target.value)}
          />
        </div>
        <p className={styles.note}>{copy.usage.timezone}</p>
      </fieldset>
      <p className={styles.note}>{copy.usage.deletedProjects}</p>

      <ErrorNote error={summary.error} />
      {summary.isPending && <p>{copy.loading}</p>}
      {data && data.businesses.length === 0 && <p>{copy.usage.empty}</p>}
      {data && data.businesses.length > 0 && (
        <>
          <section aria-labelledby="usage-businesses" className={styles.section}>
            <h2 id="usage-businesses">{copy.usage.businessesTitle}</h2>
            <AdminUsageTable
              caption={copy.usage.businessesCaption}
              label={copy.usage.business}
              rows={data.businesses.map((business) => ({
                key: business.id,
                label: (
                  <Link to={pathTo("adminBusiness", { id: business.id })}>
                    {business.name || business.id}
                  </Link>
                ),
                totals: business,
              }))}
            />
          </section>
          <section aria-labelledby="usage-projects" className={styles.section}>
            <h2 id="usage-projects">{copy.usage.projectsTitle}</h2>
            <AdminUsageTable
              caption={copy.usage.projectsCaption}
              label={copy.usage.project}
              rows={data.projects.map((project) => ({
                key: project.id,
                label: (
                  <>
                    <span className={styles.stacked}>{project.name}</span>
                    <Link to={pathTo("adminBusiness", { id: project.business.id })}>
                      {project.business.name || project.business.id}
                    </Link>
                  </>
                ),
                totals: project,
              }))}
            />
          </section>
          <section aria-labelledby="usage-models" className={styles.section}>
            <h2 id="usage-models">{copy.usage.modelsTitle}</h2>
            <AdminUsageTable
              caption={copy.usage.modelsCaption}
              label={copy.usage.model}
              rows={data.models.map((model) => ({
                key: model.model,
                label: <code>{model.model}</code>,
                totals: model,
              }))}
            />
          </section>
          <section aria-labelledby="usage-run-kinds" className={styles.section}>
            <h2 id="usage-run-kinds">{copy.usage.runKindsTitle}</h2>
            <AdminUsageTable
              caption={copy.usage.runKindsCaption}
              label={copy.usage.runKind}
              rows={data.runKinds.map((kind) => ({
                key: kind.runKind,
                label: <code>{kind.runKind}</code>,
                totals: kind,
              }))}
            />
          </section>
        </>
      )}
    </>
  );
}
