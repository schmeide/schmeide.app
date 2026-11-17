import type { ReactNode } from "react";

import { copy } from "../data/copy";
import { AccountMenu } from "./AccountMenu";
import { ImpersonationBanner } from "./ImpersonationBanner";
import { LegalFooter } from "./LegalFooter";

import styles from "./EntryFrame.module.css";

// The frame around sign-in, sign-up, set-password and first-run: the next step after
// schmeide.com rather than the inside of the tool. No app navigation; the logo leads back to the
// marketing site, and the account menu appears once someone is signed in, so they can sign out.
// While an admin views the app as someone with no business yet, the banner says so here too.
export function EntryFrame({ children }: { readonly children: ReactNode }) {
  return (
    <div className={styles.frame}>
      <a href="#main" className={styles.skip}>
        {copy.shell.skip}
      </a>
      <ImpersonationBanner />
      <header className={styles.header}>
        <a href={copy.outbound.marketingSite} className={styles.logo}>
          {copy.shell.logo}
          <span className={styles.hidden}>{copy.entry.logoHint}</span>
        </a>
        <AccountMenu />
      </header>
      <main id="main" tabIndex={-1} className={styles.main}>
        {children}
      </main>
      <LegalFooter />
    </div>
  );
}
