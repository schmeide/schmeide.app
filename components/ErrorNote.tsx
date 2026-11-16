import { copy } from "../data/copy";
import { classifyError } from "../utils/apiError";

import styles from "./ErrorNote.module.css";

type ApiError = { readonly message: string };

const describe = (error: ApiError): string => {
  switch (classifyError(error)) {
    case "unreachable":
      return copy.errors.serverDown;
    case "signedOut":
      return copy.errors.signedOut;
    case "notFound":
      return copy.errors.notFound;
    case "forbidden":
      return copy.errors.forbidden;
    case "conflict":
      return `${copy.errors.conflict} ${error.message}`;
    case "badRequest":
      return `${copy.errors.badRequest} ${error.message}`;
    case "unavailable":
      return copy.errors.unavailable;
    case "other":
      return `${copy.errors.other} ${error.message}`;
  }
};

// Says in plain words what a failed API call means and what to do about it.
export function ErrorNote({ error }: { readonly error: ApiError | null }) {
  if (!error) return null;
  return (
    <p role="alert" className={styles.error}>
      {describe(error)}
    </p>
  );
}
