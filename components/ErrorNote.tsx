import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { copy } from "../data/copy";
import { classifyError } from "../utils/apiError";
import { hasHostedApi } from "../utils/apiUrl";

import styles from "./ErrorNote.module.css";

// Customers on the hosted site never see how to start the server; a developer does.
export const serverDownText = hasHostedApi ? copy.errors.serverDown : copy.errors.serverDownLocal;

type ApiError = { readonly message: string };

// The server's messages are sentences, some without the full stop.
const sentence = (message: string) => (/[.!?]$/.test(message) ? message : `${message}.`);

const describe = (error: ApiError): string => {
  switch (classifyError(error)) {
    case "unreachable":
      return serverDownText;
    case "signedOut":
      return copy.errors.signedOut;
    case "notFound":
      return copy.errors.notFound;
    case "forbidden":
      return copy.errors.forbidden;
    case "conflict":
      return `${sentence(error.message)} ${copy.errors.refreshed}`;
    case "badRequest":
      return `${copy.errors.badRequest} ${sentence(error.message)} ${copy.errors.badRequestNext}`;
    case "unavailable":
      return copy.errors.unavailable;
    case "suspended":
      return copy.errors.suspended;
    case "other":
      return copy.errors.other;
  }
};

// Says in plain words what a failed API call means and what to do about it. A conflict means the
// page is out of date, so everything on it is fetched again.
export function ErrorNote({ error }: { readonly error: ApiError | null }) {
  const queryClient = useQueryClient();
  const conflict = Boolean(error) && classifyError(error) === "conflict";
  useEffect(() => {
    if (conflict) void queryClient.invalidateQueries();
  }, [conflict, error, queryClient]);
  if (!error) return null;
  return (
    <p role="alert" className={styles.error}>
      {describe(error)}
    </p>
  );
}
