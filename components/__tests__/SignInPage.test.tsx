import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { App } from "../../App";
import { copy } from "../../data/copy";
import { signedOut, type Session } from "../../utils/session";
import { authServer, renderWithApi } from "./fakeApi";

const leaveTo = vi.hoisted(() => vi.fn());
vi.mock("../../utils/navigation", async (original) => ({
  ...(await original<typeof import("../../utils/navigation")>()),
  leaveTo,
}));

const ada: Session = {
  person: { name: "Ada Lovelace", email: "ada@example.com" },
  businesses: [{ id: 1, name: "Ada's bakery" }],
};

const open = (path: string, server: Parameters<typeof authServer>[0]) => {
  window.history.replaceState(null, "", path);
  const { handlers, requests } = authServer(server);
  renderWithApi(<App isPublicSite={false} />, { ...handlers, "projects.list": () => [] }, "server");
  return requests;
};
const fillIn = async (email: string, password: string) => {
  await userEvent.type(await screen.findByLabelText(copy.signInPage.emailLabel), email);
  await userEvent.type(screen.getByLabelText(copy.signInPage.passwordLabel), password);
  await userEvent.click(screen.getByRole("button", { name: copy.signInPage.action }));
};

describe("the sign-in page", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    leaveTo.mockReset();
  });

  it("says the app is invitation-only and offers a button for each provider that is on", async () => {
    open("/sign-in", { session: signedOut, providers: ["google", "apple"] });
    expect(await screen.findByText(copy.signInPage.intro)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: copy.signInPage.provider.google })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: copy.signInPage.provider.apple })
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: copy.signInPage.provider.microsoft })).toBeNull();
  });

  it("offers only email and password when no provider is on", async () => {
    open("/sign-in", { session: signedOut });
    expect(await screen.findByLabelText(copy.signInPage.emailLabel)).toHaveAttribute(
      "autocomplete",
      "email"
    );
    expect(screen.getByLabelText(copy.signInPage.passwordLabel)).toHaveAttribute(
      "autocomplete",
      "current-password"
    );
    expect(screen.queryByText(copy.signInPage.or)).toBeNull();
  });

  it("sends the person to the provider, to come back to the page they asked for", async () => {
    const requests = open("/sign-in?next=%2Fusage", { session: signedOut, providers: ["google"] });
    await userEvent.click(
      await screen.findByRole("button", { name: copy.signInPage.provider.google })
    );
    await waitFor(() => expect(leaveTo).toHaveBeenCalledWith("https://provider.example/google"));
    expect(requests).toEqual([
      {
        path: "/sign-in/social",
        body: {
          provider: "google",
          callbackURL: `${window.location.origin}/usage`,
          errorCallbackURL: `${window.location.origin}/sign-in?next=%2Fusage`,
        },
      },
    ]);
  });

  it.each([
    ["not_approved", copy.signInPage.refused.not_approved],
    ["email_not_verified", copy.signInPage.refused.email_not_verified],
    ["access_denied", copy.signInPage.providerFailed],
  ])("says why a provider sign-in was refused (%s)", async (reason, message) => {
    open(`/sign-in?error=${reason}`, { session: signedOut });
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
  });

  it("signs in with the right password and goes to the apps", async () => {
    open("/sign-in", { session: signedOut, account: { ...ada, password: "correct horse" } });
    await fillIn("ada@example.com", "correct horse");
    await waitFor(() => expect(window.location.pathname).toBe("/"));
    expect(await screen.findByRole("button", { name: "Ada Lovelace" })).toBeInTheDocument();
  });

  it("gives one message for a wrong email or password, and stays on the page", async () => {
    open("/sign-in", { session: signedOut, account: { ...ada, password: "correct horse" } });
    await fillIn("ada@example.com", "wrong horse");
    expect(await screen.findByRole("alert")).toHaveTextContent(copy.signInPage.wrong);
    expect(window.location.pathname).toBe("/sign-in");
    expect(screen.getByRole("button", { name: copy.signInPage.action })).toBeEnabled();
  });

  it.each([
    [429, copy.signInPage.tooMany],
    [403, copy.signInPage.refused.not_approved],
    [500, copy.signInPage.failed],
  ])("explains a sign-in the server answers with %i", async (signInStatus, message) => {
    open("/sign-in", { session: signedOut, signInStatus });
    await fillIn("ada@example.com", "correct horse");
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
  });
});
