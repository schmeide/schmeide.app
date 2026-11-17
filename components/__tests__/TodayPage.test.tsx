import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { copy } from "../../data/copy";
import { TodayPage } from "../TodayPage";
import { aProject, aQuestion, anInterview, renderWithApi, type Handlers } from "./fakeApi";

const { today } = copy;

const server = (overrides: Handlers = {}): Handlers => ({
  "projects.list": () => [],
  "projects.create": () => aProject({ id: 12 }),
  "interview.start": () => anInterview({ current: aQuestion() }),
  ...overrides,
});

const uses = () => screen.getByRole("group", { name: today.usesLegend });
const tick = (label: string) =>
  userEvent.click(within(uses()).getByRole("checkbox", { name: label }));
const fix = () => screen.getByRole("textbox", { name: today.fixLabel });
const keep = () => screen.getByRole("textbox", { name: today.keepLabel });
const submit = () => userEvent.click(screen.getByRole("button", { name: copy.start.continue }));

describe("TodayPage", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/new/existing");
  });

  it("is the second way in, and asks what the person uses today", () => {
    renderWithApi(<TodayPage />, server());

    expect(screen.getByRole("heading", { level: 1, name: today.title })).toBeVisible();
    const ways = screen.getByRole("navigation", { name: copy.start.ways.label });
    expect(within(ways).getByRole("link", { name: copy.start.ways.existing })).toHaveAttribute(
      "aria-current",
      "page"
    );
    expect(within(uses()).getAllByRole("checkbox")).toHaveLength(5);
  });

  it("starts the app from the answers, named after the first thing it replaces", async () => {
    const calls = renderWithApi(<TodayPage />, server());

    await tick(today.uses.spreadsheet.label);
    await tick(today.uses.paper.label);
    await userEvent.type(keep(), "The monthly totals");
    await userEvent.type(fix(), "I can never see who has paid");
    await submit();

    await waitFor(() => expect(window.location.pathname).toBe("/projects/12"));
    expect(calls).toContainEqual({
      path: "projects.create",
      input: {
        name: today.uses.spreadsheet.appName,
        today: {
          uses: [today.uses.spreadsheet.label, today.uses.paper.label],
          keep: "The monthly totals",
          fix: "I can never see who has paid",
        },
      },
    });
    expect(calls).toContainEqual({ path: "interview.start", input: { id: 12 } });
  });

  it("leaves what must stay to Schmeide with “You decide”", async () => {
    const calls = renderWithApi(<TodayPage />, server());

    await tick(today.uses.product.label);
    await userEvent.click(screen.getByRole("checkbox", { name: today.keepDecide }));
    expect(keep()).toBeDisabled();
    await userEvent.type(fix(), "It costs too much");
    await submit();

    await waitFor(() =>
      expect(calls).toContainEqual({
        path: "projects.create",
        input: {
          name: today.uses.product.appName,
          today: {
            uses: [today.uses.product.label],
            keepDecided: true,
            fix: "It costs too much",
          },
        },
      })
    );
  });

  it("says what each kind of thing means for the app, only once it is chosen", async () => {
    renderWithApi(<TodayPage />, server());

    expect(screen.queryByText(today.uses.product.note)).toBeNull();
    await tick(today.uses.product.label);
    await tick(today.uses.software.label);
    await tick(today.uses.website.label);

    expect(screen.getByText(today.uses.product.note)).toBeVisible();
    expect(screen.getByText(today.uses.software.note)).toBeVisible();
    expect(screen.getByText(today.uses.website.note)).toBeVisible();
  });

  it("names both missing answers beside their fields, and creates nothing", async () => {
    const calls = renderWithApi(<TodayPage />, server());

    await submit();

    expect(uses()).toHaveAccessibleDescription(expect.stringContaining(today.usesMissing));
    expect(fix()).toHaveAccessibleDescription(today.fixMissing);
    expect(fix()).toBeInvalid();
    expect(within(uses()).getAllByRole("checkbox")[0]).toHaveFocus();
    expect(calls.map((call) => call.path)).not.toContain("projects.create");
  });

  it("points someone changing an app they built here to their apps", async () => {
    renderWithApi(
      <TodayPage />,
      server({ "projects.list": () => [aProject({ id: 2, status: "live" })] })
    );

    expect(await screen.findByRole("link", { name: today.builtHereLink })).toHaveAttribute(
      "href",
      "/"
    );
  });
});
