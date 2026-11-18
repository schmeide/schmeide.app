import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppContext } from "../router.ts";

// An unexpected failure inside a procedure: the session lookup throws.
const failing = {
  db: {},
  auth: {
    api: {
      getSession: () => {
        throw new Error("boom");
      },
    },
  },
} as unknown as AppContext;

// The router reads SCHMEIDE_ENV once, when it loads, so each case loads it afresh.
const errorBody = async (env: string, nodeEnv: string) => {
  vi.stubEnv("SCHMEIDE_ENV", env);
  vi.stubEnv("NODE_ENV", nodeEnv);
  vi.resetModules();
  const { buildApp } = await import("../app.ts");
  const app = buildApp(failing, {});
  try {
    const response = await app.inject({ method: "GET", url: "/trpc/session.get" });
    expect(response.statusCode).toBe(500);
    return response.body;
  } finally {
    await app.close();
  }
};

afterEach(() => vi.unstubAllEnvs());

describe("an API error response", () => {
  it("carries no stack or file path in production, whatever NODE_ENV holds", async () => {
    const body = await errorBody("production", "development");
    expect(body).toContain("boom");
    expect(body).not.toContain('"stack"');
    expect(body).not.toMatch(/\.ts:\d+/);
  });

  it("carries the stack in development", async () => {
    const body = await errorBody("development", "production");
    expect(body).toContain('"stack"');
    expect(body).toMatch(/\.ts:\d+/);
  });

  it("carries no stack when SCHMEIDE_ENV is unset", async () => {
    expect(await errorBody("", "development")).not.toContain('"stack"');
  });
});
