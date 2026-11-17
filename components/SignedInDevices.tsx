import { useMutation, useQueryClient } from "@tanstack/react-query";

import { copy } from "../data/copy";
import { useTRPC, type Account } from "../trpc";
import { describeDevice } from "../utils/device";
import { ErrorNote } from "./ErrorNote";

import styles from "./Account.module.css";
import stepStyles from "./Step.module.css";

const text = copy.accountPage.devices;

const day = (date: Date) =>
  new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);

const nameOf = (userAgent: string | null) => {
  const { browser, os } = describeDevice(userAgent);
  if (browser && os) return text.named(browser, os);
  return browser ?? os ?? text.unknown;
};

// Every browser the person is signed in on, this one first, and "Sign out everywhere else".
export function SignedInDevices({ account }: { readonly account: Account }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const signOut = useMutation(
    trpc.account.signOutOthers.mutationOptions({
      onSettled: () => queryClient.invalidateQueries({ queryKey: trpc.account.pathKey() }),
    })
  );
  const devices = [...account.devices].sort((a, b) => Number(b.current) - Number(a.current));

  return (
    <section aria-labelledby="devices" className={stepStyles.step}>
      <h2 id="devices">{text.title}</h2>
      <ul className={styles.rows}>
        {devices.map((device) => (
          <li key={device.id} className={styles.row}>
            <div className={styles.what}>
              <span className={styles.name}>
                {nameOf(device.userAgent)}
                {device.current && <span className={styles.badge}>{text.thisDevice}</span>}
              </span>
              <span className={stepStyles.muted}>{text.lastActive(day(device.lastActive))}</span>
            </div>
          </li>
        ))}
      </ul>
      <div className={stepStyles.actions}>
        {devices.length > 1 && (
          <button type="button" disabled={signOut.isPending} onClick={() => signOut.mutate()}>
            {signOut.isPending ? text.signingOut : text.signOutOthers}
          </button>
        )}
        <p role="status" className={styles.status}>
          {signOut.isSuccess ? text.signedOutOthers : ""}
        </p>
      </div>
      <ErrorNote error={signOut.error} />
    </section>
  );
}
