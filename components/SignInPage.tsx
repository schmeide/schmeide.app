import { useState, type FormEvent } from "react";

import { copy } from "../data/copy";
import { providerSignInUrl, signInWithPassword, type PasswordSignIn } from "../utils/authApi";
import { leaveTo } from "../utils/navigation";
import { carryPlan, nextPath } from "../utils/routes";
import type { Provider } from "../utils/session";
import { useSession } from "./SessionProvider";

import errorStyles from "./ErrorNote.module.css";
import styles from "./SignInPage.module.css";

const refusals: Readonly<Record<string, string>> = copy.signInPage.refused;
const problems: Readonly<Record<Exclude<PasswordSignIn, "ok">, string>> = {
  wrong: copy.signInPage.wrong,
  notApproved: copy.signInPage.refused.not_approved,
  tooMany: copy.signInPage.tooMany,
  failed: copy.signInPage.failed,
};

// Sign in with a provider or with email and password. Once the session says who this is, the
// route guard sends the person on to the page they asked for.
export function SignInPage() {
  const { providers, refresh, signedOutHere } = useSession();
  const search = window.location.search;
  // A provider sign-in that was refused comes back here with the reason.
  const returned = new URLSearchParams(search).get("error");
  const [problem, setProblem] = useState<string | null>(
    returned && (refusals[returned] ?? copy.signInPage.providerFailed)
  );
  const [busy, setBusy] = useState(false);
  // Deleting an account ends here, signed out.
  const deleted = new URLSearchParams(search).has("deleted");

  const withProvider = async (provider: Provider) => {
    setBusy(true);
    setProblem(null);
    const url = await providerSignInUrl(provider, carryPlan(nextPath(search), search));
    if (url) return leaveTo(url);
    setProblem(copy.signInPage.providerFailed);
    setBusy(false);
  };

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setProblem(null);
    const outcome = await signInWithPassword(
      String(form.get("email")),
      String(form.get("password"))
    );
    if (outcome === "ok") await refresh();
    else setProblem(problems[outcome]);
    setBusy(false);
  };

  return (
    <>
      <h1>{copy.routes.signIn}</h1>
      {signedOutHere && (
        <p role="status" className={styles.status}>
          {copy.signInPage.signedOut}
        </p>
      )}
      {deleted && <p className={styles.notice}>{copy.signInPage.deleted}</p>}
      <p className={styles.intro}>{copy.signInPage.intro}</p>
      <div className={styles.column}>
        {problem && (
          <p role="alert" className={errorStyles.error}>
            {problem}
          </p>
        )}
        {providers.length > 0 && (
          <>
            <ul className={styles.providers}>
              {providers.map((provider) => (
                <li key={provider}>
                  <button type="button" disabled={busy} onClick={() => void withProvider(provider)}>
                    {copy.signInPage.provider[provider]}
                  </button>
                </li>
              ))}
            </ul>
            <p className={styles.hint}>{copy.signInPage.or}</p>
          </>
        )}
        <form onSubmit={(event) => void onSubmit(event)} className={styles.form}>
          <label htmlFor="sign-in-email">{copy.signInPage.emailLabel}</label>
          <input id="sign-in-email" name="email" type="email" required autoComplete="email" />
          <label htmlFor="sign-in-password">{copy.signInPage.passwordLabel}</label>
          <input
            id="sign-in-password"
            name="password"
            type="password"
            required
            autoComplete="current-password"
          />
          <button type="submit" data-variant="primary" disabled={busy}>
            {busy ? copy.signInPage.signingIn : copy.signInPage.action}
          </button>
        </form>
        <p className={styles.hint}>{copy.signInPage.help}</p>
        <p className={styles.hint}>
          <a href={copy.outbound.earlyAccess}>{copy.signInPage.notInvited}</a>
        </p>
      </div>
    </>
  );
}
