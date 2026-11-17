import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { copy } from "../../data/copy";
import { StartPage } from "../StartPage";
import {
  ApiFailure,
  aProject,
  aQuestion,
  anInterview,
  renderWithApi,
  type Handlers,
} from "./fakeApi";

const server = (overrides: Handlers = {}): Handlers => ({
  "projects.list": () => [],
  "projects.create": (input) => aProject({ id: 12, need: String(input.need) }),
  "interview.start": () => anInterview({ current: aQuestion() }),
  ...overrides,
});

const field = () => screen.getByRole("textbox", { name: copy.start.title });
const submit = () => userEvent.click(screen.getByRole("button", { name: copy.start.continue }));

describe("StartPage", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/new");
  });

  it("asks one question, and says what Schmeide builds with a way to ask for more", () => {
    renderWithApi(<StartPage />, server());

    expect(screen.getByRole("heading", { level: 1, name: copy.start.title })).toBeVisible();
    expect(field()).toHaveAttribute("placeholder", copy.start.needPlaceholder);
    expect(screen.getByText(copy.start.builds)).toBeVisible();
    expect(screen.getByRole("link", { name: copy.start.askForIt })).toHaveAttribute(
      "href",
      "/help"
    );
  });

  it("starts the app from the answer, asks the first question, and opens it", async () => {
    const calls = renderWithApi(<StartPage />, server());

    await userEvent.type(field(), "  I need to track jobs  ");
    await submit();

    await waitFor(() => expect(window.location.pathname).toBe("/projects/12"));
    expect(calls).toContainEqual({
      path: "projects.create",
      input: { need: "I need to track jobs" },
    });
    expect(calls).toContainEqual({ path: "interview.start", input: { id: 12 } });
  });

  it("opens the app even when the first question could not be prepared", async () => {
    renderWithApi(
      <StartPage />,
      server({
        "interview.start": () => {
          throw new ApiFailure("SERVICE_UNAVAILABLE");
        },
      })
    );

    await userEvent.type(field(), "I need to track jobs");
    await submit();

    await waitFor(() => expect(window.location.pathname).toBe("/projects/12"));
  });

  it("says what is missing beside the field when nothing was written, and creates nothing", async () => {
    const calls = renderWithApi(<StartPage />, server());

    await submit();

    expect(field()).toHaveAccessibleDescription(copy.start.needMissing);
    expect(field()).toBeInvalid();
    expect(field()).toHaveFocus();
    expect(calls.map((call) => call.path)).not.toContain("projects.create");
  });

  it("writes a first answer from a starting point and names the app after it", async () => {
    const calls = renderWithApi(<StartPage />, server());
    const [invoices] = copy.start.points;

    await userEvent.click(screen.getByRole("button", { name: invoices.name }));
    expect(field()).toHaveValue(invoices.need);
    await submit();

    await waitFor(() =>
      expect(calls).toContainEqual({
        path: "projects.create",
        input: { need: invoices.need, name: invoices.name },
      })
    );
  });

  it("leaves the name to the server once the starting point's answer was changed", async () => {
    const calls = renderWithApi(<StartPage />, server());
    const [invoices] = copy.start.points;

    await userEvent.click(screen.getByRole("button", { name: invoices.name }));
    await userEvent.type(field(), " And quotes.");
    await submit();

    await waitFor(() =>
      expect(calls).toContainEqual({
        path: "projects.create",
        input: { need: `${invoices.need} And quotes.` },
      })
    );
  });

  it("offers both ways in, marking the one shown", () => {
    renderWithApi(<StartPage />, server());

    const ways = screen.getByRole("navigation", { name: copy.start.ways.label });
    expect(
      within(ways)
        .getAllByRole("link")
        .map((link) => [
          link.textContent,
          link.getAttribute("href"),
          link.getAttribute("aria-current"),
        ])
    ).toEqual([
      [copy.start.ways.idea, "/new", "page"],
      [copy.start.ways.existing, "/new/existing", null],
    ]);
  });

  it("offers the apps that are not built yet, and not the ones that are", async () => {
    renderWithApi(
      <StartPage />,
      server({
        "projects.list": () => [
          aProject({ id: 3, name: "Bookings", status: "spec_ready" }),
          aProject({ id: 2, name: "Invoices", status: "live" }),
          aProject({ id: 1, name: "Stock", status: "draft" }),
        ],
      })
    );

    const unfinished = await screen.findByRole("region", { name: copy.start.unfinishedTitle });
    expect(
      within(unfinished)
        .getAllByRole("link")
        .map((link) => [link.textContent, link.getAttribute("href")])
    ).toEqual([
      ["Bookings", "/projects/3"],
      ["Stock", "/projects/1"],
    ]);
  });

  it("shows why the app could not be started and keeps what was written", async () => {
    renderWithApi(
      <StartPage />,
      server({
        "projects.create": () => {
          throw new ApiFailure(undefined);
        },
      })
    );

    await userEvent.type(field(), "I need to track jobs");
    await submit();

    expect(await screen.findByRole("alert")).toHaveTextContent(copy.errors.serverDown);
    expect(field()).toHaveValue("I need to track jobs");
    expect(window.location.pathname).toBe("/new");
  });
});
