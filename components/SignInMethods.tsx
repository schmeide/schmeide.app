import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";

import { copy } from "../data/copy";
import { useTRPC, type Account } from "../trpc";
import { connectProviderUrl } from "../utils/authApi";
import { leaveTo } from "../utils/navigation";
import { pathTo } from "../utils/routes";
import type { Provider } from "../utils/session";
import { ErrorNote } from "./ErrorNote";
import { useSession } from "./SessionProvider";

import errorStyles from "./ErrorNote.module.css";
import styles from "./Account.module.css";
import stepStyles from "./Step.module.css";

type Kind = Account["methods"][number]["kind"];
const KINDS: readonly Kind[] = ["password", "google", "microsoft", "apple"];
const text = copy.accountPage.methods;

const day = (date: Date) =>
  new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);

// Each way the person can sign in: connected or not, with "Connect" for a provider the server
// offers and "Disconnect" while another way in remains.
export function SignInMethods({ account }: { readonly account: Account }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { providers } = useSession();
  // A provider that refused the connection sends the person back here with the reason.
  const [problem, setProblem] = useState(new URLSearchParams(window.location.search).has("error"));
  const [opening, setOpening] = useState<Provider | null>(null);
  const [disconnected, setDisconnected] = useState<string | null>(null);
  // The button goes with the method, so focus moves to the section's heading instead.
  const heading = useRef<HTMLHeadingElement>(null);
  const disconnect = useMutation(
    trpc.account.disconnect.mutationOptions({
      onSettled: () => queryClient.invalidateQueries({ queryKey: trpc.account.pathKey() }),
    })
  );

  const connect = async (provider: Provider) => {
    setOpening(provider);
    setProblem(false);
    const url = await connectProviderUrl(provider, pathTo("account"));
    if (url) return leaveTo(url);
    setProblem(true);
    setOpening(null);
  };

  const shown = KINDS.filter(
    (kind) =>
      kind === "password" ||
      providers.includes(kind) ||
      account.methods.some((method) => method.kind === kind)
  );
  const onlyOne = account.methods.length === 1;
  const busy = disconnect.isPending || opening !== null;

  return (
    <section aria-labelledby="methods" className={stepStyles.step}>
      <h2 id="methods" ref={heading} tabIndex={-1}>
        {text.title}
      </h2>
      {problem && (
        <p role="alert" className={errorStyles.error}>
          {text.connectFailed}
        </p>
      )}
      <ul className={styles.rows}>
        {shown.map((kind) => {
          const method = account.methods.find((each) => each.kind === kind);
          const name = text.kind[kind];
          return (
            <li key={kind} className={styles.row}>
              <div className={styles.what}>
                <span className={styles.name}>{name}</span>
                <span className={stepStyles.muted}>
                  {method
                    ? text.connectedOn(day(method.since))
                    : kind === "password"
                      ? text.noPassword
                      : text.notConnected}
                </span>
              </div>
              {method && !onlyOne && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setDisconnected(name);
                    disconnect.mutate(
                      { id: method.id },
                      { onSuccess: () => heading.current?.focus() }
                    );
                  }}
                >
                  {text.disconnect(name)}
                </button>
              )}
              {!method && kind !== "password" && providers.includes(kind) && (
                <button type="button" disabled={busy} onClick={() => void connect(kind)}>
                  {opening === kind ? text.opening(name) : text.connect(name)}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {onlyOne && <p className={stepStyles.muted}>{text.onlyOne}</p>}
      <p role="status" className={styles.status}>
        {disconnect.isPending
          ? text.disconnecting
          : disconnect.isSuccess && disconnected
            ? text.disconnected(disconnected)
            : ""}
      </p>
      <ErrorNote error={disconnect.error} />
    </section>
  );
}
