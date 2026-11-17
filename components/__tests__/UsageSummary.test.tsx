import { act, render, screen } from "@testing-library/react";

import { copy } from "../../data/copy";
import { UsageSummary } from "../UsageSummary";
import { noUsage } from "./fakeApi";

const TIME = {
  buildingMs: 125_000,
  failedBuildingMs: 65_000,
  builderMs: 3_700_000,
  builderUnrecorded: false,
} as const;

describe("UsageSummary time", () => {
  afterEach(() => vi.useRealTimers());

  it("shows building time with the failed part apart, and builder time, each named plainly", () => {
    render(<UsageSummary usage={noUsage} time={TIME} runningSince={null} />);

    expect(screen.getByText(copy.project.time.building)).toBeInTheDocument();
    expect(screen.getByText("2 min 5 s")).toBeInTheDocument();
    expect(screen.getByText(copy.project.time.failed("1 min 5 s"))).toBeInTheDocument();
    expect(screen.getByText(copy.project.time.builder)).toBeInTheDocument();
    expect(screen.getByText("1 h 1 min")).toBeInTheDocument();
    expect(screen.queryByText(copy.project.time.partlyRecorded)).not.toBeInTheDocument();
  });

  it("keeps counting while a build runs, and stops once it has finished", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-16T12:00:00Z"));
    const runningSince = new Date("2026-11-16T11:59:50Z");
    const { rerender } = render(
      <UsageSummary usage={noUsage} time={TIME} runningSince={runningSince} />
    );

    expect(screen.getByText("2 min 15 s")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(5000));
    expect(screen.getByText("2 min 20 s")).toBeInTheDocument();

    // Finished: the server's total now holds it.
    rerender(
      <UsageSummary usage={noUsage} time={{ ...TIME, buildingMs: 140_000 }} runningSince={null} />
    );
    expect(screen.getByText("2 min 20 s")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(5000));
    expect(screen.getByText("2 min 20 s")).toBeInTheDocument();
  });

  it("says builder time was not recorded for runs from before it was", () => {
    const { rerender } = render(
      <UsageSummary
        usage={noUsage}
        time={{ ...TIME, builderMs: 0, builderUnrecorded: true }}
        runningSince={null}
      />
    );
    expect(screen.getByText(copy.project.time.notRecorded)).toBeInTheDocument();
    expect(screen.getByText("2 min 5 s")).toBeInTheDocument();

    rerender(
      <UsageSummary
        usage={noUsage}
        time={{ ...TIME, builderUnrecorded: true }}
        runningSince={null}
      />
    );
    expect(screen.getByText("1 h 1 min")).toBeInTheDocument();
    expect(screen.getByText(copy.project.time.partlyRecorded)).toBeInTheDocument();
  });

  it("leaves time out where only tokens and cost are known", () => {
    render(<UsageSummary usage={noUsage} />);
    expect(screen.queryByText(copy.project.time.building)).not.toBeInTheDocument();
  });
});
