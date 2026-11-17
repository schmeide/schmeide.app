import { useState, type ReactNode } from "react";

import { copy } from "../data/copy";
import { pathTo, type RouteName } from "../utils/routes";
import { isAdmin } from "../utils/session";
import { AccountMenu } from "./AccountMenu";
import { ImpersonationBanner } from "./ImpersonationBanner";
import { LegalFooter } from "./LegalFooter";
import { Link } from "./Link";
import { useSession } from "./SessionProvider";

import styles from "./Shell.module.css";

const PRIMARY: readonly RouteName[] = ["apps", "usage", "billing", "help"];

type Props = {
  // The route being shown, marked in the navigation; null on a page that is no route.
  readonly current: RouteName | null;
  // Shown above the page on every route: a payment problem (#64), a new terms version (#68).
  readonly banner?: ReactNode;
  readonly children: ReactNode;
};

// The frame around every signed-in page: header, navigation, a banner slot, and the footer.
// What it offers follows the session: signed out, signed in with no business yet, or in a business,
// and the admin area to an admin. While an admin views the app as someone, a banner says so first.
export function Shell({ current, banner, children }: Props) {
  const { session, business, chooseBusiness } = useSession();
  const [menuOpen, setMenuOpen] = useState(false);
  // The business pages need a business; the admin area is offered only to admins.
  const primary: readonly RouteName[] = [
    ...(business ? PRIMARY : []),
    ...(isAdmin(session) ? (["admin"] as const) : []),
  ];

  return (
    <div className={styles.shell}>
      <a href="#main" className={styles.skip}>
        {copy.shell.skip}
      </a>
      <ImpersonationBanner />
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
          {primary.length > 0 && (
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
                  {primary.map((name) => (
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
      <LegalFooter />
    </div>
  );
}
