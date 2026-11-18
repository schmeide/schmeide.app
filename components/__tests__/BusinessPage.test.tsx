import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { copy } from "../../data/copy";
import type { BusinessDetails } from "../../trpc";
import { BusinessPage } from "../BusinessPage";
import {
  aBusiness,
  aMember,
  anInvitation,
  ApiFailure,
  renderWithApi,
  type Handlers,
} from "./fakeApi";

const details = copy.businessPage.details;
const members = copy.businessPage.members;
const invitations = copy.businessPage.invitations;

const eddie = aMember({
  userId: "user-eddie",
  name: "Eddie Editor",
  email: "eddie@example.com",
  role: "editor",
  isYou: false,
});
const olive = aMember();

const open = (business: BusinessDetails, handlers: Handlers = {}) =>
  renderWithApi(<BusinessPage />, { "business.get": () => business, ...handlers });
const button = (name: string) => screen.getByRole("button", { name });
const noButton = (name: string) => expect(screen.queryByRole("button", { name })).toBeNull();
const press = (name: string) => userEvent.click(button(name));
const sent = (calls: ReturnType<typeof open>, path: string) =>
  calls.filter((call) => call.path === path).map((call) => call.input);
const rowOf = (text: string) => {
  const row = screen.getByText(text).closest("li");
  if (!row) throw new Error(`no row for ${text}`);
  return within(row);
};

describe("the business page, for an owner", () => {
  it("shows the name, the country, the only member, and that nobody is invited", async () => {
    open(aBusiness());
    expect(await screen.findByLabelText(details.nameLabel)).toHaveValue("Demo business");
    expect(screen.getByLabelText(details.countryLabel)).toHaveDisplayValue(details.countryNone);
    expect(screen.getByRole("heading", { name: members.title(1) })).toBeInTheDocument();
    expect(rowOf("olive@example.com").getByText(/^Owner ·/)).toBeInTheDocument();
    expect(screen.getByText(members.alone)).toBeInTheDocument();
    expect(screen.getByText(invitations.none)).toBeInTheDocument();
    expect(screen.getByText(invitations.intro)).toHaveTextContent("does not send email yet");
  });

  it("saves a new name and country", async () => {
    const calls = open(aBusiness(), { "business.update": () => ({}) });
    const name = await screen.findByLabelText(details.nameLabel);
    await userEvent.clear(name);
    await userEvent.type(name, "Olive & Sons");
    await userEvent.selectOptions(screen.getByLabelText(details.countryLabel), "Germany");
    await press(details.save);
    expect(await screen.findByText(details.saved)).toBeInTheDocument();
    expect(sent(calls, "business.update")).toEqual([{ name: "Olive & Sons", country: "DE" }]);
  });

  it("does not save an empty name, and says so on the field", async () => {
    const calls = open(aBusiness({ country: "DE" }));
    const name = await screen.findByLabelText(details.nameLabel);
    expect(screen.getByLabelText(details.countryLabel)).toHaveDisplayValue("Germany");
    await userEvent.clear(name);
    expect(button(details.save)).toBeEnabled();
    await press(details.save);
    expect(name).toBeInvalid();
    expect(name).toHaveAccessibleDescription(details.nameMissing);
    expect(name).toHaveFocus();
    expect(sent(calls, "business.update")).toEqual([]);
  });
});

describe("the business page, for an editor", () => {
  const asEditor = aBusiness({
    role: "editor",
    country: "DE",
    members: [aMember({ isYou: false }), { ...eddie, isYou: true }],
  });

  it("is read-only: no fields, no invitations, and nothing to do to other members", async () => {
    open(asEditor);
    expect(await screen.findByText(copy.businessPage.readOnly)).toBeInTheDocument();
    expect(screen.getByText("Demo business")).toBeInTheDocument();
    expect(screen.getByText("Germany")).toBeInTheDocument();
    expect(screen.queryByLabelText(details.nameLabel)).toBeNull();
    expect(screen.queryByRole("heading", { name: invitations.title })).toBeNull();
    expect(rowOf("olive@example.com").queryByRole("button")).toBeNull();
    expect(rowOf("eddie@example.com").getByText(/^Editor ·/)).toBeInTheDocument();
  });

  it("can leave, after being told what that means", async () => {
    const calls = open(asEditor, { "business.leave": () => ({}) });
    await screen.findByText(copy.businessPage.readOnly);
    await press(members.leave("Demo business"));
    expect(screen.getByText(members.leaveConfirm("Demo business"))).toBeInTheDocument();
    expect(button(members.stay)).toHaveFocus();
    await press(members.leave("Demo business"));
    await waitFor(() => expect(sent(calls, "business.leave")).toHaveLength(1));
  });
});

describe("the members of a business", () => {
  const withEditor = aBusiness({ members: [olive, eddie] });

  it("do not let the only owner leave, and say why", async () => {
    open(withEditor);
    expect(await screen.findByText(members.onlyOwner)).toBeInTheDocument();
    expect(rowOf("olive@example.com").queryByRole("button")).toBeNull();
    noButton(members.leave("Demo business"));
  });

  it("let a second owner leave or be made an editor", async () => {
    const calls = open(aBusiness({ members: [olive, { ...eddie, role: "owner" }] }), {
      "business.setRole": () => ({}),
    });
    expect(
      await screen.findByRole("button", { name: members.leave("Demo business") })
    ).toBeEnabled();
    expect(screen.queryByText(members.onlyOwner)).toBeNull();
    await press(members.makeEditor("Eddie Editor"));
    await waitFor(() =>
      expect(sent(calls, "business.setRole")).toEqual([{ userId: "user-eddie", role: "editor" }])
    );
  });

  it("are removed only after the owner confirms, by a button that names the person", async () => {
    const calls = open(withEditor, { "business.removeMember": () => ({}) });
    await userEvent.click(
      await screen.findByRole("button", { name: members.remove("Eddie Editor") })
    );
    expect(
      screen.getByText(members.removeConfirm("Eddie Editor", "Demo business"))
    ).toBeInTheDocument();
    expect(sent(calls, "business.removeMember")).toEqual([]);
    await press(members.keep("Eddie Editor"));
    expect(sent(calls, "business.removeMember")).toEqual([]);

    await press(members.remove("Eddie Editor"));
    await press(members.remove("Eddie Editor"));
    await waitFor(() =>
      expect(sent(calls, "business.removeMember")).toEqual([{ userId: "user-eddie" }])
    );
  });

  it("can be made an owner beside the current one, or handed the business", async () => {
    const calls = open(withEditor, {
      "business.setRole": () => ({}),
      "business.transferOwnership": () => ({}),
    });
    await userEvent.click(
      await screen.findByRole("button", { name: members.makeOwner("Eddie Editor") })
    );
    expect(screen.getByText(members.makeOwnerConfirm("Eddie Editor"))).toBeInTheDocument();
    await press(members.makeOwnerToo("Eddie Editor"));
    await waitFor(() =>
      expect(sent(calls, "business.setRole")).toEqual([{ userId: "user-eddie", role: "owner" }])
    );

    await press(members.makeOwner("Eddie Editor"));
    await press(members.handOver("Eddie Editor"));
    await waitFor(() =>
      expect(sent(calls, "business.transferOwnership")).toEqual([{ userId: "user-eddie" }])
    );
  });

  it("say what the server refused, and how to go on", async () => {
    open(withEditor, {
      "business.removeMember": () => {
        throw new ApiFailure("NOT_FOUND");
      },
    });
    await userEvent.click(
      await screen.findByRole("button", { name: members.remove("Eddie Editor") })
    );
    await press(members.remove("Eddie Editor"));
    expect(await screen.findByRole("alert")).toHaveTextContent(copy.businessPage.gone);
  });
});

describe("invitations", () => {
  const type = (text: string) =>
    userEvent.type(screen.getByLabelText(invitations.emailLabel), text);

  it("ask for an email address on the field before anything is sent", async () => {
    const calls = open(aBusiness());
    const email = await screen.findByLabelText(invitations.emailLabel);
    expect(button(invitations.add)).toBeEnabled();
    await press(invitations.add);
    expect(email).toBeInvalid();
    expect(email).toHaveAccessibleDescription(invitations.emailMissing);
    expect(email).toHaveFocus();
    await type("not an address");
    await press(invitations.add);
    expect(email).toBeInvalid();
    expect(sent(calls, "business.invite")).toEqual([]);
  });

  it("make a link the owner copies and sends, shown once", async () => {
    const state = { business: aBusiness() };
    const calls = renderWithApi(<BusinessPage />, {
      "business.get": () => state.business,
      "business.invite": () => {
        state.business = aBusiness({ invitations: [anInvitation()] });
        return { email: "nia@example.com", token: "tok/1", expiresAt: new Date() };
      },
    });
    await screen.findByLabelText(invitations.emailLabel);
    await type("nia@example.com");
    await press(invitations.add);

    const link = await screen.findByLabelText(invitations.linkLabel("nia@example.com"));
    expect(link).toHaveValue(`${window.location.origin}/set-password?token=tok%2F1`);
    expect(link).toHaveAttribute("readonly");
    expect(link).toHaveAccessibleDescription(invitations.linkHelp(7));
    expect(sent(calls, "business.invite")).toEqual([{ email: "nia@example.com" }]);
    expect(screen.getByLabelText(invitations.emailLabel)).toHaveValue("");
    expect(await screen.findByRole("heading", { name: invitations.waitingTitle(1) })).toBeVisible();

    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await press(invitations.copyLink);
    expect(await screen.findByText(invitations.copied)).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/set-password?token=tok%2F1`);
  });

  it("wait in a list, where each gets a new link or is withdrawn by name", async () => {
    const calls = open(
      aBusiness({
        invitations: [anInvitation(), anInvitation({ email: "old@example.com", expired: true })],
      }),
      {
        "business.reissueInvitation": () => ({
          email: "old@example.com",
          token: "tok2",
          expiresAt: new Date(),
        }),
        "business.withdrawInvitation": () => ({}),
      }
    );
    expect(await screen.findByRole("heading", { name: invitations.waitingTitle(2) })).toBeVisible();
    expect(rowOf("old@example.com").getByText(invitations.expired)).toBeInTheDocument();
    expect(rowOf("nia@example.com").queryByText(invitations.expired)).toBeNull();

    await press(invitations.renew("old@example.com"));
    expect(await screen.findByLabelText(invitations.linkLabel("old@example.com"))).toHaveValue(
      `${window.location.origin}/set-password?token=tok2`
    );
    await press(invitations.withdraw("old@example.com"));
    await waitFor(() =>
      expect(sent(calls, "business.withdrawInvitation")).toEqual([{ email: "old@example.com" }])
    );
    await waitFor(() =>
      expect(screen.queryByLabelText(invitations.linkLabel("old@example.com"))).toBeNull()
    );
  });

  it("say why an address could not be invited", async () => {
    open(aBusiness(), {
      "business.invite": () => {
        throw new ApiFailure("CONFLICT", "That person is already a member of this business.");
      },
    });
    await screen.findByLabelText(invitations.emailLabel);
    await type("eddie@example.com");
    await press(invitations.add);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That person is already a member of this business."
    );
    expect(screen.getByLabelText(invitations.emailLabel)).toHaveValue("eddie@example.com");
  });
});
