import { describe, expect, it } from "vitest";
import { claudeEnv } from "../claudeEnv.ts";

const SERVER = {
  DATABASE_URL: "postgres://secret",
  TEST_DATABASE_URL: "postgres://secret",
  SCHMEIDE_AUTH_SECRET: "secret",
  SCHMEIDE_GOOGLE_CLIENT_SECRET: "secret",
  SCHMEIDE_GITHUB_CLIENT_SECRET: "secret",
  TEMPORAL_ADDRESS: "temporal:7233",
  MAKEFLAGS: "-j",
  PORT: "3100",
  SOMETHING_ADDED_TO_THE_POD_LATER: "secret",
} as const;

describe("claudeEnv", () => {
  it("passes only what claude needs to run and to find its login or API key", () => {
    const env = claudeEnv({
      ...SERVER,
      PATH: "/usr/bin",
      HOME: "/home/schmeide",
      USER: "schmeide",
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      ANTHROPIC_API_KEY: "sk-ant",
      CLAUDE_CODE_USE_FOUNDRY: "1",
      ANTHROPIC_FOUNDRY_RESOURCE: "schmeide",
      UNSET: undefined,
    });

    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/schmeide",
      USER: "schmeide",
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      ANTHROPIC_API_KEY: "sk-ant",
      CLAUDE_CODE_USE_FOUNDRY: "1",
      ANTHROPIC_FOUNDRY_RESOURCE: "schmeide",
    });
  });

  it("reads the server's own environment by default", () => {
    expect(claudeEnv().PATH).toBe(process.env.PATH);
    expect(claudeEnv().DATABASE_URL).toBeUndefined();
  });
});
