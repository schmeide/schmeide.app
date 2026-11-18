import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import { copy } from "../data/copy";
import { currentLocation, navigate, subscribe } from "../utils/navigation";
import { entryRoutes, guard, matchRoute, pathTo } from "../utils/routes";
import { EntryFrame } from "./EntryFrame";
import { RoutePage } from "./RoutePage";
import { NotFoundPage } from "./NotFoundPage";
import { OfflinePage } from "./OfflinePage";
import { useSession } from "./SessionProvider";
import { Shell } from "./Shell";
import { SignedOutPage } from "./SignedOutPage";
import { SuspendedPage } from "./SuspendedPage";

// Whether the browser says it has a connection.
const onConnectionChange = (onChange: () => void): (() => void) => {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
};
const isOnline = () => navigator.onLine;

// Shows the page the address names inside the shell, after the route guard has had its say.
export function Routes({ banner }: { readonly banner?: ReactNode }) {
  const { session, business, signedOutHere, refresh } = useSession();
  const online = useSyncExternalStore(onConnectionChange, isOnline);
  const location = useSyncExternalStore(subscribe, currentLocation);
  const [pathname, query = ""] = location.split("?");
  const search = query && `?${query}`;
  const match = matchRoute(pathname);
  const redirect =
    match &&
    (() => {
      const outcome = guard(match.route, session, { pathname, search });
      return outcome.kind === "redirect" ? outcome.to : null;
    })();

  // A session that ended while a page was open (not by signing out here) gets the signed-out
  // page in place, rather than a jump to sign-in: the address stays, and signing in returns to it.
  const [wasSignedIn, setWasSignedIn] = useState(Boolean(session.person));
  if (session.person && !wasSignedIn) setWasSignedIn(true);
  const ended =
    wasSignedIn && !session.person && !signedOutHere && redirect?.startsWith(pathTo("signIn"))
      ? redirect
      : null;

  useEffect(() => {
    if (redirect && !ended) navigate(redirect, { replace: true });
  }, [redirect, ended]);

  // A layout effect, so a page that names itself (a project) can set its own title in an effect
  // afterwards.
  const title = !online
    ? copy.offline.title
    : ended
      ? copy.signedOutPage.title
      : match
        ? match.route.title
        : copy.problems.title;
  useLayoutEffect(() => {
    document.title = copy.pageTitle(title);
  }, [title]);

  // After a view change, move focus to the new page's heading so it is announced and Tab starts
  // there; also when a status page (offline, signed out) takes the place of the page, or gives it
  // back. Not on the first load, where the browser's own start of page is right.
  const view = `${pathname} ${title}`;
  const shown = useRef(view);
  useEffect(() => {
    if (shown.current === view) return;
    shown.current = view;
    const main = document.getElementById("main");
    const heading = main?.querySelector("h1");
    if (heading) heading.tabIndex = -1;
    (heading ?? main)?.focus();
  }, [view]);

  // Offline, the page gives way and comes back when the connection does; what was typed is kept.
  const page = !online ? (
    <OfflinePage onRetry={refresh} />
  ) : ended ? (
    <SignedOutPage signIn={ended} />
  ) : !match ? (
    <NotFoundPage />
  ) : redirect ? null : match.route.access === "business" && business?.suspended ? (
    <SuspendedPage />
  ) : (
    <RoutePage name={match.route.name} params={match.params} />
  );
  // Before a person has a business, the entry pages sit outside the app shell.
  if (match && entryRoutes.has(match.route.name)) return <EntryFrame>{page}</EntryFrame>;
  return (
    <Shell current={match?.route.name ?? null} banner={banner}>
      {page}
    </Shell>
  );
}
