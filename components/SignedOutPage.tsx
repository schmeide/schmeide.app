import { copy } from "../data/copy";
import { Link } from "./Link";
import { StatusPage } from "./StatusPage";

// The session ended while a page was open. `signIn` is the sign-in address that returns here;
// what was typed and not sent is kept by useDraft.
export function SignedOutPage({ signIn }: { readonly signIn: string }) {
  return (
    <StatusPage title={copy.signedOutPage.title}>
      <p>{copy.signedOutPage.body}</p>
      <p>
        <Link to={signIn}>{copy.signedOutPage.action}</Link>
      </p>
    </StatusPage>
  );
}
