import { copy } from "../data/copy";
import { pathTo } from "../utils/routes";
import { Link } from "./Link";
import { useSession } from "./SessionProvider";

// What a person sees when an address leads nowhere or to another business: one sentence and one
// way forward. The fuller pages are #45.
export function RouteProblem({ kind }: { readonly kind: "notFound" | "noAccess" }) {
  const { session } = useSession();
  return (
    <>
      <h1>{copy.problems[kind].title}</h1>
      <p>{copy.problems[kind].body}</p>
      {kind === "noAccess" && session.person && (
        <p>{copy.problems.signedInAs(session.person.email)}</p>
      )}
      <p>
        <Link to={pathTo("apps")}>{copy.problems.action}</Link>
      </p>
    </>
  );
}
