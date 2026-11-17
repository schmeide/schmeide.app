import { copy } from "../data/copy";
import type { Session } from "./session";

// Who may open a route: anyone, a signed-in person, or a signed-in person with a business.
export type Access = "public" | "signedIn" | "business";

// The one route table. A `:name` segment is a numeric id. Paths, not hashes: sign-in links,
// invitations, and payment returns arrive as full addresses with query values.
const table = {
  apps: { path: "/", access: "business" },
  start: { path: "/new", access: "business" },
  startExisting: { path: "/new/existing", access: "business" },
  project: { path: "/projects/:id", access: "business" },
  projectChanges: { path: "/projects/:id/changes", access: "business" },
  projectSettings: { path: "/projects/:id/settings", access: "business" },
  usage: { path: "/usage", access: "business" },
  billing: { path: "/billing", access: "business" },
  business: { path: "/business", access: "business" },
  account: { path: "/account", access: "signedIn" },
  welcome: { path: "/welcome", access: "signedIn" },
  help: { path: "/help", access: "public" },
  signIn: { path: "/sign-in", access: "public" },
  setPassword: { path: "/set-password", access: "public" },
  terms: { path: "/terms", access: "public" },
  privacy: { path: "/privacy", access: "public" },
  acceptableUse: { path: "/acceptable-use", access: "public" },
  report: { path: "/report", access: "public" },
} as const satisfies Record<string, { readonly path: string; readonly access: Access }>;

export type RouteName = keyof typeof table;
export type Route = {
  readonly name: RouteName;
  readonly path: string;
  readonly access: Access;
  readonly title: string;
};
export type RouteParams = Readonly<Record<string, number>>;
export type RouteMatch = { readonly route: Route; readonly params: RouteParams };

const names = Object.keys(table) as RouteName[];

export const routes: readonly Route[] = names.map((name) => ({
  name,
  ...table[name],
  title: copy.routes[name],
}));

const segments = (path: string) => path.split("/").filter(Boolean);
const ID = /^\d+$/;

// The route a pathname names, or null when it names none. A trailing slash is ignored.
export const matchRoute = (pathname: string): RouteMatch | null => {
  const parts = segments(pathname);
  for (const route of routes) {
    const pattern = segments(route.path);
    if (pattern.length !== parts.length) continue;
    const params: Record<string, number> = {};
    const fits = pattern.every((segment, index) => {
      if (!segment.startsWith(":")) return segment === parts[index];
      if (!ID.test(parts[index])) return false;
      params[segment.slice(1)] = Number(parts[index]);
      return true;
    });
    if (fits) return { route, params };
  }
  return null;
};

export const pathTo = (name: RouteName, params: RouteParams = {}): string =>
  table[name].path.replace(/:(\w+)/g, (_, key: string) => String(params[key]));

// Where sign-in returns to: only a path on this site, never another origin.
export const nextPath = (search: string): string => {
  const next = new URLSearchParams(search).get("next");
  return next && /^\/(?![/\\])/.test(next) ? next : pathTo("apps");
};

export type Guarded =
  { readonly kind: "page" } | { readonly kind: "redirect"; readonly to: string };

const redirect = (to: string): Guarded => ({ kind: "redirect", to });

// Decides whether this session may see the route, and where it goes instead when it may not.
export const guard = (
  route: Route,
  session: Session,
  location: { readonly pathname: string; readonly search: string }
): Guarded => {
  if (!session.person) {
    if (route.access === "public") return { kind: "page" };
    const asked = location.pathname + location.search;
    const home = asked === pathTo("apps");
    return redirect(
      home ? pathTo("signIn") : `${pathTo("signIn")}?next=${encodeURIComponent(asked)}`
    );
  }
  if (route.name === "signIn") return redirect(nextPath(location.search));
  const hasBusiness = session.businesses.length > 0;
  if (route.access === "business" && !hasBusiness) return redirect(pathTo("welcome"));
  if (route.name === "welcome" && hasBusiness) return redirect(pathTo("apps"));
  return { kind: "page" };
};
