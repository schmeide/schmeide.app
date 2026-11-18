import { useMutation } from "@tanstack/react-query";
import { useRef, useState, type FormEvent } from "react";

import { copy } from "../data/copy";
import { countries } from "../data/countries";
import { useTRPC } from "../trpc";
import { navigate } from "../utils/navigation";
import { carryPlan, nextPath, pathTo } from "../utils/routes";
import { ErrorNote } from "./ErrorNote";
import { useSession } from "./SessionProvider";

import errorStyles from "./ErrorNote.module.css";
import styles from "./FirstRun.module.css";

// Where a signed-in person with no business sets one up, then goes on to where they were headed:
// the page in `?next=`, or starting their first app.
export function FirstRun() {
  const trpc = useTRPC();
  const { session, refresh } = useSession();
  const yourNameField = useRef<HTMLInputElement>(null);
  const countryField = useRef<HTMLSelectElement>(null);
  const [yourName, setYourName] = useState(session.person?.name ?? "");
  const [missing, setMissing] = useState({ yourName: false, country: false });
  const create = useMutation(trpc.setup.createBusiness.mutationOptions());
  const text = copy.firstRun;

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = String(form.get("name")).trim();
    const country = String(form.get("country"));
    const description = String(form.get("description")).trim();
    const now = { yourName: yourName.trim() === "", country: country === "" };
    setMissing(now);
    if (now.yourName) return yourNameField.current?.focus();
    if (now.country) return countryField.current?.focus();
    await create.mutateAsync({
      yourName: yourName.trim(),
      country,
      ...(name && { name }),
      ...(description && { description }),
    });
    await refresh();
    const search = window.location.search;
    const next = new URLSearchParams(search).has("next") ? nextPath(search) : pathTo("start");
    navigate(carryPlan(next, search));
  };

  return (
    <>
      <h1>{copy.routes.welcome}</h1>
      <p className={styles.intro}>{text.intro}</p>
      <form
        onSubmit={(event) => void onSubmit(event).catch(() => undefined)}
        noValidate
        className={styles.form}
      >
        <label htmlFor="first-run-your-name">{text.yourNameLabel}</label>
        <input
          id="first-run-your-name"
          ref={yourNameField}
          value={yourName}
          onChange={(event) => setYourName(event.target.value)}
          required
          maxLength={100}
          autoComplete="name"
          aria-invalid={missing.yourName || undefined}
          aria-describedby={missing.yourName ? "first-run-your-name-error" : undefined}
        />
        {missing.yourName && (
          <p id="first-run-your-name-error" className={errorStyles.error}>
            {text.yourNameMissing}
          </p>
        )}

        <label htmlFor="first-run-name">{text.nameLabel}</label>
        <input
          id="first-run-name"
          name="name"
          maxLength={120}
          autoComplete="organization"
          placeholder={yourName.trim() ? text.defaultName(yourName.trim()) : undefined}
          aria-describedby="first-run-name-hint"
        />
        <p id="first-run-name-hint" className={styles.hint}>
          {text.nameHint}
        </p>

        <label htmlFor="first-run-country">{text.countryLabel}</label>
        <select
          id="first-run-country"
          name="country"
          ref={countryField}
          defaultValue=""
          required
          autoComplete="country"
          className={styles.select}
          aria-invalid={missing.country || undefined}
          aria-describedby={
            missing.country
              ? "first-run-country-hint first-run-country-error"
              : "first-run-country-hint"
          }
        >
          <option value="">{text.countryNone}</option>
          {countries.map(({ code, name }) => (
            <option key={code} value={code}>
              {name}
            </option>
          ))}
        </select>
        <p id="first-run-country-hint" className={styles.hint}>
          {text.countryHint}
        </p>
        {missing.country && (
          <p id="first-run-country-error" className={errorStyles.error}>
            {text.countryMissing}
          </p>
        )}

        <label htmlFor="first-run-description">{text.descriptionLabel}</label>
        <input
          id="first-run-description"
          name="description"
          maxLength={200}
          aria-describedby="first-run-description-hint"
        />
        <p id="first-run-description-hint" className={styles.hint}>
          {text.descriptionHint}
        </p>

        <button type="submit" data-variant="primary" disabled={create.isPending}>
          {create.isPending ? text.saving : text.save}
        </button>
      </form>
      <ErrorNote error={create.error} />
    </>
  );
}
