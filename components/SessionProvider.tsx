import { matchQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

import { useTRPC } from "../trpc";
import { classifyError } from "../utils/apiError";
import { signOut as endSession } from "../utils/authApi";
import { chooseBusiness as tellServer } from "../utils/chosenBusiness";
import { signedOut, type Business, type Provider, type Session } from "../utils/session";

type SessionContext = {
  // "loading" until the server has said who this is; "unreachable" when it did not answer.
  readonly status: "loading" | "unreachable" | "ready";
  readonly session: Session;
  // The business the person is working in; null when signed out or before the first one exists.
  readonly business: Business | null;
  readonly chooseBusiness: (id: number) => void;
  // The sign-in providers the server offers.
  readonly providers: readonly Provider[];
  // Asks the server again who this is: after signing in, or when a call answers "signed out".
  readonly refresh: () => Promise<void>;
  readonly signOut: () => Promise<void>;
};

const Context = createContext<SessionContext | null>(null);

export const useSession = (): SessionContext => {
  const context = useContext(Context);
  if (!context) throw new Error("useSession needs a <SessionProvider>");
  return context;
};

// Holds who is signed in and which business they are working in, as the server reports it.
// `fixed` skips the server and is that session throughout: for tests of the pages inside.
export function SessionProvider({
  fixed,
  children,
}: {
  readonly fixed?: Session;
  readonly children: ReactNode;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const query = useQuery({ ...trpc.session.get.queryOptions(), enabled: !fixed });
  const [businessId, setBusinessId] = useState<number | null>(null);

  const value = useMemo((): SessionContext => {
    const loaded: Session | undefined =
      fixed ?? (query.data && { person: query.data.person, businesses: query.data.businesses });
    const session = loaded ?? signedOut;
    const sessionKey = trpc.session.pathKey();
    const refresh = () => queryClient.invalidateQueries({ queryKey: sessionKey });
    return {
      status: loaded
        ? "ready"
        : query.error && classifyError(query.error) === "unreachable"
          ? "unreachable"
          : "loading",
      session,
      business:
        session.businesses.find((business) => business.id === businessId) ??
        session.businesses[0] ??
        null,
      // What is on screen belongs to the business being left, so it is all loaded again.
      chooseBusiness: (id: number) => {
        tellServer(id);
        setBusinessId(id);
        void queryClient.invalidateQueries({
          predicate: (query) => !matchQuery({ queryKey: sessionKey }, query),
        });
      },
      providers: query.data?.providers ?? [],
      refresh,
      signOut: async () => {
        await endSession();
        tellServer(null);
        setBusinessId(null);
        await refresh();
        // Nothing the last person loaded stays in memory for the next one to sign in here.
        queryClient.removeQueries({
          predicate: (query) => !matchQuery({ queryKey: sessionKey }, query),
        });
      },
    };
  }, [fixed, query.data, query.error, businessId, queryClient, trpc]);
  return <Context value={value}>{children}</Context>;
}
