import { copy } from "../data/copy";
import { useSession } from "./SessionProvider";
import { ViewAsForm } from "./ViewAsForm";

type Props = {
  readonly name: string;
  readonly email: string;
  // Whether the person has the platform admin role.
  readonly admin: boolean;
};

// Viewing the app as one person, from their row, behind a disclosure that still asks for the
// reason. Nothing for an admin, the signed-in one included: an admin cannot be viewed as.
export function ViewAsDisclosure({ name, email, admin }: Props) {
  const { session } = useSession();
  if (admin || email === session.person?.email) return null;
  return (
    <details>
      <summary>{copy.people.viewAs(name)}</summary>
      <ViewAsForm email={email} />
    </details>
  );
}
