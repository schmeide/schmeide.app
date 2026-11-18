import { useQuery } from "@tanstack/react-query";

import { copy } from "../data/copy";
import { useTRPC } from "../trpc";
import { ageOf } from "../utils/reviewAge";
import { pathTo, type RouteName } from "../utils/routes";
import { Link } from "./Link";

import styles from "./AdminPage.module.css";

// The admin area's sections, in the order they are offered. A new admin screen adds its route here.
const SECTIONS: readonly RouteName[] = [
  "adminBusinesses",
  "adminPeople",
  "adminAdmins",
  "adminProjects",
  "adminUsage",
  "adminAudit",
  "adminReview",
];

export function AdminPage() {
  const trpc = useTRPC();
  const open = useQuery(trpc.admin.review.open.queryOptions());
  const reviewLabel = () => {
    const summary = open.data;
    if (!summary || summary.count === 0) return copy.routes.adminReview;
    const parts = summary.oldestAt ? ageOf(summary.oldestAt, new Date()) : null;
    const age = parts ? copy.review.age(parts.amount, parts.unit) : null;
    return age
      ? `${copy.routes.adminReview} ${copy.review.openCount(summary.count)}, ${copy.review.oldest(age)}`
      : `${copy.routes.adminReview} ${copy.review.openCount(summary.count)}`;
  };
  return (
    <>
      <header>
        <h1>{copy.routes.admin}</h1>
        <p className={styles.intro}>{copy.admin.intro}</p>
      </header>
      <nav aria-label={copy.admin.sectionsNav}>
        <ul className={styles.sections}>
          {SECTIONS.map((name) => (
            <li key={name}>
              <Link to={pathTo(name)} className={styles.section}>
                {name === "adminReview" ? reviewLabel() : copy.routes[name]}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </>
  );
}
