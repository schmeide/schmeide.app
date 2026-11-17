import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { copy } from "../../data/copy";
import { AppFrame } from "../AppFrame";

const URL = "http://localhost:8100";
const text = copy.project.designer;
const frame = () => screen.getByTitle(text.frameTitle("Invoices"));
const toggle = () => screen.getByRole("checkbox", { name: text.reloadOnBuild });
const notice = () => screen.queryByText(text.newVersion);

const frameAt = (version: number | null) => (
  <AppFrame name="Invoices" url={URL} version={version} />
);

describe("AppFrame", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows the newest version on first render without a notice, reloading off by default", () => {
    render(frameAt(8));
    expect(toggle()).not.toBeChecked();
    expect(notice()).toBeNull();
    expect(frame()).toHaveAttribute("src", URL);
  });

  it("with reloading off, says a new version is ready instead of reloading, until it is reloaded", async () => {
    const { rerender } = render(frameAt(8));
    const before = frame();

    rerender(frameAt(9));
    expect(frame()).toBe(before);
    expect(screen.getByRole("status")).toHaveTextContent(text.newVersion);

    await userEvent.click(screen.getByRole("button", { name: text.reloadNew }));
    expect(frame()).not.toBe(before);
    expect(notice()).toBeNull();
  });

  it("with reloading off, the app's own reload button also shows the new version", async () => {
    const { rerender } = render(frameAt(null));
    rerender(frameAt(9));
    expect(notice()).not.toBeNull();

    await userEvent.click(screen.getByRole("button", { name: text.reload }));
    expect(notice()).toBeNull();
  });

  it("with reloading on, reloads when a change is built and shows no notice", async () => {
    const { rerender } = render(frameAt(8));
    await userEvent.click(toggle());
    const before = frame();

    rerender(frameAt(9));
    expect(frame()).not.toBe(before);
    expect(notice()).toBeNull();
  });

  it("changes nothing when a build fails", () => {
    const { rerender } = render(frameAt(8));
    const before = frame();
    // Designer passes null when the latest build did not pass.
    rerender(frameAt(null));
    expect(frame()).toBe(before);
    expect(notice()).toBeNull();
  });

  it("remembers the reload choice and the width across a page reload", async () => {
    const { unmount } = render(frameAt(8));
    await userEvent.click(toggle());
    await userEvent.click(screen.getByRole("radio", { name: text.width.phone }));
    unmount();

    render(frameAt(8));
    expect(toggle()).toBeChecked();
    expect(screen.getByRole("radio", { name: text.width.phone })).toBeChecked();
  });

  it("keeps the defaults and works when the browser's store throws", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    render(frameAt(8));
    expect(toggle()).not.toBeChecked();
    expect(screen.getByRole("radio", { name: text.width.computer })).toBeChecked();

    await userEvent.click(toggle());
    await userEvent.click(screen.getByRole("radio", { name: text.width.phone }));
    expect(toggle()).toBeChecked();
    expect(screen.getByRole("radio", { name: text.width.phone })).toBeChecked();
  });
});
