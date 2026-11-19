import { describe, expect, it } from "vitest";
import { PLANS } from "../../../utils/plans.ts";
import { buildApp } from "../app.ts";
import { registerPlans } from "../plans.ts";
import type { AppContext } from "../router.ts";

// The answer reads nothing from the context, so none is built.
const app = () => {
  const server = buildApp({} as AppContext, { allowOrigin: "https://schmeide.app" });
  registerPlans(server);
  return server;
};

describe("GET /plans", () => {
  it("answers the plans as plain JSON, with no session", async () => {
    const server = app();
    try {
      const response = await server.inject({ method: "GET", url: "/plans" });

      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toMatch(/^application\/json/);
      expect(response.json()).toEqual({ plans: PLANS });
      for (const plan of response.json().plans)
        expect(Object.keys(plan).sort()).toEqual(
          [
            "beyondAllowance",
            "buildingAllowanceUsd",
            "id",
            "liveApps",
            "monthlyPriceUsd",
            "name",
          ].sort()
        );
    } finally {
      await server.close();
    }
  });

  it("may be kept by caches and read from any site, without credentials", async () => {
    const server = app();
    try {
      const response = await server.inject({
        method: "GET",
        url: "/plans",
        headers: { origin: "https://schmeide.com" },
      });

      expect(response.headers["cache-control"]).toMatch(/^public, max-age=\d+/);
      expect(response.headers["access-control-allow-origin"]).toBe("*");
      expect(response.headers["access-control-allow-credentials"]).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it("drops the credentials header even for the app's own origin", async () => {
    const server = app();
    try {
      const response = await server.inject({
        method: "GET",
        url: "/plans",
        headers: { origin: "https://schmeide.app" },
      });

      expect(response.headers["access-control-allow-origin"]).toBe("*");
      expect(response.headers["access-control-allow-credentials"]).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it("keeps every other answer out of caches", async () => {
    const server = app();
    try {
      const response = await server.inject({ method: "GET", url: "/healthz" });

      expect(response.headers["cache-control"]).toBe("no-store");
    } finally {
      await server.close();
    }
  });
});
