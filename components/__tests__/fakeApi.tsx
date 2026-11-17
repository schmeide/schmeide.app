import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createTRPCClient, TRPCClientError, type TRPCLink } from "@trpc/client";
import { observable } from "@trpc/server/observable";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";

import { SessionProvider } from "../SessionProvider";
import type { AppRouter } from "../../server/src/router.ts";
import type {
  Build,
  BuildEvent,
  Interview,
  PlanItem,
  Project,
  Question,
  TimeTotals,
  Usage,
} from "../../trpc";
import { TRPCProvider } from "../../trpc";
import type { Provider, Session } from "../../utils/session";

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

export const demoOwner: Session = {
  person: { name: "Demo owner", email: "owner@demo.example" },
  businesses: [{ id: 1, name: "Demo business" }],
};

// `session` is who is signed in; left out, it is an owner with one business. "server" asks the
// handlers instead (`session.get`), as the real app does.
export const renderWithApi = (
  ui: ReactNode,
  handlers: Handlers,
  session: Session | "server" = demoOwner
) => {
  const calls: Call[] = [];
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const trpcClient = createTRPCClient<AppRouter>({ links: [fakeLink(handlers, calls)] });
  render(
    <QueryClientProvider client={queryClient}>
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
        <SessionProvider fixed={session === "server" ? undefined : session}>{ui}</SessionProvider>
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
  need: "",
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

export const noTime: TimeTotals = {
  buildingMs: 0,
  failedBuildingMs: 0,
  builderMs: 0,
  builderUnrecorded: false,
};

export const anInterview = (overrides: Partial<Interview> = {}): Interview => ({
  items: [],
  questions: [],
  current: null,
  sections: {
    who: "not_started",
    does: "not_started",
    screens: "not_started",
    keeps: "not_started",
    replaces: "not_started",
  },
  finished: false,
  ...overrides,
});

export const aQuestion = (overrides: Partial<Question> = {}): Question => ({
  id: 11,
  projectId: 7,
  text: "Who sends the invoices?",
  kind: "pick_one",
  choices: ["Just me", "Me and my staff"],
  answer: null,
  askedAt: at,
  answeredAt: null,
  ...overrides,
});

export const anItem = (overrides: Partial<PlanItem> = {}): PlanItem => ({
  id: 21,
  projectId: 7,
  section: "does",
  text: "Create an invoice",
  source: "you",
  phase: "day_one",
  createdAt: at,
  ...overrides,
});

// A single project whose state the test mutates; `get` reads it, `events` pages through `events`.
export const projectServer = (state: {
  project: Project;
  latestBuild?: Build | null;
  queued?: readonly Build[];
  changes?: readonly Pick<Build, "id" | "request" | "finishedAt">[];
  hasIcon?: boolean;
  hasBeenLive?: boolean;
  events?: BuildEvent[];
  usage?: Usage;
  time?: TimeTotals;
  interview?: Interview;
}): Handlers => ({
  "interview.get": () => state.interview ?? anInterview(),
  "projects.list": () => [state.project],
  "projects.get": () => ({
    project: state.project,
    latestBuild: state.latestBuild ?? null,
    queued: state.queued ?? [],
    changes: state.changes ?? [],
    hasIcon: state.hasIcon ?? false,
    hasBeenLive: state.hasBeenLive ?? false,
    usage: state.usage ?? noUsage,
    time: state.time ?? noTime,
  }),
  "builds.events": (input) =>
    (state.events ?? []).filter((event) => event.id > Number(input.afterId)),
});

// The server's side of sign-in: `session.get` answers whoever `state.session` says, and the
// /api/auth routes (called with fetch) change it. Returns the handlers and the fetch calls made.
export const authServer = (state: {
  session: Session;
  providers?: readonly Provider[];
  // The account that can sign in with a password.
  account?: Session & { readonly password: string };
  // The answer to a password sign-in when it is not 200 or 401.
  signInStatus?: number;
}) => {
  const requests: { readonly path: string; readonly body: Input }[] = [];
  const answer = (status: number, body: unknown = {}) =>
    Promise.resolve(new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
    const path = url.replace("/api/auth", "");
    const body = JSON.parse(String(init.body)) as Input;
    requests.push({ path, body });
    if (path === "/sign-out") {
      state.session = { person: null, businesses: [] };
      return answer(200);
    }
    if (path === "/sign-in/social")
      return answer(200, { url: `https://provider.example/${String(body.provider)}` });
    if (path === "/sign-in/email") {
      if (state.signInStatus) return answer(state.signInStatus);
      const { account } = state;
      if (!account || account.person?.email !== body.email || account.password !== body.password)
        return answer(401);
      state.session = { person: account.person, businesses: account.businesses };
      return answer(200);
    }
    return answer(404);
  });
  const handlers: Handlers = {
    "session.get": () => ({ ...state.session, providers: state.providers ?? [] }),
  };
  return { handlers, requests };
};
