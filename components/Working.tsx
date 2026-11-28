import { Gather } from "loading-dev";
import { useSyncExternalStore, type ReactNode } from "react";

import styles from "./Working.module.css";

type Props = {
  // The wait's own words; the spinner is decoration beside them.
  readonly children?: ReactNode;
  // "page" for a wait that holds the whole page, such as writing the spec or building.
  readonly size?: "inline" | "page";
};

const REDUCE = "(prefers-reduced-motion: reduce)";

// jsdom and old browsers have no matchMedia; they get the moving spinner.
const subscribe = (onChange: () => void) => {
  const list = typeof window.matchMedia === "function" ? window.matchMedia(REDUCE) : null;
  list?.addEventListener("change", onChange);
  return () => list?.removeEventListener("change", onChange);
};
const reducedMotion = () =>
  typeof window.matchMedia === "function" && window.matchMedia(REDUCE).matches;

// A wait in progress: the spinner beside its text. The spinner appears after a short delay (in
// the CSS) so a fast answer does not flash one, and holds still under reduced motion.
export function Working({ children, size = "inline" }: Props) {
  const reduced = useSyncExternalStore(subscribe, reducedMotion, () => false);
  return (
    <>
      <span aria-hidden="true" data-testid="working" className={styles.spinner}>
        <Gather
          className={size === "page" ? styles.page : styles.inline}
          playState={reduced ? "paused" : "running"}
        />
      </span>
      {children}
    </>
  );
}
