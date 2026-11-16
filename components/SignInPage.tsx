import { copy } from "../data/copy";
import { useSession } from "./SessionProvider";

// ponytail: a stand-in for the sign-in screens of #46. Signing in makes the route guard return the
// person to the page they asked for.
export function SignInPage() {
  const { signIn } = useSession();
  return (
    <>
      <h1>{copy.routes.signIn}</h1>
      <p>{copy.signInPage.intro}</p>
      <button type="button" data-variant="primary" onClick={signIn}>
        {copy.signInPage.action}
      </button>
    </>
  );
}
