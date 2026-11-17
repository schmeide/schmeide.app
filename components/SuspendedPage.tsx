import { copy } from "../data/copy";
import { pathTo } from "../utils/routes";
import { Link } from "./Link";

// What a member of a suspended business sees in place of its pages: not an error, and a way to
// get in touch. The shell around it still offers signing out and their other businesses.
export function SuspendedPage() {
  return (
    <>
      <h1>{copy.suspended.title}</h1>
      <p>{copy.suspended.body}</p>
      <p>
        <Link to={pathTo("help")}>{copy.suspended.contact}</Link>
      </p>
    </>
  );
}
