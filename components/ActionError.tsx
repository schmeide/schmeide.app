import { copy } from "../data/copy";
import { classifyError } from "../utils/apiError";
import { ErrorNote } from "./ErrorNote";

import styles from "./ErrorNote.module.css";

type Props = { readonly error: { readonly message: string } | null };

export function ActionError({ error }: Props) {
  if (error && classifyError(error) === "notFound")
    return (
      <p role="alert" className={styles.error}>
        {copy.businessPage.gone}
      </p>
    );
  return <ErrorNote error={error} />;
}
