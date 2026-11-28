import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { copy } from "../../data/copy";
import { Working } from "../Working";

// jsdom has no matchMedia; each case says whether the person asked for reduced motion.
const prefersReducedMotion = (reduce: boolean) =>
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({
        matches: reduce && query === "(prefers-reduced-motion: reduce)",
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList
  );

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Working", () => {
  it("shows a spinner beside the wait, hidden from assistive technology", () => {
    render(
      <p role="status">
        <Working>{copy.interview.thinking}</Working>
      </p>
    );
    expect(screen.getByRole("status")).toHaveTextContent(copy.interview.thinking);
    expect(screen.getByTestId("working")).toHaveAttribute("aria-hidden", "true");
  });

  it("moves without a reduced-motion preference", () => {
    prefersReducedMotion(false);
    render(<Working>{copy.interview.thinking}</Working>);
    expect(screen.getByTestId("working").firstElementChild).not.toHaveStyle({
      "--ld-play-state": "paused",
    });
  });

  it("holds still under reduced motion, and keeps the text", () => {
    prefersReducedMotion(true);
    render(
      <p role="status">
        <Working>{copy.interview.thinking}</Working>
      </p>
    );
    expect(screen.getByTestId("working").firstElementChild).toHaveStyle({
      "--ld-play-state": "paused",
    });
    expect(screen.getByRole("status")).toHaveTextContent(copy.interview.thinking);
  });
});
