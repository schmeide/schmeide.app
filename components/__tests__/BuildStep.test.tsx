import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { copy } from "../../data/copy";
import { BuildStep } from "../BuildStep";
import { aBuild, anEvent, renderWithApi } from "./fakeApi";

const CLIENT = 100;
const SCROLLED_PAST_POLL = { timeout: 5000 };

// jsdom has no layout, so the log's geometry is faked: `height` is the content height.
const fakeLayout = (log: HTMLElement) => {
  const layout = { height: 400, top: 0 };
  Object.defineProperty(log, "scrollHeight", { get: () => layout.height });
  Object.defineProperty(log, "clientHeight", { get: () => CLIENT });
  Object.defineProperty(log, "scrollTop", {
    get: () => layout.top,
    set: (value: number) => {
      layout.top = value;
    },
  });
  return layout;
};

const setup = async () => {
  const events = [anEvent(1, "step", "First step"), anEvent(2, "step", "Second step")];
  renderWithApi(<BuildStep build={aBuild()} title="Build" />, {
    "builds.events": (input) => events.filter((event) => event.id > Number(input.afterId)),
    "builds.summaries": () => [],
  });
  await userEvent.click(screen.getByRole("button", { name: copy.project.behindTheScenes }));
  await screen.findByText("Second step");
  const log = screen.getByRole("log");
  return { events, log, layout: fakeLayout(log) };
};

describe("BuildStep log", () => {
  it("follows new lines while scrolled to the bottom", async () => {
    const { events, layout } = await setup();
    layout.top = layout.height - CLIENT;
    fireEvent.scroll(screen.getByRole("log"));

    events.push(anEvent(3, "step", "Third step"));
    layout.height = 500;
    await screen.findByText("Third step", undefined, SCROLLED_PAST_POLL);

    expect(layout.top).toBe(500);
    expect(screen.queryByRole("button", { name: copy.project.jumpToNewest })).toBeNull();
  });

  it("leaves a reader who scrolled up in place and offers a way back down", async () => {
    const { events, layout } = await setup();
    layout.top = 0;
    fireEvent.scroll(screen.getByRole("log"));

    events.push(anEvent(3, "step", "Third step"));
    layout.height = 500;
    await screen.findByText("Third step", undefined, SCROLLED_PAST_POLL);

    expect(layout.top).toBe(0);
    const jump = await screen.findByRole("button", { name: copy.project.jumpToNewest });
    expect(screen.getByRole("log")).toContainElement(jump);

    await userEvent.click(jump);

    expect(layout.top).toBe(500);
    await waitFor(() => expect(jump).not.toBeInTheDocument());

    events.push(anEvent(4, "step", "Fourth step"));
    layout.height = 600;
    await screen.findByText("Fourth step", undefined, SCROLLED_PAST_POLL);
    expect(layout.top).toBe(600);
  });
});

// A first build, in the four phases the builder goes through and the time it usually takes (#52).
describe("BuildStep for a first build", () => {
  const PHASES = [
    copy.project.phase.step,
    copy.project.phase.agent,
    copy.project.phase.check,
    copy.project.phase.deploy,
  ];
  const OPEN_APP = `${copy.project.openApp} ${copy.project.opensInNewTab}`;

  const renderBuild = (
    build: Parameters<typeof aBuild>[0],
    events: readonly ReturnType<typeof anEvent>[] = [],
    appUrl: string | null = null
  ) =>
    renderWithApi(<BuildStep build={aBuild(build)} title="Build" appUrl={appUrl} />, {
      "builds.events": (input) => events.filter((event) => event.id > Number(input.afterId)),
      "builds.summaries": () => [],
    });

  const phases = () => screen.getByRole("list", { name: copy.project.phasesLabel });
  const current = () =>
    within(phases())
      .getAllByRole("listitem")
      .filter((item) => item.getAttribute("aria-current") === "step");

  it("lists the four phases in order and marks getting ready before the first step", () => {
    renderBuild({});

    const items = within(phases()).getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual(PHASES);
    expect(current()).toEqual([items[0]]);
  });

  it.each([
    ["step", 0],
    ["agent", 1],
    ["skill", 1],
    ["check", 2],
    ["warning", 2],
    ["deploy", 3],
  ] as const)("marks the phase a %s step belongs to as the current one", async (kind, index) => {
    renderBuild({}, [anEvent(1, "step", "Copying the template"), anEvent(2, kind, "Working")]);

    await waitFor(() => expect(current()[0]).toHaveTextContent(PHASES[index] ?? ""));
    expect(current()).toHaveLength(1);
    // The phases before it are done, for a screen reader as well as the eye.
    expect(within(phases()).queryAllByText(copy.project.setup.done, { exact: false })).toHaveLength(
      index
    );
  });

  it("keeps the phase a problem happened in, and says the builder is working past it", async () => {
    renderBuild({}, [
      anEvent(1, "check", "Running make test"),
      anEvent(2, "error", "A test failed"),
    ]);

    expect(await screen.findByText(copy.project.phase.error)).toBeInTheDocument();
    expect(current()[0]).toHaveTextContent(copy.project.phase.check);
  });

  it("says how long a first build usually takes and when this one started", () => {
    renderBuild({ startedAt: new Date(Date.now() - 3 * 60_000 - 5_000) });

    expect(screen.getByText(copy.project.firstBuildTime("3 minutes ago"))).toBeInTheDocument();
    expect(screen.getByText(copy.project.canLeave)).toBeInTheDocument();
  });

  it("says a build that just started started less than a minute ago", () => {
    renderBuild({});

    expect(screen.getByText(copy.project.firstBuildTime(null))).toBeInTheDocument();
  });

  it("offers one way on once it finished: opening the app", () => {
    renderBuild(
      { status: "passed", finishedAt: new Date() },
      [anEvent(1, "deploy", "Published")],
      "https://app.example"
    );

    expect(screen.getByText(copy.project.buildStatus.passed)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: OPEN_APP })).toHaveAttribute(
      "href",
      "https://app.example"
    );
    expect(screen.queryByRole("list", { name: copy.project.phasesLabel })).toBeNull();
    expect(screen.queryByText(copy.project.canLeave)).toBeNull();
  });

  it("says what went wrong when it failed, without the phases or a way to open the app", () => {
    renderBuild(
      { status: "failed", error: "make test failed", finishedAt: new Date() },
      [],
      "https://app.example"
    );

    expect(screen.getByText(copy.project.buildStatus.failed)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: copy.project.failureTitle })).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: copy.project.phasesLabel })).toBeNull();
    expect(screen.queryByRole("link", { name: OPEN_APP })).toBeNull();
  });

  it("shows a canceled build as canceled, not failed", () => {
    renderBuild({ status: "canceled", finishedAt: new Date() });

    expect(screen.getByText(copy.project.buildStatus.canceled)).toBeInTheDocument();
    expect(screen.queryByText(copy.project.buildStatus.failed)).toBeNull();
    expect(screen.queryByRole("heading", { name: copy.project.failureTitle })).toBeNull();
    expect(screen.queryByRole("list", { name: copy.project.phasesLabel })).toBeNull();
  });

  it("leaves a change build as it was: its time so far, and no phases", () => {
    renderBuild({ kind: "change", request: "Add a due date" });

    expect(screen.getByText(copy.project.elapsed, { exact: false })).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: copy.project.phasesLabel })).toBeNull();
    expect(screen.queryByText(copy.project.canLeave)).toBeNull();
  });
});
