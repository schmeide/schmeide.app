import { afterEach, describe, expect, it, vi } from "vitest";

// The base is read once, when the module loads, so each case loads it afresh.
const load = async (apiUrl: string) => {
  vi.stubEnv("VITE_API_URL", apiUrl);
  vi.resetModules();
  return import("../apiUrl");
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("apiUrl", () => {
  it("goes through the site's own /api, which `make serve` proxies, when no API is set", async () => {
    const { apiUrl, hasHostedApi } = await load("");
    expect(apiUrl("/trpc")).toBe("/api/trpc");
    expect(apiUrl("/auth/sign-out")).toBe("/api/auth/sign-out");
    expect(hasHostedApi).toBe(false);
  });

  it("calls the hosted API at its root, with no /api in front", async () => {
    const { apiUrl, hasHostedApi } = await load("https://api.schmeide.app/");
    expect(apiUrl("/trpc")).toBe("https://api.schmeide.app/trpc");
    expect(apiUrl("/auth/sign-out")).toBe("https://api.schmeide.app/auth/sign-out");
    expect(hasHostedApi).toBe(true);
  });
});
