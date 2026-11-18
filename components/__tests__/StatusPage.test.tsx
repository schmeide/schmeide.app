import { act, cleanup, screen, waitFor } from "@testing-library/react";
import { focusManager } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";

import { App } from "../../App";
import { copy } from "../../data/copy";
import { signedOut, type Session } from "../../utils/session";
import { ProjectPage } from "../ProjectPage";
import { Routes } from "../Routes";
import { Studio } from "../Studio";
import {
  anInterview,
  ApiFailure,
  aProject,
  aQuestion,
  demoOwner,
  projectServer,
  renderWithApi,
} from "./fakeApi";

const unreachable = {
  "session.get": () => {
    throw new ApiFailure(undefined);
  },
};

// The session is asked again when the window regains focus, as it is in the browser.
const refocus = () =>
  act(() => {
    focusManager.setFocused(false);
    focusManager.setFocused(true);
  });

const setOnline = (online: boolean) =>
  act(() => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(online);
    window.dispatchEvent(new Event(online ? "online" : "offline"));
  });

beforeEach(() => {
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("the not found and no access pages", () => {
  const pageFor = async (code: string) => {
    renderWithApi(<ProjectPage id={7} />, {
      "projects.get": () => {
        throw new ApiFailure(code);
      },
    });
    await screen.findByRole("heading", { level: 1, name: copy.problems.title });
    const text = document.body.textContent;
    cleanup();
    return text;
  };

  it("look the same, so a non-member cannot tell that an app exists", async () => {
    const missing = await pageFor("NOT_FOUND");
    expect(await pageFor("FORBIDDEN")).toBe(missing);
    expect(missing).toContain(copy.problems.signedInAs("owner@demo.example"));
  });

  it("is what an address that matches nothing shows, with the way to the person's apps", async () => {
    window.history.replaceState(null, "", "/no/such/page");
    renderWithApi(<Routes />, { "projects.list": () => [] });
    expect(
      screen.getByRole("heading", { level: 1, name: copy.problems.title })
    ).toBeInTheDocument();
    expect(document.title).toBe(copy.pageTitle(copy.problems.title));
    expect(screen.getByRole("link", { name: copy.problems.action })).toHaveAttribute("href", "/");
  });
});

describe("the signed out page", () => {
  it("offers to sign in back to the same page, and keeps a change that was not sent", async () => {
    window.history.replaceState(null, "", "/projects/7/changes");
    const who: { session: Session } = { session: demoOwner };
    renderWithApi(
      <App isPublicSite={false} />,
      {
        ...projectServer({ project: aProject({ status: "live" }), hasBeenLive: true }),
        "session.get": () => ({ ...who.session, providers: [] }),
      },
      "server"
    );
    await userEvent.type(await screen.findByLabelText(copy.project.changeLabel), "Add a due date");

    who.session = signedOut;
    await refocus();
    expect(
      await screen.findByRole("heading", { level: 1, name: copy.signedOutPage.title })
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: copy.signedOutPage.action })).toHaveAttribute(
      "href",
      "/sign-in?next=%2Fprojects%2F7%2Fchanges"
    );
    expect(window.location.pathname).toBe("/projects/7/changes");

    who.session = demoOwner;
    await refocus();
    expect(await screen.findByLabelText(copy.project.changeLabel)).toHaveValue("Add a due date");
  });

  it("is not shown to a visitor who was never signed in", async () => {
    window.history.replaceState(null, "", "/usage");
    renderWithApi(
      <App isPublicSite={false} />,
      { "session.get": () => ({ ...signedOut, providers: [] }) },
      "server"
    );
    expect(
      await screen.findByRole("heading", { level: 1, name: copy.routes.signIn })
    ).toBeInTheDocument();
  });

  it("does not keep one person's unsent text for another", async () => {
    const project = projectServer({ project: aProject({ status: "live" }), hasBeenLive: true });
    renderWithApi(<ProjectPage id={7} view="changes" />, project);
    await userEvent.type(await screen.findByLabelText(copy.project.changeLabel), "Mine");
    cleanup();
    renderWithApi(<ProjectPage id={7} view="changes" />, project, {
      ...demoOwner,
      person: { name: "Someone else", email: "else@demo.example" },
    });
    expect(await screen.findByLabelText(copy.project.changeLabel)).toHaveValue("");
  });

  it("keeps an interview answer that was not sent", async () => {
    const question = aQuestion({ kind: "text", choices: [] });
    const server = projectServer({
      project: aProject(),
      interview: anInterview({ current: question }),
    });
    renderWithApi(<ProjectPage id={7} />, server);
    await userEvent.type(await screen.findByLabelText(copy.interview.answerLabel), "Two people");
    cleanup();
    renderWithApi(<ProjectPage id={7} />, server);
    expect(await screen.findByLabelText(copy.interview.answerLabel)).toHaveValue("Two people");
  });

  it("keeps an answer in the person's own words to a question with choices", async () => {
    const server = projectServer({
      project: aProject(),
      interview: anInterview({ current: aQuestion() }),
    });
    renderWithApi(<ProjectPage id={7} />, server);
    await userEvent.click(await screen.findByRole("radio", { name: copy.interview.other }));
    await userEvent.type(screen.getByLabelText(copy.interview.otherLabel), "Three of us");
    cleanup();
    renderWithApi(<ProjectPage id={7} />, server);
    expect(await screen.findByLabelText(copy.interview.otherLabel)).toHaveValue("Three of us");
  });
});

describe("the offline page", () => {
  it("replaces the page inside the shell while the browser has no connection, then gives it back", async () => {
    window.history.replaceState(null, "", "/projects/7/changes");
    renderWithApi(
      <Routes />,
      projectServer({ project: aProject({ status: "live" }), hasBeenLive: true })
    );
    await userEvent.type(await screen.findByLabelText(copy.project.changeLabel), "Add a due date");

    await setOnline(false);
    expect(screen.getByRole("heading", { level: 1, name: copy.offline.title })).toHaveFocus();
    expect(document.title).toBe(copy.pageTitle(copy.offline.title));
    expect(screen.getByText(copy.offline.retrying)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: copy.shell.logo })).toBeInTheDocument();

    await setOnline(true);
    expect(await screen.findByLabelText(copy.project.changeLabel)).toHaveValue("Add a due date");
  });

  it("tries to reach the server again by itself, and says so", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const calls = renderWithApi(
      <Studio isPublicSite={false} fallback={null} maintenanceUntil={null} />,
      unreachable,
      "server"
    );
    expect(await screen.findByText(copy.offline.retrying)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: copy.errors.retry })).toBeInTheDocument();
    const asked = calls.length;
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    await waitFor(() => expect(calls.length).toBeGreaterThan(asked));
  });
});

describe("the maintenance page", () => {
  it("says when to come back", () => {
    const until = new Date("2099-01-02T15:00:00Z");
    renderWithApi(
      <Studio isPublicSite fallback={null} maintenanceUntil={until} />,
      unreachable,
      "server"
    );
    expect(
      screen.getByRole("heading", { level: 1, name: copy.maintenance.title })
    ).toBeInTheDocument();
    const when = new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(until);
    expect(screen.getByText(copy.maintenance.body(when))).toBeInTheDocument();
  });

  it("is not shown once the planned work is over", async () => {
    renderWithApi(
      <Studio isPublicSite fallback={<p>hero</p>} maintenanceUntil={new Date("2000-01-01")} />,
      unreachable,
      "server"
    );
    expect(await screen.findByText("hero")).toBeInTheDocument();
  });
});
