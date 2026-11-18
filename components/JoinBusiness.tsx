import { useQueryClient } from "@tanstack/react-query";

import { copy } from "../data/copy";
import { currentLocation, navigate } from "../utils/navigation";
import { pathTo } from "../utils/routes";
import { ErrorNote } from "./ErrorNote";
import { Link } from "./Link";
import { useSession } from "./SessionProvider";

import styles from "./SignInPage.module.css";

type Props = {
  readonly email: string;
  readonly business: string;
  readonly pending: boolean;
  readonly error: { readonly message: string } | null;
  readonly onJoin: () => Promise<{ readonly businessId: number }>;
};

export function JoinBusiness({ email, business, pending, error, onJoin }: Props) {
  const queryClient = useQueryClient();
  const { session, refresh, chooseBusiness } = useSession();
  const current = session.person?.email;
  const copyOf = copy.setPasswordPage;

  const join = async () => {
    const { businessId } = await onJoin();
    await refresh();
    chooseBusiness(businessId);
    navigate(pathTo("apps"));
    await queryClient.invalidateQueries();
  };

  return (
    <>
      <h1>{copyOf.joinTitle(business)}</h1>
      <p className={styles.intro}>{copyOf.joinIntro(business, email)}</p>
      {!current && (
        <>
          <p>{copyOf.joinSignIn(email)}</p>
          <p>
            <Link to={`${pathTo("signIn")}?next=${encodeURIComponent(currentLocation())}`}>
              {copyOf.joinSignInAction}
            </Link>
          </p>
        </>
      )}
      {current && current !== email && <p>{copyOf.joinWrongPerson(email, current)}</p>}
      {current === email && (
        <button
          type="button"
          data-variant="primary"
          disabled={pending}
          onClick={() => void join().catch(() => undefined)}
        >
          {pending ? copyOf.joining : copyOf.join(business)}
        </button>
      )}
      <ErrorNote error={error} />
    </>
  );
}
