import { afterEach, describe, expect, it, vi } from "vitest";

import { copy } from "../../data/copy";

// Whether the API is hosted is read once, when the module loads, so each case loads it afresh.
const load = async (apiUrl: string) => {
  vi.stubEnv("VITE_API_URL", apiUrl);
  vi.resetModules();
  return import("../ErrorNote");
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("serverDownText", () => {
  it("never tells a customer on the hosted site how to start the server", async () => {
    const { serverDownText } = await load("https://api.schmeide.app");
    expect(serverDownText).toBe(copy.errors.serverDown);
    expect(serverDownText).not.toContain("make serve");
  });

  it("tells a developer running the site locally to run make serve", async () => {
    const { serverDownText } = await load("");
    expect(serverDownText).toContain("make serve");
  });
});
