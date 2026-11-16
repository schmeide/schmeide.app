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

const open = (path: string, invites: Handlers) => {
  window.history.replaceState(null, "", path);
  const { handlers } = authServer({ session: signedOut, account: { ...ada, password: PASSWORD } });
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
