import { describe, expect, it } from "vitest";
import { describeRouting, parseRoute, pickModel, routingFromEnv } from "../agentModel.ts";

describe("agent model routing", () => {
  it("gives each run kind its configured model", () => {
    const routing = routingFromEnv({
      SCHMEIDE_AGENT_MODEL: "opus",
      SCHMEIDE_AGENT_MODEL_SPEC: "haiku",
      SCHMEIDE_AGENT_MODEL_INITIAL: "fable",
      SCHMEIDE_AGENT_MODEL_CHANGE: "sonnet",
    });

    expect(pickModel(routing, "spec")).toEqual({
      provider: "claude",
      model: "haiku",
      reason: "SCHMEIDE_AGENT_MODEL_SPEC routes spec runs",
    });
    expect(pickModel(routing, "initial").model).toBe("fable");
    expect(pickModel(routing, "change").model).toBe("sonnet");
  });

  it("falls back to SCHMEIDE_AGENT_MODEL for every kind when the table is unset", () => {
    const routing = routingFromEnv({ SCHMEIDE_AGENT_MODEL: "sonnet" });

    expect(routing.byKind).toEqual({});
    for (const kind of ["spec", "initial", "change"] as const) {
      expect(pickModel(routing, kind).model).toBe("sonnet");
    }
    expect(pickModel(routing, "change").reason).toBe(
      "SCHMEIDE_AGENT_MODEL fallback, SCHMEIDE_AGENT_MODEL_CHANGE is not set"
    );
  });

  it("routes one kind and leaves the others on the fallback", () => {
    const routing = routingFromEnv({ SCHMEIDE_AGENT_MODEL_SPEC: "haiku" });

    expect(describeRouting(routing)).toBe(
      "spec haiku, initial opus, change opus, design sonnet, review sonnet"
    );
  });

  it("puts the design lead on a mid-size model unless it is routed or the fallback is", () => {
    expect(pickModel(routingFromEnv({ SCHMEIDE_AGENT_MODEL: "opus" }), "design")).toEqual({
      provider: "claude",
      model: "sonnet",
      reason: "sonnet by default for design runs, SCHMEIDE_AGENT_MODEL_DESIGN is not set",
    });
    expect(
      pickModel(routingFromEnv({ SCHMEIDE_AGENT_MODEL_DESIGN: "haiku" }), "design").model
    ).toBe("haiku");
    expect(pickModel(routingFromEnv({}), "review").model).toBe("sonnet");
    expect(pickModel(routingFromEnv({ SCHMEIDE_AGENT_MODEL_REVIEW: "opus" }), "review").model).toBe(
      "opus"
    );
  });

  it("treats an empty variable as unset", () => {
    const routing = routingFromEnv({ SCHMEIDE_AGENT_MODEL: "", SCHMEIDE_AGENT_MODEL_SPEC: " " });

    expect(pickModel(routing, "spec").model).toBe("opus");
  });

  it("keeps a bare model name on Claude", () => {
    expect(parseRoute("opus")).toEqual({ provider: "claude", model: "opus" });
    expect(parseRoute("claude:sonnet")).toEqual({ provider: "claude", model: "sonnet" });
    expect(pickModel(routingFromEnv({ SCHMEIDE_AGENT_MODEL: "haiku" }), "spec")).toEqual({
      provider: "claude",
      model: "haiku",
      reason: "SCHMEIDE_AGENT_MODEL fallback, SCHMEIDE_AGENT_MODEL_SPEC is not set",
    });
  });

  it("sends each run kind to its configured provider once that provider has a runtime", () => {
    const routing = routingFromEnv(
      {
        SCHMEIDE_AGENT_MODEL: "openai:gpt-5-codex",
        SCHMEIDE_AGENT_MODEL_SPEC: "openai:gpt-5-mini",
        SCHMEIDE_AGENT_MODEL_INITIAL: "opus",
        SCHMEIDE_AGENT_MODEL_DESIGN: "claude:sonnet",
      },
      ["claude", "openai"]
    );

    expect(pickModel(routing, "spec")).toEqual({
      provider: "openai",
      model: "gpt-5-mini",
      reason: "SCHMEIDE_AGENT_MODEL_SPEC routes spec runs",
    });
    expect(pickModel(routing, "initial")).toMatchObject({ provider: "claude", model: "opus" });
    expect(pickModel(routing, "change")).toMatchObject({
      provider: "openai",
      model: "gpt-5-codex",
    });
    expect(pickModel(routing, "design")).toMatchObject({ provider: "claude", model: "sonnet" });
    expect(pickModel(routing, "review")).toMatchObject({ provider: "claude", model: "sonnet" });
    expect(describeRouting(routing)).toBe(
      "spec openai:gpt-5-mini, initial opus, change openai:gpt-5-codex, design sonnet, review sonnet"
    );
  });

  it("refuses a route to a provider with no runtime, naming the variable and the fix", () => {
    expect(() => routingFromEnv({ SCHMEIDE_AGENT_MODEL_CHANGE: "openai:gpt-5" })).toThrow(
      'SCHMEIDE_AGENT_MODEL_CHANGE="openai:gpt-5": no runtime runs openai models yet (#112). Use a Claude model, such as opus.'
    );
    expect(() => routingFromEnv({ SCHMEIDE_AGENT_MODEL: "gemini:pro" })).toThrow(
      'SCHMEIDE_AGENT_MODEL="gemini:pro": unknown provider gemini. Use claude:<model>, openai:<model> or a bare Claude model name.'
    );
    expect(() => routingFromEnv({ SCHMEIDE_AGENT_MODEL_SPEC: "openai:" })).toThrow(
      'SCHMEIDE_AGENT_MODEL_SPEC="openai:": names no model'
    );
  });
});
