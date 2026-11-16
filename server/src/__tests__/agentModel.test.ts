import { describe, expect, it } from "vitest";
import { describeRouting, pickModel, routingFromEnv } from "../agentModel.ts";

describe("agent model routing", () => {
  it("gives each run kind its configured model", () => {
    const routing = routingFromEnv({
      SCHMEIDE_AGENT_MODEL: "opus",
      SCHMEIDE_AGENT_MODEL_SPEC: "haiku",
      SCHMEIDE_AGENT_MODEL_INITIAL: "fable",
      SCHMEIDE_AGENT_MODEL_CHANGE: "sonnet",
    });

    expect(pickModel(routing, "spec")).toEqual({
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

    expect(describeRouting(routing)).toBe("spec haiku, initial opus, change opus");
  });

  it("treats an empty variable as unset", () => {
    const routing = routingFromEnv({ SCHMEIDE_AGENT_MODEL: "", SCHMEIDE_AGENT_MODEL_SPEC: " " });

    expect(pickModel(routing, "spec").model).toBe("opus");
  });
});
