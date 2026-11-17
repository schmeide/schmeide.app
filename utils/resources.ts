import { copy } from "../data/copy";

// What a hosted project takes up; null is a figure the server could not read.
export type Figures = {
  readonly containers: number | null;
  readonly memoryBytes: number | null;
  readonly cpuPercent: number | null;
  readonly workspaceBytes: number | null;
};

export const UNKNOWN_FIGURES: Figures = {
  containers: null,
  memoryBytes: null,
  cpuPercent: null,
  workspaceBytes: null,
};

const BINARY_UNITS = ["B", "KiB", "MiB", "GiB", "TiB"] as const;

export const formatBytes = (bytes: number): string => {
  const power = Math.min(
    Math.max(Math.floor(Math.log2(Math.max(bytes, 1)) / 10), 0),
    BINARY_UNITS.length - 1
  );
  return power === 0
    ? `${bytes} B`
    : `${(bytes / 1024 ** power).toFixed(1)} ${BINARY_UNITS[power]}`;
};

export const formatPercent = (value: number): string => `${value.toFixed(1)}%`;

export const formatCount = (value: number): string => String(value);

// Undefined while the figures are being read.
export const describeFigure = (
  value: number | null | undefined,
  format: (value: number) => string
): string =>
  value === undefined
    ? copy.resources.reading
    : value === null
      ? copy.resources.unknown
      : format(value);

// Each figure summed over `expected` projects. A project that could not be read, or has no
// figures at all, makes that sum unknown rather than quietly smaller.
export const sumResources = (figures: readonly Figures[], expected: number): Figures => {
  const sum = (field: keyof Figures): number | null => {
    const values = figures.map((one) => one[field]);
    if (values.length !== expected) return null;
    return values.reduce<number | null>(
      (total, value) => (total === null || value === null ? null : total + value),
      0
    );
  };
  return {
    containers: sum("containers"),
    memoryBytes: sum("memoryBytes"),
    cpuPercent: sum("cpuPercent"),
    workspaceBytes: sum("workspaceBytes"),
  };
};
