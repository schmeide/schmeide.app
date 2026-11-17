import { copy } from "../data/copy";
import { pathTo, planFrom } from "../utils/routes";
import { Link } from "./Link";

import styles from "./SignInPage.module.css";

// Where schmeide.com sends people to start. While Schmeide is invitation-only it explains that
// and leads to the early-access form; once sign-up opens it becomes the sign-up screen (#46).
// A known `?plan=` and `next` go on to sign-in with the person; the page says a plan is kept, never
// which one.
export function SignUpPage() {
  const search = window.location.search;
  const plan = planFrom(search);
  const next = new URLSearchParams(search).get("next");
  const onward = new URLSearchParams({ ...(next && { next }), ...(plan && { plan }) }).toString();
  const signIn = onward ? `${pathTo("signIn")}?${onward}` : pathTo("signIn");

  return (
    <>
      <h1>{copy.routes.signUp}</h1>
      <p className={styles.intro}>{copy.signUpPage.inviteOnly}</p>
      {plan && <p className={styles.hint}>{copy.signUpPage.planKept}</p>}
      <div className={styles.actions}>
        <a href={copy.outbound.earlyAccess} className={styles.primaryLink}>
          {copy.signUpPage.askForAccess}
        </a>
        <Link to={signIn}>{copy.signUpPage.signIn}</Link>
      </div>
    </>
  );
}
