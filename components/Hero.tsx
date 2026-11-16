import { copy } from "../data/copy";

import styles from "./Hero.module.css";

export function Hero() {
  return (
    <section className={styles.hero}>
      <h1 className={styles.headline}>{copy.hero.headline}</h1>
      <p className={styles.tagline}>{copy.hero.tagline}</p>
    </section>
  );
}
