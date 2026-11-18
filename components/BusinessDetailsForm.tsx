import { useMutation } from "@tanstack/react-query";
import { useRef, useState, type FormEvent } from "react";

import { copy } from "../data/copy";
import { countries, countryName } from "../data/countries";
import { useRefreshBusiness, useTRPC, type BusinessDetails } from "../trpc";
import { ActionError } from "./ActionError";
import { useSession } from "./SessionProvider";

import errorStyles from "./ErrorNote.module.css";
import styles from "./BusinessPage.module.css";

type Props = { readonly business: BusinessDetails };

export function BusinessDetailsForm({ business }: Props) {
  const trpc = useTRPC();
  const { refresh: refreshSession } = useSession();
  const refreshBusiness = useRefreshBusiness();
  const nameField = useRef<HTMLInputElement>(null);
  const [nameMissing, setNameMissing] = useState(false);
  const update = useMutation(
    trpc.business.update.mutationOptions({
      onSuccess: () => Promise.all([refreshBusiness(), refreshSession()]),
      onError: () => void refreshBusiness(),
    })
  );
  const copyOf = copy.businessPage.details;

  if (business.role !== "owner")
    return (
      <section aria-labelledby="business-details" className={styles.card}>
        <h2 id="business-details">{copyOf.title}</h2>
        <dl className={styles.facts}>
          <dt>{copyOf.nameLabel}</dt>
          <dd>{business.name}</dd>
          <dt>{copyOf.countryLabel}</dt>
          <dd>{(business.country && countryName(business.country)) ?? copyOf.countryNone}</dd>
        </dl>
      </section>
    );

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = String(form.get("name")).trim();
    const country = String(form.get("country"));
    setNameMissing(name === "");
    if (name === "") return nameField.current?.focus();
    update.mutate({ name, country: country === "" ? null : country });
  };

  return (
    <section aria-labelledby="business-details" className={styles.card}>
      <h2 id="business-details">{copyOf.title}</h2>
      <form onSubmit={onSubmit} noValidate className={styles.form}>
        <label htmlFor="business-name">{copyOf.nameLabel}</label>
        <input
          id="business-name"
          name="name"
          ref={nameField}
          defaultValue={business.name}
          maxLength={120}
          autoComplete="organization"
          aria-invalid={nameMissing || undefined}
          aria-describedby={nameMissing ? "business-name-error" : undefined}
        />
        {nameMissing && (
          <p id="business-name-error" className={errorStyles.error}>
            {copyOf.nameMissing}
          </p>
        )}
        <label htmlFor="business-country">{copyOf.countryLabel}</label>
        <select
          id="business-country"
          name="country"
          defaultValue={business.country ?? ""}
          autoComplete="country"
          className={styles.select}
        >
          <option value="">{copyOf.countryNone}</option>
          {countries.map(({ code, name }) => (
            <option key={code} value={code}>
              {name}
            </option>
          ))}
        </select>
        <div className={styles.actions}>
          <button type="submit" data-variant="primary" disabled={update.isPending}>
            {update.isPending ? copyOf.saving : copyOf.save}
          </button>
          <span role="status">{update.isSuccess && !nameMissing ? copyOf.saved : ""}</span>
        </div>
      </form>
      <ActionError error={update.error} />
    </section>
  );
}
