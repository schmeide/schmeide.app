import { copy } from "../data/copy";
import { pathTo, type RouteName } from "../utils/routes";
import { Link } from "./Link";

import styles from "./LegalFooter.module.css";

const LEGAL: readonly RouteName[] = ["terms", "privacy", "acceptableUse", "report"];

// The legal links at the foot of every page, in the app shell and the entry frame alike.
export function LegalFooter() {
  return (
    <footer className={styles.footer}>
      <nav aria-label={copy.shell.legalNav}>
        <ul>
          {LEGAL.map((name) => (
            <li key={name}>
              <Link to={pathTo(name)}>{copy.routes[name]}</Link>
            </li>
          ))}
        </ul>
      </nav>
    </footer>
  );
}
