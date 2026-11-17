import { matchQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

import { useTRPC, useTRPCClient } from "../trpc";
import { classifyError } from "../utils/apiError";
import { signOut as endSession } from "../utils/authApi";
import { chooseBusiness as tellServer } from "../utils/chosenBusiness";
import { navigate } from "../utils/navigation";
import { pathTo } from "../utils/routes";
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
  // An admin starts viewing the app as the person with `email`, and lands on their home. Throws
  // what the server answered when it refuses.
  readonly startViewingAs: (email: string, reason: string) => Promise<void>;
  // Ends the view and returns the admin to the admin area as themselves.
  readonly stopViewing: () => Promise<void>;
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
  const client = useTRPCClient();
  const queryClient = useQueryClient();
  const query = useQuery({ ...trpc.session.get.queryOptions(), enabled: !fixed });
  const [businessId, setBusinessId] = useState<number | null>(null);

  const value = useMemo((): SessionContext => {
    const loaded: Session | undefined =
      fixed ??
      (query.data && {
        person: query.data.person,
        businesses: query.data.businesses,
        impersonatedBy: query.data.impersonatedBy,
        buildsOff: query.data.buildsOff,
        canBuild: query.data.canBuild,
      });
    const session = loaded ?? signedOut;
    const sessionKey = trpc.session.pathKey();
    const refresh = () => queryClient.invalidateQueries({ queryKey: sessionKey });
    // After the session changes hands. Nothing the last person loaded stays in memory for the
    // next one: it is not theirs to see.
    const changedHands = async () => {
      tellServer(null);
      setBusinessId(null);
      await refresh();
      queryClient.removeQueries({
        predicate: (query) => !matchQuery({ queryKey: sessionKey }, query),
      });
    };
    const stopViewing = async () => {
      await client.impersonation.stop.mutate();
      await changedHands();
      navigate(pathTo("admin"));
    };
    return {
      status: loaded
        ? "ready"
        : query.error && classifyError(query.error) === "unreachable"
          ? "unreachable"
          : "loading",
      session,
      // As the server picks when none is chosen: the first that is not suspended.
      business:
        session.businesses.find((business) => business.id === businessId) ??
        session.businesses.find((business) => !business.suspended) ??
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
        // The server refuses signing out of a view; ending it first is what Stop does.
        if (session.impersonatedBy) await client.impersonation.stop.mutate();
        await endSession();
        await changedHands();
      },
      startViewingAs: async (email, reason) => {
        await client.admin.impersonation.start.mutate({ email, reason });
        await changedHands();
        navigate(pathTo("apps"));
      },
      stopViewing,
    };
  }, [fixed, query.data, query.error, businessId, queryClient, trpc, client]);
  return <Context value={value}>{children}</Context>;
}
