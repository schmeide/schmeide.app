import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// Saddle's done gate runs `sh -c`, which does not see a zsh alias of `make` to
// `gmake`. On macOS that resolves `make` to /usr/bin/make 3.81.
const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

describe("GNU make", () => {
  it("runs this Makefile with GNU make 4 or newer when invoked as /usr/bin/make", () => {
    const make = existsSync("/usr/bin/make") ? "/usr/bin/make" : "make";
    const out = execFileSync(make, ["-s", "gnu-make-version"], {
      cwd: root,
      encoding: "utf8",
    });
    const major = Number.parseInt(out.trim().split(".")[0] ?? "", 10);
    expect(major).toBeGreaterThanOrEqual(4);
  });
});
