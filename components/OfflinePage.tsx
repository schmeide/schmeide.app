import { useEffect } from "react";

import { copy } from "../data/copy";
import { StatusPage } from "./StatusPage";

// Matches copy.offline.retrying.
const RETRY_MS = 10_000;

// No connection, or the server does not answer: try again now, and by itself every few seconds.
export function OfflinePage({
  title = copy.offline.title,
  body = copy.offline.body,
  onRetry,
}: {
  readonly title?: string;
  readonly body?: string;
  readonly onRetry: () => unknown;
}) {
  useEffect(() => {
    const timer = setInterval(onRetry, RETRY_MS);
    return () => clearInterval(timer);
  }, [onRetry]);
  return (
    <StatusPage title={title}>
      <p>{body}</p>
      <p>{copy.offline.retrying}</p>
      <button type="button" onClick={() => void onRetry()}>
        {copy.errors.retry}
      </button>
    </StatusPage>
  );
}
