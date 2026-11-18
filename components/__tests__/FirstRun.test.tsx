import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { copy } from "../../data/copy";
import type { Session } from "../../utils/session";
import { serverDownText } from "../ErrorNote";
import { FirstRun } from "../FirstRun";
import { ApiFailure, renderWithApi, type Call, type Handlers } from "./fakeApi";

const newcomer: Session = {
  person: { name: "Ada Lovelace", email: "ada@example.com" },
  businesses: [],
};
const made = () => ({ id: 9, name: "Ada’s bakery", suspended: false });

const open = (handlers: Handlers = { "setup.createBusiness": made }, search = "") => {
  window.history.replaceState(null, "", `/welcome${search}`);
  return renderWithApi(<FirstRun />, handlers, newcomer);
};
const field = (label: string) => screen.getByLabelText(label);
const submit = () => userEvent.click(screen.getByRole("button", { name: copy.firstRun.save }));
const creates = (calls: readonly Call[]) =>
  calls.filter((call) => call.path === "setup.createBusiness");

describe("first-run setup", () => {
  it("asks for the business in labelled fields, with the person's name filled in", () => {
    open();
    expect(screen.getByRole("heading", { level: 1, name: copy.routes.welcome })).toBeVisible();
    expect(field(copy.firstRun.yourNameLabel)).toHaveValue("Ada Lovelace");
    expect(field(copy.firstRun.nameLabel)).toHaveValue("");
    expect(field(copy.firstRun.nameLabel)).toHaveAttribute(
      "placeholder",
      copy.firstRun.defaultName("Ada Lovelace")
    );
    expect(field(copy.firstRun.countryLabel)).toHaveValue("");
    expect(field(copy.firstRun.countryLabel)).toHaveAccessibleDescription(
      copy.firstRun.countryHint
    );
    expect(field(copy.firstRun.descriptionLabel)).toHaveAttribute("maxLength", "200");
    expect(field(copy.firstRun.descriptionLabel)).toHaveAccessibleDescription(
      copy.firstRun.descriptionHint
    );
  });

  it("says business, never tenant or workspace", () => {
    open();
    expect(document.body.textContent).not.toMatch(/tenant|workspace/i);
  });

  it("asks for a name and a country on their fields, and sends nothing without them", async () => {
    const calls = open();
    await userEvent.clear(field(copy.firstRun.yourNameLabel));
    await submit();

    const yourName = field(copy.firstRun.yourNameLabel);
    expect(yourName).toBeInvalid();
    expect(yourName).toHaveAccessibleDescription(copy.firstRun.yourNameMissing);
    expect(yourName).toHaveFocus();
    const country = field(copy.firstRun.countryLabel);
    expect(country).toBeInvalid();
    expect(country).toHaveAccessibleDescription(
      `${copy.firstRun.countryHint} ${copy.firstRun.countryMissing}`
    );
    expect(creates(calls)).toEqual([]);
  });

  it("shows it is setting up while the server works", async () => {
    open({ "setup.createBusiness": () => new Promise(() => undefined) });
    await userEvent.selectOptions(field(copy.firstRun.countryLabel), "GB");
    await submit();
    expect(await screen.findByRole("button", { name: copy.firstRun.saving })).toBeDisabled();
  });

  it("says what failed when it could not save, and lets the person try again", async () => {
    let fail = true;
    const calls = open({
      "setup.createBusiness": () => {
        if (fail) throw new ApiFailure(undefined);
        return made();
      },
    });
    await userEvent.selectOptions(field(copy.firstRun.countryLabel), "GB");
    await submit();
    expect(await screen.findByRole("alert")).toHaveTextContent(serverDownText);

    fail = false;
    await submit();
    await waitFor(() => expect(window.location.pathname).toBe("/new"));
    expect(creates(calls)).toHaveLength(2);
  });

  it("sets up the business with the trimmed values and goes on to start an app", async () => {
    const calls = open();
    await userEvent.clear(field(copy.firstRun.yourNameLabel));
    await userEvent.type(field(copy.firstRun.yourNameLabel), "  Ada King ");
    await userEvent.type(field(copy.firstRun.nameLabel), " Ada’s bakery ");
    await userEvent.selectOptions(field(copy.firstRun.countryLabel), "GB");
    await userEvent.type(field(copy.firstRun.descriptionLabel), " Bread and cakes ");
    await submit();

    await waitFor(() => expect(window.location.pathname).toBe("/new"));
    expect(creates(calls).map((call) => call.input)).toEqual([
      {
        yourName: "Ada King",
        name: "Ada’s bakery",
        country: "GB",
        description: "Bread and cakes",
      },
    ]);
  });

  it("goes back to the page the person was headed for", async () => {
    open(undefined, "?next=%2Fprojects%2F7");
    await userEvent.selectOptions(field(copy.firstRun.countryLabel), "GB");
    await submit();
    await waitFor(() => expect(window.location.pathname).toBe("/projects/7"));
  });
});
