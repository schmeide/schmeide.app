import type { Db } from "../db/client.ts";
import { createAuth, type AuthConfig } from "../services/auth.ts";

export const TEST_ORIGIN = "http://localhost:5173";

// Sign-in as the tests use it: no providers and no rate limit unless a test asks.
export const testAuth = (db: Db, overrides: Partial<AuthConfig> = {}) =>
  createAuth(db, {
    secret: "test-secret-test-secret-test-secret-test",
    publicUrl: TEST_ORIGIN,
    apiUrl: TEST_ORIGIN,
    providers: {},
    rateLimit: false,
    ...overrides,
  });
