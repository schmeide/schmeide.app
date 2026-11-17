import { copy } from "../data/copy";
import { isAdmin, type Session } from "./session";

// Who may open a route: anyone, a signed-in person, a signed-in person with a business, or a
// person with the platform admin role. The server checks again; this only picks the page.
export type Access = "public" | "signedIn" | "business" | "admin";

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
  admin: { path: "/admin", access: "admin" },
  adminBusinesses: { path: "/admin/businesses", access: "admin" },
  adminBusiness: { path: "/admin/businesses/:id", access: "admin" },
  adminPeople: { path: "/admin/people", access: "admin" },
  adminAdmins: { path: "/admin/admins", access: "admin" },
  adminProjects: { path: "/admin/projects", access: "admin" },
  adminUsage: { path: "/admin/usage", access: "admin" },
  adminAudit: { path: "/admin/audit", access: "admin" },
  help: { path: "/help", access: "public" },
  signIn: { path: "/sign-in", access: "public" },
  signUp: { path: "/sign-up", access: "public" },
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

// The pages a person arriving from schmeide.com sees before they have a business. They sit in the
// entry frame, not the app shell: no app navigation, and the logo leads back to schmeide.com.
export const entryRoutes: ReadonlySet<RouteName> = new Set<RouteName>([
  "signIn",
  "signUp",
  "setPassword",
  "welcome",
]);

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

// The plan ids schmeide.com's pricing page may send with `?plan=<id>`. Empty until the server
// exposes the plans (#119); until then every id is unknown and dropped.
export const KNOWN_PLANS: readonly string[] = [];

// The plan a person chose on schmeide.com: only a known id, otherwise null without an error. It is
// never put into the page.
export const planFrom = (search: string, known: readonly string[] = KNOWN_PLANS): string | null => {
  const plan = new URLSearchParams(search).get("plan");
  return plan && known.includes(plan) ? plan : null;
};

// `path` with the known plan from `search` added to its query, so the plan travels with the
// person: through a redirect, a provider sign-in (inside `next`), and the set-password link, on to
// checkout (#61). Nothing is stored. A path that already names a plan keeps its own.
export const carryPlan = (
  path: string,
  search: string,
  known: readonly string[] = KNOWN_PLANS
): string => {
  const plan = planFrom(search, known);
  if (!plan) return path;
  const [pathname, query = ""] = path.split("?");
  const params = new URLSearchParams(query);
  if (params.has("plan")) return path;
  params.set("plan", plan);
  return `${pathname}?${params.toString()}`;
};

export type Guarded =
  { readonly kind: "page" } | { readonly kind: "redirect"; readonly to: string };

const redirect = (to: string): Guarded => ({ kind: "redirect", to });

// Decides whether this session may see the route, and where it goes instead when it may not.
export const guard = (
  route: Route,
  session: Session,
  location: { readonly pathname: string; readonly search: string },
  known: readonly string[] = KNOWN_PLANS
): Guarded => {
  const carried = (path: string) => carryPlan(path, location.search, known);
  if (!session.person) {
    if (route.access === "public") return { kind: "page" };
    const asked = location.pathname + location.search;
    const home = asked === pathTo("apps");
    return redirect(
      home ? pathTo("signIn") : `${pathTo("signIn")}?next=${encodeURIComponent(asked)}`
    );
  }
  if (route.name === "signIn" || route.name === "signUp")
    return redirect(carried(nextPath(location.search)));
  if (route.access === "admin" && !isAdmin(session)) return redirect(pathTo("apps"));
  const hasBusiness = session.businesses.length > 0;
  if (route.access === "business" && !hasBusiness)
    return redirect(isAdmin(session) ? pathTo("admin") : carried(pathTo("welcome")));
  if (route.name === "welcome" && hasBusiness) return redirect(carried(pathTo("apps")));
  return { kind: "page" };
};
