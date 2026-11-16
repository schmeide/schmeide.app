// Which model an agent run uses, decided by what the run is. Pure: main.ts reads the environment.
import type { RunKind } from "./db/schema.ts";

// The run kinds this table routes. An interview question is a run kind too, for its usage rows, but
// its model is SCHMEIDE_INTERVIEW_MODEL and is not decided here.
export const ROUTED_KINDS = ["spec", "initial", "change"] as const satisfies readonly RunKind[];
export type RoutedKind = (typeof ROUTED_KINDS)[number];

export const FALLBACK_MODEL_ENV = "SCHMEIDE_AGENT_MODEL";
export const DEFAULT_MODEL = "opus";

// A model per run kind; a kind without one uses the fallback. Names go to the Claude Agent SDK as
// they are, so each must be an alias or a deployment name that every tenant's resource serves.
export type ModelRouting = {
  readonly fallback: string;
  readonly byKind: Readonly<Partial<Record<RoutedKind, string>>>;
};

export type ModelChoice = { readonly model: string; readonly reason: string };

export const modelEnvVar = (kind: RoutedKind): string =>
  `${FALLBACK_MODEL_ENV}_${kind.toUpperCase()}`;

// An empty value counts as unset, as make exports one for a variable with no value.
const set = (value: string | undefined): string | undefined => value?.trim() || undefined;

export const routingFromEnv = (
  env: Readonly<Record<string, string | undefined>>
): ModelRouting => ({
  fallback: set(env[FALLBACK_MODEL_ENV]) ?? DEFAULT_MODEL,
  byKind: Object.fromEntries(
    ROUTED_KINDS.flatMap((kind) => {
      const model = set(env[modelEnvVar(kind)]);
      return model ? [[kind, model]] : [];
    })
  ),
});

// The run kind is the only input. A fix-up run after failed checks keeps its build's kind, so it
// resumes the session on the model that started it; nothing escalates to a stronger model.
export const pickModel = (routing: ModelRouting, kind: RoutedKind): ModelChoice => {
  const routed = routing.byKind[kind];
  return routed
    ? { model: routed, reason: `${modelEnvVar(kind)} routes ${kind} runs` }
    : {
        model: routing.fallback,
        reason: `${FALLBACK_MODEL_ENV} fallback, ${modelEnvVar(kind)} is not set`,
      };
};

export const describeRouting = (routing: ModelRouting): string =>
  ROUTED_KINDS.map((kind) => `${kind} ${pickModel(routing, kind).model}`).join(", ");
