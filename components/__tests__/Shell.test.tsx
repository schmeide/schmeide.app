import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { copy } from "../../data/copy";
import { BUSINESS_HEADER, businessHeaders, chooseBusiness } from "../../utils/chosenBusiness";
import { navigate } from "../../utils/navigation";
import { signedOut, type Session } from "../../utils/session";
import { App } from "../../App";
import { Routes } from "../Routes";
import { aProject, authServer, projectServer, renderWithApi } from "./fakeApi";

const person = { name: "Ada Lovelace", email: "ada@example.com" };
const owner: Session = { person, businesses: [{ id: 1, name: "Ada's bakery" }] };
const newcomer: Session = { person, businesses: [] };
const admin: Session = { person: { ...person, role: "admin" }, businesses: [] };
const bookkeeper: Session = {
  person,
  businesses: [
    { id: 1, name: "Ada's bakery" },
    { id: 2, name: "Byron's books" },
  ],
};

const api = projectServer({ project: aProject() });
const open = (path: string, session?: Session, banner?: string) => {
  window.history.replaceState(null, "", path);
  return renderWithApi(<Routes banner={banner} />, api, session);
};
const primaryNav = () => screen.getByRole("navigation", { name: copy.shell.primaryNav });

describe("the signed-in shell", () => {
  it("frames the page with the logo, business, navigation, and legal links", async () => {
    open("/", owner);
    expect(screen.getByRole("link", { name: copy.shell.logo })).toHaveAttribute("href", "/");
    expect(screen.getByText("Ada's bakery")).toBeInTheDocument();
    expect(
      within(primaryNav())
        .getAllByRole("link")
        .map((link) => [link.textContent, link.getAttribute("href")])
    ).toEqual([
      ["Apps", "/"],
      ["Usage", "/usage"],
      ["Billing", "/billing"],
      ["Help", "/help"],
    ]);
    expect(
      within(screen.getByRole("navigation", { name: copy.shell.legalNav }))
        .getAllByRole("link")
        .map((link) => link.getAttribute("href"))
    ).toEqual(["/terms", "/privacy", "/acceptable-use", "/report"]);
    expect(await screen.findByRole("main")).toHaveAttribute("id", "main");
    expect(screen.getByRole("link", { name: copy.shell.skip })).toHaveAttribute("href", "#main");
  });

  it("marks the current page in the navigation and names the tab after it", () => {
    open("/usage", owner);
    expect(within(primaryNav()).getByRole("link", { name: "Usage" })).toHaveAttribute(
      "aria-current",
      "page"
    );
    expect(within(primaryNav()).getByRole("link", { name: "Apps" })).not.toHaveAttribute(
      "aria-current"
    );
    expect(document.title).toBe(copy.pageTitle("Usage"));
  });

  it("changes the page without a reload, then moves focus to its heading", async () => {
    open("/", owner);
    expect(document.body).toHaveFocus();
    await userEvent.click(within(primaryNav()).getByRole("link", { name: "Billing" }));
    expect(window.location.pathname).toBe("/billing");
    expect(screen.getByRole("heading", { level: 1, name: "Billing" })).toHaveFocus();
    expect(document.title).toBe(copy.pageTitle("Billing"));
  });

  it("follows Back", async () => {
    open("/", owner);
    act(() => navigate("/help"));
    expect(screen.getByRole("heading", { level: 1, name: "Help" })).toBeInTheDocument();
    act(() => window.history.back());
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Help" })).toBeNull());
    expect(window.location.pathname).toBe("/");
  });

  it("names the tab after the project on its page", async () => {
    open("/projects/7", owner);
    await screen.findByRole("heading", { level: 1, name: "Invoices" });
    await waitFor(() => expect(document.title).toBe(copy.pageTitle("Invoices")));
  });

  it("opens the account menu, and closes it with Escape", async () => {
    open("/", owner);
    const button = screen.getByRole("button", { name: "Ada Lovelace" });
    expect(button).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    const menu = screen.getByRole("navigation", { name: copy.shell.accountNav });
    expect(
      within(menu)
        .getAllByRole("link")
        .map((link) => [link.textContent, link.getAttribute("href")])
    ).toEqual([
      ["Account", "/account"],
      ["Business", "/business"],
      ["Billing", "/billing"],
      ["Help", "/help"],
    ]);
    expect(within(menu).getByRole("button", { name: copy.shell.signOut })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(button).toHaveFocus();
  });

  it("opens and closes the navigation from the menu button used on a narrow screen", async () => {
    open("/", owner);
    const button = screen.getByRole("button", { name: copy.shell.menu });
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(button).toHaveAttribute("aria-controls", primaryNav().id);
    await userEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(within(primaryNav()).getByRole("link", { name: "Help" }));
    expect(button).toHaveAttribute("aria-expanded", "false");
  });

  it("shows a banner above the page when there is one, and no banner region otherwise", () => {
    open("/", owner, "Your payment didn't go through.");
    expect(screen.getByRole("complementary", { name: copy.shell.notices })).toHaveTextContent(
      "Your payment didn't go through."
    );
  });

  it("has no banner region without a banner", () => {
    open("/", owner);
    expect(screen.queryByRole("complementary")).toBeNull();
  });

  it("lets a person in several businesses switch, and loads the other one's apps", async () => {
    const calls = open("/", bookkeeper);
    const lists = () => calls.filter((call) => call.path === "projects.list").length;
    const switcher = screen.getByRole("combobox", { name: copy.shell.businessLabel });
    expect(switcher).toHaveDisplayValue("Ada's bakery");
    await waitFor(() => expect(lists()).toBe(1));
    expect(businessHeaders()).toEqual({});

    await userEvent.selectOptions(switcher, "Byron's books");
    expect(switcher).toHaveDisplayValue("Byron's books");
    // Every later call names the business, and what was on screen is asked for again.
    expect(businessHeaders()).toEqual({ [BUSINESS_HEADER]: "2" });
    await waitFor(() => expect(lists()).toBe(2));
    chooseBusiness(null);
  });
});

describe("route guards", () => {
  it("sends a signed-out person to sign in, then back to the page they asked for", async () => {
    const { handlers } = authServer({
      session: signedOut,
      account: { ...owner, password: "correct horse battery" },
    });
    window.history.replaceState(null, "", "/projects/7?from=email");
    renderWithApi(<App isPublicSite={false} />, { ...api, ...handlers }, "server");
    await waitFor(() => expect(window.location.pathname).toBe("/sign-in"));
    expect(window.location.search).toBe("?next=%2Fprojects%2F7%3Ffrom%3Demail");
    expect(screen.queryByRole("navigation", { name: copy.shell.primaryNav })).toBeNull();
    expect(screen.queryByRole("button", { name: copy.shell.menu })).toBeNull();

    await userEvent.type(screen.getByLabelText(copy.signInPage.emailLabel), person.email);
    await userEvent.type(
      screen.getByLabelText(copy.signInPage.passwordLabel),
      "correct horse battery"
    );
    await userEvent.click(screen.getByRole("button", { name: copy.signInPage.action }));
    await waitFor(() => expect(window.location.pathname).toBe("/projects/7"));
    expect(window.location.search).toBe("?from=email");
    expect(await screen.findByRole("heading", { level: 1, name: "Invoices" })).toBeInTheDocument();
  });

  it("signs out on the server from the account menu", async () => {
    const { handlers, requests } = authServer({ session: owner });
    window.history.replaceState(null, "", "/usage");
    renderWithApi(<App isPublicSite={false} />, { ...api, ...handlers }, "server");
    await userEvent.click(await screen.findByRole("button", { name: "Ada Lovelace" }));
    await userEvent.click(screen.getByRole("button", { name: copy.shell.signOut }));
    await waitFor(() => expect(window.location.pathname).toBe("/sign-in"));
    expect(requests.map((request) => request.path)).toEqual(["/sign-out"]);
    expect(screen.queryByRole("button", { name: "Ada Lovelace" })).toBeNull();
  });

  it("lets a signed-out person read a public page, offering sign in", () => {
    open("/terms", signedOut);
    expect(screen.getByRole("heading", { level: 1, name: "Terms" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: copy.shell.signIn })).toHaveAttribute(
      "href",
      "/sign-in"
    );
  });

  it("sends a person with no business to set one up, without the business navigation", async () => {
    open("/", newcomer);
    await waitFor(() => expect(window.location.pathname).toBe("/welcome"));
    expect(
      screen.getByRole("heading", { level: 1, name: copy.routes.welcome })
    ).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: copy.shell.primaryNav })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Ada Lovelace" }));
    expect(
      within(screen.getByRole("navigation", { name: copy.shell.accountNav }))
        .getAllByRole("link")
        .map((link) => link.textContent)
    ).toEqual(["Account", "Help"]);
  });

  it("offers the admin area only to an admin, who lands there without a business", async () => {
    open("/", admin);
    await waitFor(() => expect(window.location.pathname).toBe("/admin"));
    expect(screen.getByRole("heading", { level: 1, name: copy.routes.admin })).toBeInTheDocument();
    expect(
      within(primaryNav())
        .getAllByRole("link")
        .map((link) => [link.textContent, link.getAttribute("href")])
    ).toEqual([[copy.routes.admin, "/admin"]]);
  });

  it("shows an admin in a business the admin area after the business navigation", () => {
    open("/", { ...admin, businesses: owner.businesses });
    expect(
      within(primaryNav())
        .getAllByRole("link")
        .map((link) => link.getAttribute("href"))
    ).toEqual(["/", "/usage", "/billing", "/help", "/admin"]);
  });

  it("sends a person without the role away from the admin area, and never offers it", async () => {
    open("/admin", owner);
    await waitFor(() => expect(window.location.pathname).toBe("/"));
    expect(within(primaryNav()).queryByRole("link", { name: copy.routes.admin })).toBeNull();
  });

  it("says so when the address matches nothing", () => {
    open("/nowhere", owner);
    expect(
      screen.getByRole("heading", { level: 1, name: copy.problems.notFound.title })
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: copy.problems.action })).toHaveAttribute("href", "/");
    expect(document.title).toBe(copy.pageTitle(copy.problems.notFound.title));
  });
});
