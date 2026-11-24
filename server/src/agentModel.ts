// Which model an agent run uses, decided by what the run is. Pure: main.ts reads the environment.
import type { RunKind } from "./db/schema.ts";

// The run kinds this table routes. An interview question, a website read, a file read and a build
// summary are run kinds too, for their usage rows, but their models are SCHMEIDE_INTERVIEW_MODEL
// (questions and file reads), SCHMEIDE_WEBSITE_MODEL and SCHMEIDE_SUMMARY_MODEL and are not decided
// here.
export const ROUTED_KINDS = [
  "spec",
  "initial",
  "change",
  "design",
  "review",
  "acceptance",
] as const satisfies readonly RunKind[];
export type RoutedKind = (typeof ROUTED_KINDS)[number];

export const FALLBACK_MODEL_ENV = "SCHMEIDE_AGENT_MODEL";
export const DEFAULT_MODEL = "opus";

// Kinds that start on their own model rather than the fallback: the design team's runs and the
// acceptance checks' judge and write little code, so a mid-size model does (#159, #354).
const KIND_DEFAULTS: Readonly<Partial<Record<RoutedKind, string>>> = {
  design: "sonnet",
  review: "sonnet",
  acceptance: "sonnet",
};

// A route per run kind; a kind without one uses the fallback. A route is `provider:model` or a bare
// model name, which stays on Claude so setups from before providers keep working. The model goes to
// its provider's runtime as it is, so it must be an alias or a deployment name that every tenant's
// resource serves.
export type ModelRouting = {
  readonly fallback: string;
  readonly byKind: Readonly<Partial<Record<RoutedKind, string>>>;
};

export const PROVIDERS = ["claude", "openai"] as const;
export type Provider = (typeof PROVIDERS)[number];

// The providers a run can reach today. Only the Claude Agent SDK runs agents so far; openai joins
// this list when its runtime does (#112, decided in schmeide/project#6).
export const RUNTIMES: readonly Provider[] = ["claude"];

export type Route = { readonly provider: Provider; readonly model: string };
export type ModelChoice = Route & { readonly reason: string };

const isProvider = (name: string): name is Provider => PROVIDERS.some((p) => p === name);

// Throws why the value is not a route; routingFromEnv names the variable that holds it.
export const parseRoute = (value: string): Route => {
  const colon = value.indexOf(":");
  if (colon < 0) return { provider: "claude", model: value };
  const provider = value.slice(0, colon);
  const model = value.slice(colon + 1).trim();
  if (!isProvider(provider)) {
    throw new Error(
      `unknown provider ${provider}. Use ${PROVIDERS.map((p) => `${p}:<model>`).join(", ")} or a bare Claude model name.`
    );
  }
  if (!model) throw new Error("names no model");
  return { provider, model };
};

export const modelEnvVar = (kind: RoutedKind): string =>
  `${FALLBACK_MODEL_ENV}_${kind.toUpperCase()}`;

// An empty value counts as unset, as make exports one for a variable with no value.
const set = (value: string | undefined): string | undefined => value?.trim() || undefined;

// Fails at startup on a route no runtime can run, rather than on the first build that takes it.
const checked = (
  name: string,
  value: string | undefined,
  runtimes: readonly Provider[]
): string | undefined => {
  if (value === undefined) return undefined;
  const fail = (why: string): never => {
    throw new Error(`${name}="${value}": ${why}`);
  };
  const { provider } = (() => {
    try {
      return parseRoute(value);
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  })();
  if (!runtimes.includes(provider)) {
    fail(
      `no runtime runs ${provider} models yet (#112). Use a Claude model, such as ${DEFAULT_MODEL}.`
    );
  }
  return value;
};

export const routingFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
  runtimes: readonly Provider[] = RUNTIMES
): ModelRouting => ({
  fallback: checked(FALLBACK_MODEL_ENV, set(env[FALLBACK_MODEL_ENV]), runtimes) ?? DEFAULT_MODEL,
  byKind: Object.fromEntries(
    ROUTED_KINDS.flatMap((kind) => {
      const model = checked(modelEnvVar(kind), set(env[modelEnvVar(kind)]), runtimes);
      return model ? [[kind, model]] : [];
    })
  ),
});

// The run kind is the only input. A fix-up run after failed checks keeps its build's kind, so it
// resumes the session on the model that started it; nothing escalates to a stronger model.
export const pickModel = (routing: ModelRouting, kind: RoutedKind): ModelChoice => {
  const routed = routing.byKind[kind];
  const byDefault = KIND_DEFAULTS[kind];
  return routed
    ? { ...parseRoute(routed), reason: `${modelEnvVar(kind)} routes ${kind} runs` }
    : byDefault
      ? {
          ...parseRoute(byDefault),
          reason: `${byDefault} by default for ${kind} runs, ${modelEnvVar(kind)} is not set`,
        }
      : {
          ...parseRoute(routing.fallback),
          reason: `${FALLBACK_MODEL_ENV} fallback, ${modelEnvVar(kind)} is not set`,
        };
};

// Claude routes print as the bare model, as they did before providers.
export const describeRoute = ({ provider, model }: Route): string =>
  provider === "claude" ? model : `${provider}:${model}`;

export const describeRouting = (routing: ModelRouting): string =>
  ROUTED_KINDS.map((kind) => `${kind} ${describeRoute(pickModel(routing, kind))}`).join(", ");
