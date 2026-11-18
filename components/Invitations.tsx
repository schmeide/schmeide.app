import { useMutation } from "@tanstack/react-query";
import { useRef, useState, type FormEvent } from "react";

import { copy } from "../data/copy";
import { useRefreshBusiness, useTRPC, type BusinessDetails } from "../trpc";
import { formatDate } from "../utils/formatDate";
import { pathTo } from "../utils/routes";
import { ActionError } from "./ActionError";

import errorStyles from "./ErrorNote.module.css";
import styles from "./BusinessPage.module.css";

const INVITE_DAYS = 7;
const LOOKS_LIKE_EMAIL = /^\S+@\S+\.\S+$/;

type Props = { readonly business: BusinessDetails };
type Made = { readonly email: string; readonly token: string };
type Shown = { readonly email: string; readonly url: string; readonly copied?: boolean };

const linkFor = ({ email, token }: Made): Shown => ({
  email,
  url: `${window.location.origin}${pathTo("setPassword")}?token=${encodeURIComponent(token)}`,
});

export function Invitations({ business }: Props) {
  const trpc = useTRPC();
  const refreshBusiness = useRefreshBusiness();
  const emailField = useRef<HTMLInputElement>(null);
  const [emailMissing, setEmailMissing] = useState(false);
  const [link, setLink] = useState<Shown | null>(null);
  const settle = { onError: () => void refreshBusiness() };
  const show = (made: Made) => {
    setLink(linkFor(made));
    return refreshBusiness();
  };
  const invite = useMutation(
    trpc.business.invite.mutationOptions({
      ...settle,
      onSuccess: (made) => {
        if (emailField.current) emailField.current.value = "";
        return show(made);
      },
    })
  );
  const renew = useMutation(
    trpc.business.reissueInvitation.mutationOptions({ ...settle, onSuccess: show })
  );
  const withdraw = useMutation(
    trpc.business.withdrawInvitation.mutationOptions({
      ...settle,
      onSuccess: (_, { email }) => {
        setLink((shown) => (shown?.email === email ? null : shown));
        return refreshBusiness();
      },
    })
  );
  const actions = [invite, renew, withdraw];
  const busy = actions.some((action) => action.isPending);
  const failed = actions.find((action) => action.error)?.error ?? null;
  const copyOf = copy.businessPage.invitations;

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    actions.forEach((action) => action.reset());
    const email = String(new FormData(event.currentTarget).get("email")).trim();
    const missing = !LOOKS_LIKE_EMAIL.test(email);
    setEmailMissing(missing);
    if (missing) return emailField.current?.focus();
    invite.mutate({ email });
  };
  const act = (action: typeof renew | typeof withdraw, email: string) => () => {
    actions.forEach((each) => each.reset());
    action.mutate({ email });
  };
  const copyLink = async (shown: Shown) => {
    const copied = await Promise.resolve()
      .then(() => navigator.clipboard.writeText(shown.url))
      .then(
        () => true,
        () => false
      );
    setLink({ ...shown, copied });
  };

  return (
    <section aria-labelledby="business-invitations" className={styles.card}>
      <h2 id="business-invitations">{copyOf.title}</h2>
      <p className={styles.note}>{copyOf.intro}</p>
      <form onSubmit={onSubmit} noValidate className={styles.form}>
        <label htmlFor="invite-email">{copyOf.emailLabel}</label>
        <input
          id="invite-email"
          name="email"
          type="email"
          ref={emailField}
          maxLength={254}
          autoComplete="off"
          aria-invalid={emailMissing || undefined}
          aria-describedby={emailMissing ? "invite-email-error" : undefined}
        />
        {emailMissing && (
          <p id="invite-email-error" className={errorStyles.error}>
            {copyOf.emailMissing}
          </p>
        )}
        <div className={styles.actions}>
          <button type="submit" data-variant="primary" disabled={busy}>
            {invite.isPending ? copyOf.adding : copyOf.add}
          </button>
        </div>
      </form>
      <ActionError error={failed} />

      {link && (
        <div className={styles.ask}>
          <label htmlFor="invite-link">{copyOf.linkLabel(link.email)}</label>
          <input
            id="invite-link"
            readOnly
            value={link.url}
            aria-describedby="invite-link-help"
            onFocus={(event) => event.currentTarget.select()}
          />
          <p id="invite-link-help">{copyOf.linkHelp(INVITE_DAYS)}</p>
          <div className={styles.actions}>
            <button type="button" data-variant="primary" onClick={() => void copyLink(link)}>
              {copyOf.copyLink}
            </button>
            <span role="status">
              {link.copied === true ? copyOf.copied : ""}
              {link.copied === false ? copyOf.copyFailed : ""}
            </span>
          </div>
        </div>
      )}

      <h3>{copyOf.waitingTitle(business.invitations.length)}</h3>
      {business.invitations.length === 0 ? (
        <p className={styles.note}>{copyOf.none}</p>
      ) : (
        <>
          <ul className={styles.rows}>
            {business.invitations.map((invitation) => (
              <li key={invitation.email} className={styles.row}>
                <div className={styles.who}>
                  <span className={styles.name}>{invitation.email}</span>
                  <span className={styles.detail}>
                    {copyOf.invited(formatDate(invitation.invitedAt))}
                  </span>
                  {invitation.expired && <span className={styles.detail}>{copyOf.expired}</span>}
                </div>
                <div className={styles.actions}>
                  <button type="button" onClick={act(renew, invitation.email)} disabled={busy}>
                    {copyOf.renew(invitation.email)}
                  </button>
                  <button
                    type="button"
                    data-variant="danger"
                    onClick={act(withdraw, invitation.email)}
                    disabled={busy}
                  >
                    {copyOf.withdraw(invitation.email)}
                  </button>
                </div>
              </li>
            ))}
          </ul>
          <p className={styles.note}>{copyOf.renewHelp}</p>
        </>
      )}
    </section>
  );
}
