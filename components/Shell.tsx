import { useState, type ReactNode } from "react";

import { copy } from "../data/copy";
import { pathTo, type RouteName } from "../utils/routes";
import { AccountMenu } from "./AccountMenu";
import { Link } from "./Link";
import { useSession } from "./SessionProvider";

import styles from "./Shell.module.css";

const PRIMARY: readonly RouteName[] = ["apps", "usage", "billing", "help"];
const LEGAL: readonly RouteName[] = ["terms", "privacy", "acceptableUse", "report"];

type Props = {
  // The route being shown, marked in the navigation; null on a page that is no route.
  readonly current: RouteName | null;
  // Shown above the page on every route: a payment problem (#64), a new terms version (#68).
  readonly banner?: ReactNode;
  readonly children: ReactNode;
};

// The frame around every signed-in page: header, navigation, a banner slot, and the footer.
// What it offers follows the session: signed out, signed in with no business yet, or in a business.
export function Shell({ current, banner, children }: Props) {
  const { session, business, chooseBusiness } = useSession();
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className={styles.shell}>
      <a href="#main" className={styles.skip}>
        {copy.shell.skip}
      </a>
      <header className={styles.header}>
        <div className={styles.bar}>
          <Link to={pathTo("apps")} className={styles.logo}>
            {copy.shell.logo}
          </Link>
          {business &&
            (session.businesses.length > 1 ? (
              <select
                className={styles.switcher}
                aria-label={copy.shell.businessLabel}
                value={business.id}
                onChange={(event) => chooseBusiness(Number(event.target.value))}
              >
                {session.businesses.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name}
                  </option>
                ))}
              </select>
            ) : (
              <span className={styles.business}>{business.name}</span>
            ))}
          <span className={styles.spacer} />
          {business && (
            <>
              <button
                type="button"
                className={styles.menuButton}
                aria-expanded={menuOpen}
                aria-controls="primary-nav"
                onClick={() => setMenuOpen(!menuOpen)}
              >
                {copy.shell.menu}
              </button>
              <nav
                id="primary-nav"
                aria-label={copy.shell.primaryNav}
                className={styles.nav}
                data-open={menuOpen || undefined}
              >
                <ul>
                  {PRIMARY.map((name) => (
                    <li key={name}>
                      <Link
                        to={pathTo(name)}
                        aria-current={name === current ? "page" : undefined}
                        onClick={() => setMenuOpen(false)}
                      >
                        {copy.routes[name]}
                      </Link>
                    </li>
                  ))}
                </ul>
              </nav>
            </>
          )}
          {session.person ? (
            <AccountMenu />
          ) : (
            current !== "signIn" && <Link to={pathTo("signIn")}>{copy.shell.signIn}</Link>
          )}
        </div>
      </header>
      {banner && (
        <aside aria-label={copy.shell.notices} className={styles.banner}>
          <div className={styles.bannerInner}>{banner}</div>
        </aside>
      )}
      <main id="main" tabIndex={-1} className={styles.main}>
        {children}
      </main>
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
    </div>
  );
}
