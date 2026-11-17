import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bytesOf, createResourceReader, figuresByProject } from "../resources.ts";

describe("reading docker's sizes", () => {
  it("knows binary and decimal units", () => {
    expect(bytesOf("512B")).toBe(512);
    expect(bytesOf("1.5KiB")).toBe(1536);
    expect(bytesOf("2MiB")).toBe(2 * 1024 ** 2);
    expect(bytesOf("1GiB")).toBe(1024 ** 3);
    expect(bytesOf("3kB")).toBe(3000);
    expect(bytesOf("1.2MB")).toBe(1_200_000);
  });

  it("refuses what it cannot read rather than guessing", () => {
    expect(() => bytesOf("lots")).toThrow();
  });
});

describe("figures by compose project", () => {
  it("sums each project's containers from docker ps and docker stats", () => {
    const ps = [
      "aaa\tschmeide-invoices",
      "bbb\tschmeide-invoices",
      "ccc\tschmeide-orders",
      "",
    ].join("\n");
    const stats = [
      "aaa\t1.50%\t10MiB / 7.6GiB",
      "bbb\t0.25%\t2MiB / 7.6GiB",
      "ccc\t0.00%\t512KiB / 7.6GiB",
      "",
    ].join("\n");
    expect(figuresByProject(ps, stats)).toEqual(
      new Map([
        ["schmeide-invoices", { containers: 2, memoryBytes: 12 * 1024 ** 2, cpuPercent: 1.75 }],
        ["schmeide-orders", { containers: 1, memoryBytes: 512 * 1024, cpuPercent: 0 }],
      ])
    );
  });

  it("refuses stats it cannot read, so the figures become unknown", () => {
    expect(() => figuresByProject("aaa\tschmeide-x\n", "aaa\t--\t--\n")).toThrow();
  });
});

describe("a project on disk", () => {
  it("counts the workspace and the app's checkout together, and nothing for one never built", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "schmeide-du-"));
    const reader = createResourceReader(dataDir);
    const signal = new AbortController().signal;
    expect(await reader.workspaceBytes("never-built", signal)).toBe(0);

    mkdirSync(join(dataDir, "projects", "books"), { recursive: true });
    writeFileSync(join(dataDir, "projects", "books", "code"), Buffer.alloc(64 * 1024));
    const workspaceOnly = await reader.workspaceBytes("books", signal);
    mkdirSync(join(dataDir, "production", "books"), { recursive: true });
    writeFileSync(join(dataDir, "production", "books", "code"), Buffer.alloc(64 * 1024));

    expect(workspaceOnly).toBeGreaterThanOrEqual(64 * 1024);
    expect(await reader.workspaceBytes("books", signal)).toBe(2 * workspaceOnly);
  });
});
