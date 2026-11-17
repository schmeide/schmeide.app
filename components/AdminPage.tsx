import { copy } from "../data/copy";
import { pathTo, type RouteName } from "../utils/routes";
import { Link } from "./Link";

import styles from "./AdminPage.module.css";

// The admin area's sections, in the order they are offered. A new admin screen adds its route here.
const SECTIONS: readonly RouteName[] = [
  "adminBusinesses",
  "adminPeople",
  "adminProjects",
  "adminAudit",
];

export function AdminPage() {
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
                {copy.routes[name]}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </>
  );
}
