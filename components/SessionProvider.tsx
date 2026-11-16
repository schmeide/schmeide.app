import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

import { devSession } from "../data/devSession";
import { signedOut, type Business, type Session } from "../utils/session";

type SessionContext = {
  readonly session: Session;
  // The business the person is working in; null when signed out or before the first one exists.
  readonly business: Business | null;
  readonly chooseBusiness: (id: number) => void;
  readonly signIn: () => void;
  readonly signOut: () => void;
};

const Context = createContext<SessionContext | null>(null);

export const useSession = (): SessionContext => {
  const context = useContext(Context);
  if (!context) throw new Error("useSession needs a <SessionProvider>");
  return context;
};

// Holds who is signed in and which business they are working in.
// ponytail: the session lives in memory and starts as the dev stand-in, so signing out lasts until
// a reload. With auth (#5) it comes from the server, and signIn/signOut call it.
export function SessionProvider({
  initial = devSession,
  children,
}: {
  readonly initial?: Session;
  readonly children: ReactNode;
}) {
  const [session, setSession] = useState(initial);
  const [businessId, setBusinessId] = useState<number | null>(null);
  const value = useMemo(
    () => ({
      session,
      business:
        session.businesses.find((business) => business.id === businessId) ??
        session.businesses[0] ??
        null,
      chooseBusiness: setBusinessId,
      signIn: () => setSession(devSession),
      signOut: () => setSession(signedOut),
    }),
    [session, businessId]
  );
  return <Context value={value}>{children}</Context>;
}
