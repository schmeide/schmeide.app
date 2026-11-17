import { copy } from "../../data/copy";
import { describeFigure, formatBytes, sumResources } from "../resources";

const known = { containers: 1, memoryBytes: 1024, cpuPercent: 0.5, workspaceBytes: 2048 };

describe("resource figures", () => {
  it("format sizes in binary units", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1536)).toBe("1.5 KiB");
    expect(formatBytes(3 * 1024 ** 3)).toBe("3.0 GiB");
  });

  it("say unknown for a figure that could not be read, and wait while loading", () => {
    expect(describeFigure(null, formatBytes)).toBe(copy.resources.unknown);
    expect(describeFigure(undefined, formatBytes)).toBe(copy.resources.reading);
    expect(describeFigure(2048, formatBytes)).toBe("2.0 KiB");
  });

  it("sum per figure, and one unknown project makes that sum unknown", () => {
    expect(sumResources([known, known], 2)).toEqual({
      containers: 2,
      memoryBytes: 2048,
      cpuPercent: 1,
      workspaceBytes: 4096,
    });
    expect(sumResources([known, { ...known, memoryBytes: null }], 2)).toEqual({
      containers: 2,
      memoryBytes: null,
      cpuPercent: 1,
      workspaceBytes: 4096,
    });
  });

  it("sum to unknown when a project has no figures at all", () => {
    expect(sumResources([known], 2)).toEqual({
      containers: null,
      memoryBytes: null,
      cpuPercent: null,
      workspaceBytes: null,
    });
  });
});
