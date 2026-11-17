import { copy } from "../data/copy";
import { pathTo } from "../utils/routes";
import { Link } from "./Link";

import styles from "./StartWays.module.css";

const WAYS = [
  { way: "idea", route: "start" },
  { way: "existing", route: "startExisting" },
] as const;

type Props = { readonly current: (typeof WAYS)[number]["way"] };

export function StartWays({ current }: Props) {
  return (
    <nav aria-label={copy.start.ways.label} className={styles.ways}>
      <ul>
        {WAYS.map(({ way, route }) => (
          <li key={way}>
            <Link to={pathTo(route)} aria-current={way === current ? "page" : undefined}>
              {copy.start.ways[way]}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
