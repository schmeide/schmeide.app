import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { createHealthServer, parseBuilds, parseRole } from "../role.ts";

describe("SCHMEIDE_ROLE", () => {
  it("runs the API and the worker in one process by default, as make serve does", () => {
    expect(parseRole(undefined)).toEqual({ serveApi: true, runWorker: true });
    expect(parseRole("all")).toEqual({ serveApi: true, runWorker: true });
  });

  it("serves only the API as api, and only the worker as worker", () => {
    expect(parseRole("api")).toEqual({ serveApi: true, runWorker: false });
    expect(parseRole("worker")).toEqual({ serveApi: false, runWorker: true });
  });

  it("refuses anything else, naming the valid roles", () => {
    expect(() => parseRole("API")).toThrow(
      'SCHMEIDE_ROLE is "API"; set it to all (the default), api, or worker.'
    );
  });
});

describe("SCHMEIDE_BUILDS", () => {
  it("builds for everyone by default, and takes off and admins", () => {
    expect(parseBuilds(undefined)).toBe("on");
    expect(parseBuilds("off")).toBe("off");
    expect(parseBuilds("admins")).toBe("admins");
  });

  it("refuses anything else, naming the valid values", () => {
    expect(() => parseBuilds("admin")).toThrow(
      'SCHMEIDE_BUILDS is "admin"; set it to on (the default), off, or admins.'
    );
  });
});

describe("the worker's health server", () => {
  const get = async (live: boolean, path: string) => {
    const server = createHealthServer(() => live);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      return (await fetch(`http://127.0.0.1:${port}${path}`)).status;
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  };

  it("answers /healthz with whether the worker runs", async () => {
    expect(await get(true, "/healthz")).toBe(200);
    expect(await get(false, "/healthz")).toBe(503);
  });

  it("serves nothing of the API", async () => {
    expect(await get(true, "/api/trpc/projects.list")).toBe(404);
    expect(await get(true, "/trpc/projects.list")).toBe(404);
  });
});
