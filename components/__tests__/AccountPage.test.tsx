import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { App } from "../../App";
import { copy } from "../../data/copy";
import type { Session } from "../../utils/session";
import { ApiFailure, authServer, renderWithApi, type Handlers } from "./fakeApi";

const leaveTo = vi.hoisted(() => vi.fn());
vi.mock("../../utils/navigation", async (original) => ({
  ...(await original<typeof import("../../utils/navigation")>()),
  leaveTo,
}));

const EMAIL = "ada@example.com";
const ada: Session = {
  person: { name: "Ada Lovelace", email: EMAIL },
  businesses: [{ id: 1, name: "Ada's bakery" }],
};
const since = new Date("2026-03-04T10:00:00Z");
const CHROME_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const FIREFOX_LINUX = "Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0";

type Account = {
  name: string;
  email: string;
  since: Date;
  methods: { id: string; kind: string; since: Date }[];
  devices: {
    id: string;
    current: boolean;
    userAgent: string | null;
    ipAddress: string | null;
    signedInAt: Date;
    lastActive: Date;
  }[];
  businesses: { id: number; name: string; onDelete: string }[];
};

const anAccount = (overrides: Partial<Account> = {}): Account => ({
  name: "Ada Lovelace",
  email: EMAIL,
  since,
  methods: [{ id: "m1", kind: "password", since }],
  devices: [
    {
      id: "d1",
      current: true,
      userAgent: CHROME_MAC,
      ipAddress: null,
      signedInAt: since,
      lastActive: since,
    },
  ],
  businesses: [{ id: 1, name: "Ada's bakery", onDelete: "remove" }],
  ...overrides,
});

const open = (account: Account, extra: Handlers = {}, path = "/account") => {
  window.history.replaceState(null, "", path);
  const state = { session: ada, providers: ["google", "microsoft"] as const };
  const { handlers, requests } = authServer({ ...state, providers: [...state.providers] });
  const calls = renderWithApi(
    <App isPublicSite={false} />,
    {
      ...handlers,
      "projects.list": () => [],
      "account.get": () => account,
      ...extra,
    },
    "server"
  );
  return { calls, requests };
};
const section = async (title: string) =>
  within((await screen.findByRole("heading", { name: title })).closest("section")!);
const day = (date: Date) =>
  new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);

describe("the account page", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    leaveTo.mockReset();
  });

  it("renames the person and says it saved", async () => {
    const { calls } = open(anAccount(), { "account.rename": () => null });
    const profile = await section(copy.accountPage.profile.title);
    expect(profile.getByText(EMAIL)).toBeInTheDocument();
    const name = profile.getByLabelText(copy.accountPage.profile.nameLabel);
    expect(name).toHaveValue("Ada Lovelace");
    await userEvent.clear(name);
    await userEvent.type(name, "Ada King");
    await userEvent.click(profile.getByRole("button", { name: copy.accountPage.profile.save }));

    await waitFor(() =>
      expect(profile.getByRole("status")).toHaveTextContent(copy.accountPage.profile.saved)
    );
    expect(calls.find((call) => call.path === "account.rename")?.input).toEqual({
      name: "Ada King",
    });
  });

  it("offers each provider the server has, and never disconnects the only way in", async () => {
    open(anAccount());
    const methods = await section(copy.accountPage.methods.title);
    expect(methods.getByText(copy.accountPage.methods.connectedOn(day(since)))).toBeInTheDocument();
    expect(methods.getByText(copy.accountPage.methods.onlyOne)).toBeInTheDocument();
    expect(methods.queryByRole("button", { name: /^Disconnect/ })).toBeNull();
    expect(methods.getByRole("button", { name: "Connect Google" })).toBeInTheDocument();
    expect(methods.getByRole("button", { name: "Connect Microsoft" })).toBeInTheDocument();
    expect(methods.queryByRole("button", { name: "Connect Apple" })).toBeNull();
  });

  it("lists an Auth0 sign-in the person has", async () => {
    open(
      anAccount({
        methods: [
          { id: "m1", kind: "password", since },
          { id: "m2", kind: "auth0", since },
        ],
      })
    );
    const methods = await section(copy.accountPage.methods.title);
    expect(methods.getByText(copy.accountPage.methods.kind.auth0)).toBeInTheDocument();
    expect(methods.getByRole("button", { name: "Disconnect Auth0" })).toBeInTheDocument();
  });

  it("sends the person to the provider to connect it, and back to this page", async () => {
    const { requests } = open(anAccount());
    const methods = await section(copy.accountPage.methods.title);
    await userEvent.click(methods.getByRole("button", { name: "Connect Google" }));
    await waitFor(() =>
      expect(leaveTo).toHaveBeenCalledWith("https://provider.example/link/google")
    );
    expect(requests.find((request) => request.path === "/link-social")?.body).toMatchObject({
      provider: "google",
      callbackURL: `${window.location.origin}/account`,
    });
  });

  it("says when a provider account was not connected", async () => {
    open(anAccount(), {}, "/account?error=unable_to_link_account");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      copy.accountPage.methods.connectFailed
    );
  });

  it("disconnects a method while another remains", async () => {
    const { calls } = open(
      anAccount({
        methods: [
          { id: "m1", kind: "password", since },
          { id: "m2", kind: "google", since },
        ],
      }),
      { "account.disconnect": () => null }
    );
    const methods = await section(copy.accountPage.methods.title);
    await userEvent.click(methods.getByRole("button", { name: "Disconnect Google" }));
    await waitFor(() =>
      expect(methods.getByRole("status")).toHaveTextContent(
        copy.accountPage.methods.disconnected("Google")
      )
    );
    expect(calls.find((call) => call.path === "account.disconnect")?.input).toEqual({ id: "m2" });
    expect(methods.getByRole("heading", { name: copy.accountPage.methods.title })).toHaveFocus();
  });

  it("lists devices, marks this one, and signs out the others", async () => {
    const { calls } = open(
      anAccount({
        devices: [
          ...anAccount().devices,
          {
            id: "d2",
            current: false,
            userAgent: FIREFOX_LINUX,
            ipAddress: null,
            signedInAt: since,
            lastActive: since,
          },
        ],
      }),
      { "account.signOutOthers": () => null }
    );
    const devices = await section(copy.accountPage.devices.title);
    const items = devices.getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("Chrome on macOS");
    expect(items[0]).toHaveTextContent(copy.accountPage.devices.thisDevice);
    expect(items[1]).toHaveTextContent("Firefox on Linux");
    expect(items[1]).not.toHaveTextContent(copy.accountPage.devices.thisDevice);
    await userEvent.click(
      devices.getByRole("button", { name: copy.accountPage.devices.signOutOthers })
    );
    await waitFor(() =>
      expect(devices.getByRole("status")).toHaveTextContent(
        copy.accountPage.devices.signedOutOthers
      )
    );
    expect(calls.some((call) => call.path === "account.signOutOthers")).toBe(true);
  });

  it("downloads the person's details as a file", async () => {
    const createObjectURL = vi.fn(() => "blob:details");
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    open(anAccount(), { "account.export": () => ({ person: { name: "Ada Lovelace" } }) });
    const details = await section(copy.accountPage.details.title);
    await userEvent.click(details.getByRole("button", { name: copy.accountPage.details.download }));
    await waitFor(() => expect(click).toHaveBeenCalled());
    expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
    click.mockRestore();
  });

  it("says what stops the account being deleted, and offers no delete button", async () => {
    open(
      anAccount({
        businesses: [
          { id: 1, name: "Ada's bakery", onDelete: "deleteApps" },
          { id: 2, name: "The shop", onDelete: "handOver" },
        ],
      })
    );
    const remove = await section(copy.accountPage.delete.title);
    expect(
      remove.getByText(copy.accountPage.delete.blocked.deleteApps("Ada's bakery"))
    ).toBeInTheDocument();
    expect(
      remove.getByText(copy.accountPage.delete.blocked.handOver("The shop"))
    ).toBeInTheDocument();
    expect(remove.queryByRole("button", { name: copy.accountPage.delete.start })).toBeNull();
  });

  it("deletes the account once its email is typed, then signs out to the sign-in page", async () => {
    const { calls, requests } = open(
      anAccount({
        businesses: [
          { id: 1, name: "Ada's bakery", onDelete: "remove" },
          { id: 2, name: "The shop", onDelete: "leave" },
        ],
      }),
      {
        "account.delete": ({ email }) => {
          if (String(email).toLowerCase() !== EMAIL)
            throw new ApiFailure("BAD_REQUEST", "Not this account");
          return null;
        },
      }
    );
    const remove = await section(copy.accountPage.delete.title);
    expect(remove.getByText(copy.accountPage.delete.outcome.remove("Ada's bakery"))).toBeVisible();
    expect(remove.getByText(copy.accountPage.delete.outcome.leave("The shop"))).toBeVisible();
    await userEvent.click(remove.getByRole("button", { name: copy.accountPage.delete.start }));

    const field = remove.getByLabelText(copy.accountPage.delete.confirmLabel(EMAIL));
    await userEvent.type(field, "ada@example.org");
    await userEvent.click(remove.getByRole("button", { name: copy.accountPage.delete.confirm }));
    expect(await remove.findByText(copy.accountPage.delete.mismatch)).toBeInTheDocument();
    expect(field).toBeInvalid();
    expect(calls.some((call) => call.path === "account.delete")).toBe(false);

    await userEvent.clear(field);
    await userEvent.type(field, EMAIL.toUpperCase());
    await userEvent.click(remove.getByRole("button", { name: copy.accountPage.delete.confirm }));
    await waitFor(() => expect(leaveTo).toHaveBeenCalledWith("/sign-in?deleted"));
    expect(requests.some((request) => request.path === "/sign-out")).toBe(true);
    expect(calls.find((call) => call.path === "account.delete")?.input).toEqual({
      email: EMAIL.toUpperCase(),
    });
  });

  it("returns focus to the delete button when the person keeps their account", async () => {
    open(anAccount());
    const remove = await section(copy.accountPage.delete.title);
    await userEvent.click(remove.getByRole("button", { name: copy.accountPage.delete.start }));
    expect(remove.getByLabelText(copy.accountPage.delete.confirmLabel(EMAIL))).toHaveFocus();
    await userEvent.click(remove.getByRole("button", { name: copy.accountPage.delete.cancel }));
    expect(remove.getByRole("button", { name: copy.accountPage.delete.start })).toHaveFocus();
  });

  it("says on the sign-in page that the account is deleted", async () => {
    window.history.replaceState(null, "", "/sign-in?deleted");
    const { handlers } = authServer({ session: { person: null, businesses: [] } });
    renderWithApi(<App isPublicSite={false} />, handlers, "server");
    expect(await screen.findByText(copy.signInPage.deleted)).toBeInTheDocument();
  });
});
