import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { App } from "../../App";
import { copy } from "../../data/copy";
import { signedOut, type Session } from "../../utils/session";
import { NotFoundPage } from "../NotFoundPage";
import { Routes } from "../Routes";
import { aProject, authServer, projectServer, renderWithApi } from "./fakeApi";

// The real plan list is empty until #119, so these tests give the route helpers two fixture ids.
const PLANS = ["starter", "business"];
vi.mock("../../utils/routes", async (original) => {
  const real = await original<typeof import("../../utils/routes")>();
  return {
    ...real,
    planFrom: (search: string) => real.planFrom(search, PLANS),
    carryPlan: (path: string, search: string) => real.carryPlan(path, search, PLANS),
    guard: (...[route, session, location]: Parameters<typeof real.guard>) =>
      real.guard(route, session, location, PLANS),
  };
});
const leaveTo = vi.hoisted(() => vi.fn());
vi.mock("../../utils/navigation", async (original) => ({
  ...(await original<typeof import("../../utils/navigation")>()),
  leaveTo,
}));

const person = { name: "Ada Lovelace", email: "ada@example.com" };
const owner: Session = { person, businesses: [{ id: 1, name: "Ada's bakery" }] };
const newcomer: Session = { person, businesses: [] };

const api = projectServer({ project: aProject() });
const open = (path: string, session: Session) => {
  window.history.replaceState(null, "", path);
  return renderWithApi(<Routes />, api, session);
};
const backToSite = () =>
  screen.getByRole("link", { name: `${copy.shell.logo}${copy.entry.logoHint}` });

afterEach(() => {
  vi.unstubAllGlobals();
  leaveTo.mockReset();
});

describe("the entry frame", () => {
  it.each([
    ["sign in", "/sign-in", signedOut],
    ["sign up", "/sign-up", signedOut],
    ["set your password", "/set-password", signedOut],
    ["set up your business", "/welcome", newcomer],
  ])(
    "frames %s with no app navigation and the logo leading to schmeide.com",
    (_, path, session) => {
      open(path, session);
      expect(backToSite()).toHaveAttribute("href", copy.outbound.marketingSite);
      expect(screen.queryByRole("navigation", { name: copy.shell.primaryNav })).toBeNull();
      expect(screen.queryByRole("button", { name: copy.shell.menu })).toBeNull();
      expect(
        within(screen.getByRole("navigation", { name: copy.shell.legalNav }))
          .getAllByRole("link")
          .map((link) => link.getAttribute("href"))
      ).toEqual(["/terms", "/privacy", "/acceptable-use", "/report"]);
      expect(screen.getByRole("main")).toHaveAttribute("id", "main");
      expect(screen.getByRole("link", { name: copy.shell.skip })).toHaveAttribute("href", "#main");
    }
  );

  it("offers a person with no business yet their account menu, so they can sign out", async () => {
    open("/welcome", newcomer);
    await userEvent.click(screen.getByRole("button", { name: "Ada Lovelace" }));
    expect(screen.getByRole("button", { name: copy.shell.signOut })).toBeInTheDocument();
  });

  it("gives way to the app shell once the person has a business", () => {
    open("/", owner);
    expect(screen.getByRole("navigation", { name: copy.shell.primaryNav })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: copy.shell.logo })).toHaveAttribute("href", "/");
  });

  it("keeps public pages such as the terms in the app shell", () => {
    open("/terms", signedOut);
    expect(screen.getByRole("link", { name: copy.shell.logo })).toHaveAttribute("href", "/");
  });
});

describe("the sign-up page", () => {
  it("explains that Schmeide is invite-only and links to the early-access form", () => {
    open("/sign-up", signedOut);
    expect(screen.getByRole("heading", { level: 1, name: copy.routes.signUp })).toBeInTheDocument();
    expect(screen.getByText(copy.signUpPage.inviteOnly)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: copy.signUpPage.askForAccess })).toHaveAttribute(
      "href",
      "https://schmeide.com/#early-access"
    );
    expect(document.title).toBe(copy.pageTitle(copy.routes.signUp));
  });

  it("leads someone already invited to sign in, keeping where they were going", () => {
    open("/sign-up?next=%2Fbilling", signedOut);
    expect(screen.getByRole("link", { name: copy.signUpPage.signIn })).toHaveAttribute(
      "href",
      "/sign-in?next=%2Fbilling"
    );
  });

  it("passes a known plan on to sign-in and says so, without showing its id", () => {
    open("/sign-up?plan=starter&next=%2Fbilling", signedOut);
    expect(screen.getByText(copy.signUpPage.planKept)).toBeInTheDocument();
    expect(screen.queryByText(/starter/)).toBeNull();
    expect(screen.getByRole("link", { name: copy.signUpPage.signIn })).toHaveAttribute(
      "href",
      "/sign-in?next=%2Fbilling&plan=starter"
    );
  });

  it("drops an unknown plan without an error", () => {
    open("/sign-up?plan=%3Cb%3Eenterprise%3C%2Fb%3E", signedOut);
    expect(screen.queryByText(copy.signUpPage.planKept)).toBeNull();
    expect(screen.queryByText(/enterprise/)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("link", { name: copy.signUpPage.signIn })).toHaveAttribute(
      "href",
      "/sign-in"
    );
  });

  it("sends a person who is already signed in straight on, with the plan", async () => {
    open("/sign-up?plan=business", owner);
    await waitFor(() =>
      expect(window.location.pathname + window.location.search).toBe("/?plan=business")
    );
  });
});

describe("the sign-in page as an entry page", () => {
  it("carries a known plan through a provider sign-in, inside the address it returns to", async () => {
    window.history.replaceState(null, "", "/sign-in?next=%2Fbilling&plan=starter");
    const { handlers, requests } = authServer({ session: signedOut, providers: ["google"] });
    renderWithApi(<App isPublicSite={false} />, { ...api, ...handlers }, "server");
    await userEvent.click(
      await screen.findByRole("button", { name: copy.signInPage.provider.google })
    );
    await waitFor(() => expect(leaveTo).toHaveBeenCalled());
    expect(requests[0].body).toMatchObject({
      callbackURL: `${window.location.origin}/billing?plan=starter`,
    });
  });

  it("carries a known plan and next through the set-password link", async () => {
    const password = "correct horse battery";
    window.history.replaceState(null, "", "/set-password?token=abc&next=%2Fbilling&plan=starter");
    const { handlers } = authServer({
      session: signedOut,
      account: { ...owner, password },
    });
    renderWithApi(
      <App isPublicSite={false} />,
      {
        ...api,
        ...handlers,
        "invites.get": () => ({ email: person.email, hasAccount: true }),
        "invites.accept": () => ({ email: person.email }),
      },
      "server"
    );
    await userEvent.type(
      await screen.findByLabelText(copy.setPasswordPage.passwordLabel),
      password
    );
    await userEvent.type(screen.getByLabelText(copy.setPasswordPage.confirmLabel), password);
    await userEvent.click(screen.getByRole("button", { name: copy.setPasswordPage.action }));
    await waitFor(() =>
      expect(window.location.pathname + window.location.search).toBe("/billing?plan=starter")
    );
  });

  it("links someone not invited yet to the early-access form", () => {
    open("/sign-in", signedOut);
    expect(screen.getByRole("link", { name: copy.signInPage.notInvited })).toHaveAttribute(
      "href",
      "https://schmeide.com/#early-access"
    );
  });

  it("confirms a sign-out, with the way back to schmeide.com", async () => {
    const { handlers } = authServer({ session: owner });
    window.history.replaceState(null, "", "/usage");
    renderWithApi(<App isPublicSite={false} />, { ...api, ...handlers }, "server");
    await userEvent.click(await screen.findByRole("button", { name: "Ada Lovelace" }));
    await userEvent.click(screen.getByRole("button", { name: copy.shell.signOut }));
    expect(await screen.findByText(copy.signInPage.signedOut)).toBeInTheDocument();
    expect(window.location.pathname).toBe("/sign-in");
    expect(backToSite()).toHaveAttribute("href", copy.outbound.marketingSite);
  });
});

describe("the not found and no access page", () => {
  it("links back to schmeide.com as well as to the person's apps", () => {
    renderWithApi(<NotFoundPage />, {}, owner);
    expect(screen.getByRole("link", { name: copy.problems.action })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: copy.problems.toMarketingSite })).toHaveAttribute(
      "href",
      copy.outbound.marketingSite
    );
  });
});
