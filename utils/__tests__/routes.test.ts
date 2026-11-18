import {
  carryPlan,
  entryRoutes,
  guard,
  matchRoute,
  nextPath,
  pathTo,
  planFrom,
  routes,
  type RouteName,
} from "../routes";
import { signedOut, type Session } from "../session";

const person = { name: "Ada", email: "ada@example.com" };
const newcomer: Session = { person, businesses: [] };
const owner: Session = { person, businesses: [{ id: 1, name: "Ada's bakery" }] };
const admin: Session = { person: { ...person, role: "admin" }, businesses: [] };

const route = (name: RouteName) => {
  const found = routes.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`no route ${name}`);
  return found;
};
const at = (pathname: string, search = "") => ({ pathname, search });

describe("the route table", () => {
  it("gives every route a title and a path of its own", () => {
    expect(routes.every((entry) => entry.title.length > 0)).toBe(true);
    expect(new Set(routes.map((entry) => entry.path)).size).toBe(routes.length);
  });

  it("matches each route's own path", () => {
    expect(routes.map((entry) => matchRoute(pathTo(entry.name, { id: 7 }))?.route.name)).toEqual(
      routes.map((entry) => entry.name)
    );
  });

  it("reads the id out of a project address, ignoring a trailing slash", () => {
    expect(matchRoute("/projects/7")?.params).toEqual({ id: 7 });
    expect(matchRoute("/projects/7/")?.route.name).toBe("project");
    expect(matchRoute("/usage/")?.route.name).toBe("usage");
  });

  it("matches nothing for an unknown address or an id that is not a number", () => {
    expect(matchRoute("/nowhere")).toBeNull();
    expect(matchRoute("/projects/abc")).toBeNull();
    expect(matchRoute("/projects/7/extra/deep")).toBeNull();
  });
});

describe("guard", () => {
  it("sends a signed-out person to sign in, remembering the page they asked for", () => {
    expect(guard(route("project"), signedOut, at("/projects/7", "?tab=1"))).toEqual({
      kind: "redirect",
      to: "/sign-in?next=%2Fprojects%2F7%3Ftab%3D1",
    });
    expect(guard(route("apps"), signedOut, at("/"))).toEqual({ kind: "redirect", to: "/sign-in" });
  });

  it("lets anyone open a public page", () => {
    expect(guard(route("terms"), signedOut, at("/terms"))).toEqual({ kind: "page" });
    expect(guard(route("signIn"), signedOut, at("/sign-in"))).toEqual({ kind: "page" });
    expect(guard(route("signUp"), signedOut, at("/sign-up", "?plan=starter"))).toEqual({
      kind: "page",
    });
  });

  it("sends a signed-in person on from sign up, as from sign in", () => {
    expect(guard(route("signUp"), owner, at("/sign-up", "?plan=starter"))).toEqual({
      kind: "redirect",
      to: "/",
    });
    expect(guard(route("signUp"), owner, at("/sign-up", "?next=%2Fbilling"))).toEqual({
      kind: "redirect",
      to: "/billing",
    });
    expect(guard(route("signUp"), newcomer, at("/sign-up"))).toEqual({ kind: "redirect", to: "/" });
    expect(
      guard(route("signUp"), owner, at("/sign-up", "?next=https%3A%2F%2Fevil.example"))
    ).toEqual({ kind: "redirect", to: "/" });
  });

  it("returns a signed-in person from sign in to the page they asked for", () => {
    expect(guard(route("signIn"), owner, at("/sign-in", "?next=%2Fprojects%2F7"))).toEqual({
      kind: "redirect",
      to: "/projects/7",
    });
    expect(guard(route("signIn"), owner, at("/sign-in"))).toEqual({ kind: "redirect", to: "/" });
  });

  it("sends a person with no business to set one up, and nowhere else once they have one", () => {
    expect(guard(route("apps"), newcomer, at("/"))).toEqual({ kind: "redirect", to: "/welcome" });
    expect(guard(route("welcome"), newcomer, at("/welcome"))).toEqual({ kind: "page" });
    expect(guard(route("account"), newcomer, at("/account"))).toEqual({ kind: "page" });
    expect(guard(route("welcome"), owner, at("/welcome"))).toEqual({ kind: "redirect", to: "/" });
    expect(guard(route("apps"), owner, at("/"))).toEqual({ kind: "page" });
  });

  it("brings a person with no business back to the page they asked for once it is set up", () => {
    expect(guard(route("project"), newcomer, at("/projects/7", "?tab=1"))).toEqual({
      kind: "redirect",
      to: "/welcome?next=%2Fprojects%2F7%3Ftab%3D1",
    });
    expect(guard(route("start"), newcomer, at("/new"))).toEqual({
      kind: "redirect",
      to: "/welcome?next=%2Fnew",
    });
    expect(guard(route("welcome"), owner, at("/welcome", "?next=%2Fnew"))).toEqual({
      kind: "redirect",
      to: "/new",
    });
    expect(
      guard(route("welcome"), owner, at("/welcome", "?next=https%3A%2F%2Fevil.example"))
    ).toEqual({ kind: "redirect", to: "/" });
  });
});

describe("the admin area", () => {
  it("sends a signed-out person to sign in", () => {
    expect(guard(route("admin"), signedOut, at("/admin"))).toEqual({
      kind: "redirect",
      to: "/sign-in?next=%2Fadmin",
    });
  });

  it("sends away a signed-in person without the role", () => {
    expect(guard(route("admin"), owner, at("/admin"))).toEqual({ kind: "redirect", to: "/" });
    expect(guard(route("admin"), newcomer, at("/admin"))).toEqual({ kind: "redirect", to: "/" });
  });

  it("lets an admin in, and sends an admin with no business there instead of to set one up", () => {
    expect(guard(route("admin"), admin, at("/admin"))).toEqual({ kind: "page" });
    expect(guard(route("apps"), admin, at("/"))).toEqual({ kind: "redirect", to: "/admin" });
    const adminOwner: Session = { ...admin, businesses: owner.businesses };
    expect(guard(route("admin"), adminOwner, at("/admin"))).toEqual({ kind: "page" });
    expect(guard(route("apps"), adminOwner, at("/"))).toEqual({ kind: "page" });
  });
});

describe("viewing as a customer", () => {
  it("has no page of its own: it starts from a person's row in the admin area", () => {
    expect(routes.map((entry) => entry.path)).not.toContain("/admin/view-as");
    expect(matchRoute("/admin/view-as")).toBeNull();
  });
});

const PLANS = ["starter", "business"];

describe("a plan chosen on schmeide.com", () => {
  it("is read from the address only when it is a known plan", () => {
    expect(planFrom("?plan=starter", PLANS)).toBe("starter");
    expect(planFrom("?next=%2F&plan=business", PLANS)).toBe("business");
    expect(planFrom("?plan=enterprise", PLANS)).toBeNull();
    expect(planFrom("?plan=%3Cscript%3E", PLANS)).toBeNull();
    expect(planFrom("?plan=", PLANS)).toBeNull();
    expect(planFrom("", PLANS)).toBeNull();
  });

  it("is unknown until the server exposes the plans (#119)", () => {
    expect(planFrom("?plan=starter")).toBeNull();
    expect(carryPlan("/", "?plan=starter")).toBe("/");
  });

  it("is carried onto the next address, keeping that address's own query", () => {
    expect(carryPlan("/", "?plan=starter", PLANS)).toBe("/?plan=starter");
    expect(carryPlan("/billing?paid=1", "?plan=starter", PLANS)).toBe(
      "/billing?paid=1&plan=starter"
    );
    expect(carryPlan("/", "?plan=enterprise", PLANS)).toBe("/");
    expect(carryPlan("/go?plan=business", "?plan=starter", PLANS)).toBe("/go?plan=business");
  });

  it("travels through each redirect on the way in", () => {
    expect(guard(route("signIn"), owner, at("/sign-in", "?plan=starter"), PLANS)).toEqual({
      kind: "redirect",
      to: "/?plan=starter",
    });
    expect(
      guard(route("signUp"), owner, at("/sign-up", "?next=%2Fbilling&plan=starter"), PLANS)
    ).toEqual({ kind: "redirect", to: "/billing?plan=starter" });
    expect(guard(route("apps"), newcomer, at("/", "?plan=starter"), PLANS)).toEqual({
      kind: "redirect",
      to: "/welcome?plan=starter",
    });
    expect(guard(route("welcome"), owner, at("/welcome", "?plan=starter"), PLANS)).toEqual({
      kind: "redirect",
      to: "/?plan=starter",
    });
    expect(guard(route("billing"), newcomer, at("/billing", "?plan=starter"), PLANS)).toEqual({
      kind: "redirect",
      to: "/welcome?next=%2Fbilling%3Fplan%3Dstarter&plan=starter",
    });
    expect(
      guard(route("welcome"), owner, at("/welcome", "?next=%2Fnew&plan=starter"), PLANS)
    ).toEqual({ kind: "redirect", to: "/new?plan=starter" });
    expect(guard(route("signIn"), owner, at("/sign-in", "?plan=enterprise"), PLANS)).toEqual({
      kind: "redirect",
      to: "/",
    });
  });

  it("rides inside next for a signed-out person, with nothing stored", () => {
    expect(guard(route("apps"), signedOut, at("/", "?plan=starter"), PLANS)).toEqual({
      kind: "redirect",
      to: "/sign-in?next=%2F%3Fplan%3Dstarter",
    });
  });
});

describe("entryRoutes", () => {
  it("are the pages a person arriving from schmeide.com sees before they have a business", () => {
    expect([...entryRoutes].sort()).toEqual(["setPassword", "signIn", "signUp", "welcome"]);
  });
});

describe("nextPath", () => {
  it("only returns to a path on this site", () => {
    expect(nextPath("?next=%2Fbilling%3Fpaid%3D1")).toBe("/billing?paid=1");
    expect(nextPath("?next=https%3A%2F%2Fevil.example")).toBe("/");
    expect(nextPath("?next=%2F%2Fevil.example")).toBe("/");
    expect(nextPath("?next=%2F%5Cevil.example")).toBe("/");
    expect(nextPath("")).toBe("/");
  });
});
