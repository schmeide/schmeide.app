import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { App } from "../../App";
import { copy } from "../../data/copy";
import { signedOut, type Session } from "../../utils/session";
import { ApiFailure, authServer, renderWithApi, type Handlers } from "./fakeApi";

const ada: Session = {
  person: { name: "Ada Lovelace", email: "ada@example.com" },
  businesses: [{ id: 1, name: "Ada's bakery" }],
};
const PASSWORD = "correct horse battery";

const open = (path: string, invites: Handlers, session: Session = signedOut) => {
  window.history.replaceState(null, "", path);
  const { handlers } = authServer({ session, account: { ...ada, password: PASSWORD } });
  return renderWithApi(
    <App isPublicSite={false} />,
    { ...handlers, "projects.list": () => [], ...invites },
    "server"
  );
};
const type = (label: string, text: string) => userEvent.type(screen.getByLabelText(label), text);
const save = () =>
  userEvent.click(screen.getByRole("button", { name: copy.setPasswordPage.action }));

describe("the set-password page", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("lets a new person set a name and password, then signs them in", async () => {
    const calls = open("/set-password?token=abc", {
      "invites.get": () => ({ email: "ada@example.com", hasAccount: false }),
      "invites.accept": () => ({ email: "ada@example.com" }),
    });
    expect(
      await screen.findByText(copy.setPasswordPage.intro("ada@example.com"))
    ).toBeInTheDocument();
    await type(copy.setPasswordPage.nameLabel, "Ada Lovelace");
    await type(copy.setPasswordPage.passwordLabel, PASSWORD);
    await type(copy.setPasswordPage.confirmLabel, PASSWORD);
    await save();

    await waitFor(() => expect(window.location.pathname).toBe("/"));
    expect(calls.find((call) => call.path === "invites.accept")?.input).toEqual({
      token: "abc",
      name: "Ada Lovelace",
      password: PASSWORD,
    });
    expect(await screen.findByRole("button", { name: "Ada Lovelace" })).toBeInTheDocument();
  });

  it("does not send two passwords that differ, and says so on the field", async () => {
    const calls = open("/set-password?token=abc", {
      "invites.get": () => ({ email: "ada@example.com", hasAccount: false }),
    });
    await screen.findByLabelText(copy.setPasswordPage.nameLabel);
    await type(copy.setPasswordPage.nameLabel, "Ada Lovelace");
    await type(copy.setPasswordPage.passwordLabel, PASSWORD);
    await type(copy.setPasswordPage.confirmLabel, "correct horse batter");
    await save();

    expect(await screen.findByRole("alert")).toHaveTextContent(copy.setPasswordPage.mismatch);
    expect(screen.getByLabelText(copy.setPasswordPage.confirmLabel)).toBeInvalid();
    expect(calls.some((call) => call.path === "invites.accept")).toBe(false);
  });

  it("asks an existing person only for a new password", async () => {
    open("/set-password?token=abc", {
      "invites.get": () => ({ email: "ada@example.com", hasAccount: true }),
    });
    expect(
      await screen.findByText(copy.setPasswordPage.resetIntro("ada@example.com"))
    ).toBeInTheDocument();
    expect(screen.queryByLabelText(copy.setPasswordPage.nameLabel)).toBeNull();
    expect(screen.getByLabelText(copy.setPasswordPage.passwordLabel)).toHaveAttribute(
      "autocomplete",
      "new-password"
    );
  });

  it("tells a new person which business invited them", async () => {
    open("/set-password?token=abc", {
      "invites.get": () => ({
        email: "ada@example.com",
        hasAccount: false,
        business: "Bob’s bikes",
      }),
    });
    expect(
      await screen.findByText(copy.setPasswordPage.invitedIntro("Bob’s bikes", "ada@example.com"))
    ).toBeInTheDocument();
    expect(screen.getByLabelText(copy.setPasswordPage.nameLabel)).toBeInTheDocument();
  });

  describe("for an invitation to a person who already has an account", () => {
    const invited: Handlers = {
      "invites.get": () => ({
        email: "ada@example.com",
        hasAccount: true,
        business: "Bob’s bikes",
      }),
    };

    it("never asks for a password, and sends a signed-out person to sign in and back", async () => {
      open("/set-password?token=abc", invited);
      expect(
        await screen.findByRole("heading", {
          level: 1,
          name: copy.setPasswordPage.joinTitle("Bob’s bikes"),
        })
      ).toBeInTheDocument();
      expect(screen.queryByLabelText(copy.setPasswordPage.passwordLabel)).toBeNull();
      expect(screen.getByText(copy.setPasswordPage.joinSignIn("ada@example.com"))).toBeVisible();
      expect(
        screen.getByRole("link", { name: copy.setPasswordPage.joinSignInAction })
      ).toHaveAttribute("href", "/sign-in?next=%2Fset-password%3Ftoken%3Dabc");
    });

    it("lets that person join once signed in, and takes them to the business", async () => {
      const state = { joined: false };
      const calls = open(
        "/set-password?token=abc",
        {
          ...invited,
          "invites.join": () => {
            state.joined = true;
            return { businessId: 2 };
          },
          "session.get": () => ({
            ...ada,
            businesses: state.joined
              ? [...ada.businesses, { id: 2, name: "Bob’s bikes" }]
              : ada.businesses,
            providers: [],
          }),
        },
        ada
      );
      await userEvent.click(
        await screen.findByRole("button", { name: copy.setPasswordPage.join("Bob’s bikes") })
      );
      await waitFor(() => expect(window.location.pathname).toBe("/"));
      expect(calls.find((call) => call.path === "invites.join")?.input).toEqual({ token: "abc" });
      expect(await screen.findByRole("combobox", { name: copy.shell.businessLabel })).toHaveValue(
        "2"
      );
    });

    it("tells a person signed in under another address to switch", async () => {
      open("/set-password?token=abc", {
        "invites.get": () => ({
          email: "bea@example.com",
          hasAccount: true,
          business: "Bob’s bikes",
        }),
        "session.get": () => ({ ...ada, providers: [] }),
      });
      expect(
        await screen.findByText(
          copy.setPasswordPage.joinWrongPerson("bea@example.com", "ada@example.com")
        )
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: copy.setPasswordPage.join("Bob’s bikes") })
      ).toBeNull();
    });
  });

  it.each([
    ["a used or expired link", "/set-password?token=dead"],
    ["an address with no token", "/set-password"],
  ])("says the link no longer works for %s, and offers sign in", async (_, path) => {
    open(path, {
      "invites.get": () => {
        throw new ApiFailure("NOT_FOUND");
      },
    });
    expect(
      await screen.findByRole("heading", { level: 1, name: copy.setPasswordPage.deadTitle })
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: copy.setPasswordPage.toSignIn })).toHaveAttribute(
      "href",
      "/sign-in"
    );
  });
});
