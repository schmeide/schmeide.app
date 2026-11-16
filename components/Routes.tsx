import { useEffect, useLayoutEffect, useRef, useSyncExternalStore, type ReactNode } from "react";

import { copy } from "../data/copy";
import { currentLocation, navigate, subscribe } from "../utils/navigation";
import { guard, matchRoute } from "../utils/routes";
import { RoutePage } from "./RoutePage";
import { RouteProblem } from "./RouteProblem";
import { useSession } from "./SessionProvider";
import { Shell } from "./Shell";

// Shows the page the address names inside the shell, after the route guard has had its say.
export function Routes({ banner }: { readonly banner?: ReactNode }) {
  const { session } = useSession();
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

  useEffect(() => {
    if (redirect) navigate(redirect, { replace: true });
  }, [redirect]);

  // A layout effect, so a page that names itself (a project) can set its own title in an effect
  // afterwards.
  const title = match ? match.route.title : copy.problems.notFound.title;
  useLayoutEffect(() => {
    document.title = copy.pageTitle(title);
  }, [title]);

  // After a view change, move focus to the new page's heading so it is announced and Tab starts
  // there. Not on the first load, where the browser's own start of page is right.
  const shown = useRef(pathname);
  useEffect(() => {
    if (shown.current === pathname) return;
    shown.current = pathname;
    const main = document.getElementById("main");
    const heading = main?.querySelector("h1");
    if (heading) heading.tabIndex = -1;
    (heading ?? main)?.focus();
  }, [pathname]);

  return (
    <Shell current={match?.route.name ?? null} banner={banner}>
      {!match ? (
        <RouteProblem kind="notFound" />
      ) : redirect ? null : (
        <RoutePage name={match.route.name} params={match.params} />
      )}
    </Shell>
  );
}
