import { useRef, useState, type FocusEvent, type KeyboardEvent } from "react";

import { copy } from "../data/copy";
import { pathTo, type RouteName } from "../utils/routes";
import { Link } from "./Link";
import { useSession } from "./SessionProvider";

import styles from "./AccountMenu.module.css";

const WITH_BUSINESS: readonly RouteName[] = ["account", "business", "billing", "help"];
const WITHOUT_BUSINESS: readonly RouteName[] = ["account", "help"];

// The signed-in person's name, opening their pages and "Sign out". A disclosure of plain links
// rather than an ARIA menu, so Tab and Enter work as they do everywhere else.
export function AccountMenu() {
  const { session, business, signOut } = useSession();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  if (!session.person) return null;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || !open) return;
    setOpen(false);
    button.current?.focus();
  };
  // Close once focus leaves the menu, by Tab or by a click elsewhere.
  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  };

  return (
    <div className={styles.account} onKeyDown={onKeyDown} onBlur={onBlur}>
      <button
        type="button"
        ref={button}
        aria-expanded={open}
        aria-controls="account-menu"
        onClick={() => setOpen(!open)}
      >
        <span className={styles.name}>{session.person.name}</span>
      </button>
      <nav id="account-menu" aria-label={copy.shell.accountNav} hidden={!open}>
        <ul className={styles.items}>
          {(business ? WITH_BUSINESS : WITHOUT_BUSINESS).map((name) => (
            <li key={name}>
              <Link to={pathTo(name)} className={styles.item} onClick={() => setOpen(false)}>
                {copy.routes[name]}
              </Link>
            </li>
          ))}
          <li>
            <button type="button" className={styles.signOut} onClick={() => void signOut()}>
              {copy.shell.signOut}
            </button>
          </li>
        </ul>
      </nav>
    </div>
  );
}
