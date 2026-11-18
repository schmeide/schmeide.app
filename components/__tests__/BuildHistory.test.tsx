import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { copy } from "../../data/copy";
import { BuildHistory } from "../BuildHistory";
import { aBuild, anEvent, renderWithApi } from "./fakeApi";

const started = new Date("2026-11-16T10:00:00Z");
const past = (overrides: Parameters<typeof aBuild>[0]) =>
  aBuild({ startedAt: started, finishedAt: new Date(started.getTime() + 95_000), ...overrides });

describe("BuildHistory", () => {
  it("lists past builds with what was asked, the result, how long, and the cost", async () => {
    renderWithApi(<BuildHistory projectId={7} currentBuildId={5} />, {
      "builds.list": () => ({
        builds: [
          { ...aBuild({ id: 5, kind: "change", request: "Running now" }), costUsd: 0 },
          { ...past({ id: 4, kind: "site", request: "title", status: "passed" }), costUsd: 0 },
          {
            ...past({
              id: 3,
              kind: "change",
              request: "Add a menu",
              status: "failed",
              error: "Tests failed",
            }),
            costUsd: 1.234,
          },
        ],
        nextCursor: null,
      }),
    });

    const list = await screen.findByRole("list", { name: copy.project.history.title });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(screen.queryByText("Running now")).toBeNull();
    expect(items[0]).toHaveTextContent(copy.project.siteChangeRequest);
    expect(items[1]).toHaveTextContent("Add a menu");
    expect(items[1]).toHaveTextContent(copy.project.buildStatus.failed);
    expect(items[1]).toHaveTextContent(copy.duration(1, 35));
    expect(items[1]).toHaveTextContent("$1.23");
  });

  it("says so when the first build is the only one", async () => {
    renderWithApi(<BuildHistory projectId={7} currentBuildId={3} />, {
      "builds.list": () => ({ builds: [{ ...aBuild({ id: 3 }), costUsd: 0 }], nextCursor: null }),
    });

    expect(await screen.findByText(copy.project.history.empty)).toBeInTheDocument();
  });

  it("opens a past build's log", async () => {
    const calls = renderWithApi(<BuildHistory projectId={7} currentBuildId={5} />, {
      "builds.list": () => ({
        builds: [
          {
            ...past({ id: 3, kind: "change", request: "Add a menu", status: "passed" }),
            costUsd: 0,
          },
        ],
        nextCursor: null,
      }),
      "builds.events": () => [anEvent(1, "step", "Installed packages")],
    });

    const open = await screen.findByRole("button", { name: copy.project.history.showLog });
    expect(open).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(open);

    expect(await screen.findByText("Installed packages")).toBeVisible();
    expect(open).toHaveAttribute("aria-expanded", "true");
    expect(calls).toContainEqual({ path: "builds.events", input: { buildId: 3, afterId: 0 } });
  });

  it("loads older builds a page at a time", async () => {
    renderWithApi(<BuildHistory projectId={7} currentBuildId={9} />, {
      "builds.list": (input) =>
        input.cursor
          ? {
              builds: [{ ...past({ id: 2, kind: "change", request: "Older" }), costUsd: 0 }],
              nextCursor: null,
            }
          : {
              builds: [{ ...past({ id: 4, kind: "change", request: "Newer" }), costUsd: 0 }],
              nextCursor: 4,
            },
    });

    await screen.findByText("Newer");
    await userEvent.click(screen.getByRole("button", { name: copy.project.history.more }));
    expect(await screen.findByText("Older")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: copy.project.history.more })).toBeNull();
  });
});
