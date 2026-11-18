import { copy } from "../data/copy";
import { StatusPage } from "./StatusPage";

const format = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

// Planned work, with when to come back.
export function MaintenancePage({ until }: { readonly until: Date }) {
  return (
    <StatusPage title={copy.maintenance.title}>
      <p>{copy.maintenance.body(format.format(until))}</p>
    </StatusPage>
  );
}
