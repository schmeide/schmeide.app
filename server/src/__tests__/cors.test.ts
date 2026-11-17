import { afterAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.ts";
import { createDb } from "../db/client.ts";
import { BUSINESS_HEADER } from "../router.ts";
import { testAuth } from "./testAuth.ts";

const db = createDb(process.env.DATABASE_URL ?? "");
afterAll(() => db.$client.end());

const SITE = "https://schmeide.app";
const app = buildApp(
  {
    db,
    workflows: { start: vi.fn(), getHandle: vi.fn() as never },
    taskQueue: "test",
    interviewer: vi.fn(),
    siteFetcher: vi.fn(),
    websiteReader: vi.fn(),
    auth: testAuth(db, { publicUrl: SITE, apiUrl: "https://api.schmeide.app" }),
    providers: [],
  },
  { allowOrigin: SITE }
);
afterAll(() => app.close());

const sessionFrom = (origin: string) =>
  app.inject({ method: "GET", url: "/api/trpc/session.get", headers: { origin } });

describe("a hosted API on another origin", () => {
  it("lets the site call it with the session cookie", async () => {
    const response = await sessionFrom(SITE);
    expect(response.statusCode).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBe(SITE);
    expect(response.headers["access-control-allow-credentials"]).toBe("true");
    // Nothing caches an answer, so one origin's answer is never handed to another.
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("gives no other origin leave to read its answers", async () => {
    for (const origin of ["https://evil.example", "https://schmeide.app.evil.example", "null"]) {
      const response = await sessionFrom(origin);
      expect(response.headers["access-control-allow-origin"]).toBeUndefined();
      expect(response.headers["access-control-allow-credentials"]).toBeUndefined();
    }
  });

  it("answers the browser's question before a call with JSON or the business header", async () => {
    const ask = (origin: string) =>
      app.inject({
        method: "OPTIONS",
        url: "/api/trpc/projects.create",
        headers: {
          origin,
          "access-control-request-method": "POST",
          "access-control-request-headers": `content-type, ${BUSINESS_HEADER}`,
        },
      });
    const allowed = await ask(SITE);
    expect(allowed.statusCode).toBe(204);
    expect(allowed.headers["access-control-allow-methods"]).toContain("POST");
    expect(allowed.headers["access-control-allow-headers"]).toContain(BUSINESS_HEADER);
    expect(allowed.headers["access-control-allow-headers"]).toContain("content-type");

    const refused = await ask("https://evil.example");
    expect(refused.headers["access-control-allow-origin"]).toBeUndefined();
    expect(refused.statusCode).not.toBe(204);
  });

  it("refuses a sign-in posted from another site", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { origin: "https://evil.example", cookie: "anything=1" },
      payload: { email: "ada@example.com", password: "correct horse battery" },
    });
    expect(response.statusCode).toBe(403);
  });
});
