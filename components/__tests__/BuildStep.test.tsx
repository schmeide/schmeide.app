import { fireEvent, screen, waitFor } from "@testing-library/react";
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
