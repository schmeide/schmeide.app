import { copy } from "../data/copy";
import { pathTo } from "../utils/routes";
import { Link } from "./Link";
import { useSession } from "./SessionProvider";
import { StatusPage } from "./StatusPage";

// Both "not found" and "no access": an address that leads nowhere, or into a business the person
// is not in. One page for both, so it never tells a non-member that an app exists.
export function NotFoundPage() {
  const { session } = useSession();
  return (
    <StatusPage title={copy.problems.title}>
      <p>{copy.problems.body}</p>
      {session.person && <p>{copy.problems.signedInAs(session.person.email)}</p>}
      <p>
        <Link to={pathTo("apps")}>{copy.problems.action}</Link>
      </p>
      <p>
        <a href={copy.outbound.marketingSite}>{copy.problems.toMarketingSite}</a>
      </p>
    </StatusPage>
  );
}
