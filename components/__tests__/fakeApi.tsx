import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createTRPCClient, TRPCClientError, type TRPCLink } from "@trpc/client";
import { observable } from "@trpc/server/observable";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";

import { SessionProvider } from "../SessionProvider";
import type { AppRouter } from "../../server/src/router.ts";
import type { Build, BuildEvent, Project, Usage } from "../../trpc";
import { TRPCProvider } from "../../trpc";
import type { Session } from "../../utils/session";

type Input = Readonly<Record<string, unknown>>;
export type Handlers = Readonly<Record<string, (input: Input) => unknown>>;
export type Call = { readonly path: string; readonly input: Input };

// Thrown by a handler to answer with a tRPC error; no code means the server never answered.
export class ApiFailure extends Error {
  constructor(
    readonly code: string | undefined,
    message: string = code ?? "Failed to fetch"
  ) {
    super(message);
  }
}

const toClientError = (error: unknown) =>
  error instanceof ApiFailure && error.code
    ? TRPCClientError.from({
        error: {
          code: -32000,
          message: error.message,
          data: { code: error.code, httpStatus: 400 },
        },
      })
    : TRPCClientError.from(error instanceof Error ? error : new Error(String(error)));

// A terminating link that answers from handlers instead of the network, recording every call.
const fakeLink =
  (handlers: Handlers, calls: Call[]): TRPCLink<AppRouter> =>
  () =>
  ({ op }) =>
    observable((observer) => {
      const input = (op.input ?? {}) as Input;
      calls.push({ path: op.path, input });
      const handler = handlers[op.path];
      Promise.resolve()
        .then(() => {
          if (!handler) throw new Error(`no fake for ${op.path}`);
          return handler(input);
        })
        .then(
          (data) => {
            observer.next({ result: { data } });
            observer.complete();
          },
          (error: unknown) => observer.error(toClientError(error))
        );
    });

// `session` is who is signed in; left out, it is the dev stand-in owner with one business.
export const renderWithApi = (ui: ReactNode, handlers: Handlers, session?: Session) => {
  const calls: Call[] = [];
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const trpcClient = createTRPCClient<AppRouter>({ links: [fakeLink(handlers, calls)] });
  render(
    <QueryClientProvider client={queryClient}>
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
        <SessionProvider initial={session}>{ui}</SessionProvider>
      </TRPCProvider>
    </QueryClientProvider>
  );
  return calls;
};

const at = new Date("2026-11-16T10:00:00Z");

export const aProject = (overrides: Partial<Project> = {}): Project => ({
  id: 7,
  tenantId: 1,
  slug: "invoices",
  name: "Invoices",
  status: "draft",
  features: "",
  spec: null,
  webPort: 8100,
  previewUrl: null,
  pageTitle: null,
  createdAt: at,
  updatedAt: at,
  ...overrides,
});

export const aBuild = (overrides: Partial<Build> = {}): Build => ({
  id: 3,
  projectId: 7,
  kind: "initial",
  request: "",
  status: "running",
  error: null,
  startedAt: new Date(),
  finishedAt: null,
  ...overrides,
});

export const anEvent = (id: number, kind: BuildEvent["kind"], message: string): BuildEvent => ({
  id,
  buildId: 3,
  at,
  kind,
  message,
});

export const noUsage: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  costUsd: 0,
};

// A single project whose state the test mutates; `get` reads it, `events` pages through `events`.
export const projectServer = (state: {
  project: Project;
  latestBuild?: Build | null;
  queued?: readonly Build[];
  hasIcon?: boolean;
  events?: BuildEvent[];
  usage?: Usage;
}): Handlers => ({
  "projects.list": () => [state.project],
  "projects.get": () => ({
    project: state.project,
    latestBuild: state.latestBuild ?? null,
    queued: state.queued ?? [],
    hasIcon: state.hasIcon ?? false,
    usage: state.usage ?? noUsage,
  }),
  "builds.events": (input) =>
    (state.events ?? []).filter((event) => event.id > Number(input.afterId)),
});
