import { useId, type FormEvent } from "react";

import { copy } from "../data/copy";

import styles from "./AdminSearch.module.css";

type Props = {
  // What can be searched for.
  readonly hint: string;
  readonly onSearch: (text: string) => void;
};

// The search box of an admin list. It searches when submitted, not on every key.
export function AdminSearch({ hint, onSearch }: Props) {
  const id = useId();
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSearch(String(new FormData(event.currentTarget).get("search")).trim());
  };
  return (
    <form role="search" onSubmit={onSubmit} className={styles.search}>
      <label htmlFor={`${id}-search`}>{copy.adminSearch.label}</label>
      <div className={styles.row}>
        <input
          id={`${id}-search`}
          name="search"
          type="search"
          maxLength={254}
          autoComplete="off"
          aria-describedby={`${id}-hint`}
        />
        <button type="submit">{copy.adminSearch.action}</button>
      </div>
      <p id={`${id}-hint`} className={styles.hint}>
        {hint}
      </p>
    </form>
  );
}
