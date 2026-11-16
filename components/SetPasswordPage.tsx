import { useMutation, useQuery } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";

import { copy } from "../data/copy";
import { useTRPC } from "../trpc";
import { classifyError } from "../utils/apiError";
import { signInWithPassword } from "../utils/authApi";
import { navigate } from "../utils/navigation";
import { pathTo } from "../utils/routes";
import { ErrorNote } from "./ErrorNote";
import { Link } from "./Link";
import { useSession } from "./SessionProvider";

import errorStyles from "./ErrorNote.module.css";
import styles from "./SignInPage.module.css";

// The server refuses anything shorter (MIN_PASSWORD_LENGTH in server/src/db/schema.ts).
const MIN_PASSWORD_LENGTH = 10;

// Where a one-time invite link lands: an approved person sets their name and password, or an
// existing one sets a new password, and is then signed in.
export function SetPasswordPage() {
  const trpc = useTRPC();
  const { refresh } = useSession();
  const token = new URLSearchParams(window.location.search).get("token") ?? "";
  const invite = useQuery({ ...trpc.invites.get.queryOptions({ token }), enabled: token !== "" });
  const accept = useMutation(trpc.invites.accept.mutationOptions());
  const [mismatch, setMismatch] = useState(false);
  const [signedOutAfter, setSignedOutAfter] = useState(false);

  const dead = token === "" || (invite.error && classifyError(invite.error) === "notFound");
  const usedUp = accept.error && classifyError(accept.error) === "notFound";
  if (dead || usedUp) {
    return (
      <>
        <h1>{copy.setPasswordPage.deadTitle}</h1>
        <p>{copy.setPasswordPage.dead}</p>
        <p>
          <Link to={pathTo("signIn")}>{copy.setPasswordPage.toSignIn}</Link>
        </p>
      </>
    );
  }

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const password = String(form.get("password"));
    const differs = password !== String(form.get("confirm"));
    setMismatch(differs);
    if (differs) return;
    const name = form.get("name");
    const { email } = await accept.mutateAsync({
      token,
      password,
      ...(typeof name === "string" && { name }),
    });
    if ((await signInWithPassword(email, password)) !== "ok") return setSignedOutAfter(true);
    await refresh();
    navigate(pathTo("apps"));
  };

  return (
    <>
      <h1>{copy.routes.setPassword}</h1>
      {invite.isPending && <p>{copy.loading}</p>}
      <ErrorNote error={invite.error} />
      {signedOutAfter && (
        <p>
          {copy.setPasswordPage.savedButSignedOut}{" "}
          <Link to={pathTo("signIn")}>{copy.setPasswordPage.toSignIn}</Link>
        </p>
      )}
      {invite.data && !signedOutAfter && (
        <>
          <p className={styles.intro}>
            {invite.data.hasAccount
              ? copy.setPasswordPage.resetIntro(invite.data.email)
              : copy.setPasswordPage.intro(invite.data.email)}
          </p>
          <div className={styles.column}>
            <form
              onSubmit={(event) => void onSubmit(event).catch(() => undefined)}
              className={styles.form}
            >
              {/* Lets a password manager file the new password under the right address. */}
              <input type="hidden" name="email" autoComplete="username" value={invite.data.email} />
              {!invite.data.hasAccount && (
                <>
                  <label htmlFor="set-name">{copy.setPasswordPage.nameLabel}</label>
                  <input id="set-name" name="name" required maxLength={100} autoComplete="name" />
                </>
              )}
              <label htmlFor="set-password">{copy.setPasswordPage.passwordLabel}</label>
              <input
                id="set-password"
                name="password"
                type="password"
                required
                minLength={MIN_PASSWORD_LENGTH}
                maxLength={128}
                autoComplete="new-password"
                aria-describedby="set-password-hint"
              />
              <p id="set-password-hint" className={styles.hint}>
                {copy.setPasswordPage.passwordHint(MIN_PASSWORD_LENGTH)}
              </p>
              <label htmlFor="set-confirm">{copy.setPasswordPage.confirmLabel}</label>
              <input
                id="set-confirm"
                name="confirm"
                type="password"
                required
                autoComplete="new-password"
                aria-invalid={mismatch || undefined}
                aria-describedby={mismatch ? "set-confirm-error" : undefined}
              />
              {mismatch && (
                <p id="set-confirm-error" role="alert" className={errorStyles.error}>
                  {copy.setPasswordPage.mismatch}
                </p>
              )}
              <button type="submit" data-variant="primary" disabled={accept.isPending}>
                {accept.isPending ? copy.setPasswordPage.saving : copy.setPasswordPage.action}
              </button>
            </form>
            <ErrorNote error={accept.error} />
          </div>
        </>
      )}
    </>
  );
}
