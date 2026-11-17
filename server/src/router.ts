import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import type { z } from "zod";
import {
  acceptInviteSchema,
  answerQuestionSchema,
  buildIdSchema,
  changeRequestSchema,
  editChangeSchema,
  editPlanItemSchema,
  eventsQuerySchema,
  inviteTokenSchema,
  newPlanItemSchema,
  newProjectSchema,
  planItemIdSchema,
  projectIdSchema,
  readWebsiteSchema,
  setFeaturesSchema,
} from "./db/schema.ts";
import { acceptInvite, getInvite } from "./services/access.ts";
import { currentPerson, type Auth, type Provider } from "./services/auth.ts";
import { assertBuildIn, assertProjectIn, businessesOf } from "./services/businesses.ts";
import { listEvents } from "./services/builds.ts";
import {
  ConflictError,
  InterviewUnavailableError,
  NotFoundError,
  ReaderUnavailableError,
} from "./services/errors.ts";
import {
  addPlanItem,
  answerQuestion,
  getInterview,
  removePlanItem,
  startInterview,
  updatePlanItem,
  type Interviewer,
} from "./services/interview.ts";
import { siteSchema } from "./services/site.ts";
import { readWebsite, type WebsiteDeps } from "./services/website.ts";
import {
  approveSpec,
  createProject,
  deleteProject,
  editQueuedChange,
  generateSpec,
  getProject,
  listProjects,
  removeQueuedChange,
  requestChange,
  setFeatures,
  setSite,
  stopProject,
  type Deps,
} from "./services/projects.ts";

// What the process holds for every request.
export type AppContext = Deps &
  Omit<WebsiteDeps, "db"> & {
    readonly interviewer: Interviewer;
    readonly auth: Auth;
    // The sign-in providers that have credentials, for the sign-in page.
    readonly providers: readonly Provider[];
  };

export type Context = AppContext & { readonly headers: Headers };

const t = initTRPC.context<Context>().create({ transformer: superjson });

const procedure = t.procedure.use(async ({ next }) => {
  const result = await next();
  if (!result.ok) {
    const cause = result.error.cause;
    if (cause instanceof NotFoundError)
      throw new TRPCError({ code: "NOT_FOUND", message: cause.message });
    if (cause instanceof ConflictError)
      throw new TRPCError({ code: "CONFLICT", message: cause.message, cause });
    // The UI falls back to typed requests, or offers to try again.
    if (cause instanceof InterviewUnavailableError || cause instanceof ReaderUnavailableError)
      throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: cause.message, cause });
  }
  return result;
});

// The header a person in several businesses names the one they are working in with.
export const BUSINESS_HEADER = "x-schmeide-business";

// Everything below `open` needs a signed-in, approved caller, and acts inside one of their
// businesses: the one the header names when they belong to it, otherwise their first.
const open = procedure;
const signedIn = procedure.use(async ({ ctx, next }) => {
  const person = await currentPerson(ctx, ctx.headers);
  if (!person) throw new TRPCError({ code: "UNAUTHORIZED", message: "Sign in to continue" });
  const businesses = await businessesOf(ctx.db, person);
  const asked = Number(ctx.headers.get(BUSINESS_HEADER));
  const business = businesses.find(({ id }) => id === asked) ?? businesses[0];
  return next({ ctx: { ...ctx, person, tenantId: business.id } });
});

// A procedure about one project (`id`) or one build (`buildId`). Either in another business
// answers NOT_FOUND, exactly as one that does not exist.
const onProject = <Schema extends z.ZodType<{ readonly id: number }>>(schema: Schema) =>
  signedIn.input(schema).use(async ({ ctx, input, next }) => {
    await assertProjectIn(ctx.db, ctx.tenantId, input.id);
    return next();
  });
const onBuild = <Schema extends z.ZodType<{ readonly buildId: number }>>(schema: Schema) =>
  signedIn.input(schema).use(async ({ ctx, input, next }) => {
    await assertBuildIn(ctx.db, ctx.tenantId, input.buildId);
    return next();
  });

export const appRouter = t.router({
  session: t.router({
    // Who is calling. Signed out, or taken off the approved list, is a null person.
    get: open.query(async ({ ctx }) => {
      const person = await currentPerson(ctx, ctx.headers);
      return {
        person: person && { name: person.name, email: person.email },
        businesses: person ? await businessesOf(ctx.db, person) : [],
        providers: ctx.providers,
      };
    }),
  }),
  // One-time links that let an approved person set a password; see services/access.ts.
  invites: t.router({
    get: open.input(inviteTokenSchema).query(({ ctx, input }) => getInvite(ctx.db, input.token)),
    accept: open.input(acceptInviteSchema).mutation(({ ctx, input }) => acceptInvite(ctx, input)),
  }),
  projects: t.router({
    list: signedIn.query(({ ctx }) => listProjects(ctx.db, ctx.tenantId)),
    get: onProject(projectIdSchema).query(({ ctx, input }) => getProject(ctx.db, input.id)),
    create: signedIn
      .input(newProjectSchema)
      .mutation(({ ctx, input }) => createProject(ctx.db, { ...input, tenantId: ctx.tenantId })),
    setFeatures: onProject(setFeaturesSchema).mutation(({ ctx, input }) =>
      setFeatures(ctx.db, input)
    ),
    generateSpec: onProject(projectIdSchema).mutation(({ ctx, input }) =>
      generateSpec(ctx, input.id)
    ),
    approveSpec: onProject(projectIdSchema).mutation(({ ctx, input }) =>
      approveSpec(ctx, input.id)
    ),
    requestChange: onProject(changeRequestSchema).mutation(({ ctx, input }) =>
      requestChange(ctx, input)
    ),
    // The deployed app's page title and icon (base64 PNG or ICO); see services/site.ts.
    setSite: onProject(siteSchema).mutation(({ ctx, input }) => setSite(ctx, input)),
    stop: onProject(projectIdSchema).mutation(({ ctx, input }) => stopProject(ctx, input.id)),
    delete: onProject(projectIdSchema).mutation(({ ctx, input }) => deleteProject(ctx, input.id)),
  }),
  // The guided questions that build a project's plan; see services/interview.ts.
  interview: t.router({
    get: onProject(projectIdSchema).query(({ ctx, input }) => getInterview(ctx.db, input.id)),
    // Asks the first question, or the next one after a turn that failed.
    start: onProject(projectIdSchema).mutation(({ ctx, input }) => startInterview(ctx, input.id)),
    answer: onProject(answerQuestionSchema).mutation(({ ctx, input }) =>
      answerQuestion(ctx, input)
    ),
    addItem: onProject(newPlanItemSchema).mutation(({ ctx, input }) => addPlanItem(ctx.db, input)),
    updateItem: onProject(editPlanItemSchema).mutation(({ ctx, input }) =>
      updatePlanItem(ctx.db, input)
    ),
    removeItem: onProject(planItemIdSchema).mutation(({ ctx, input }) =>
      removePlanItem(ctx.db, input)
    ),
  }),
  website: t.router({
    read: onProject(readWebsiteSchema).mutation(({ ctx, input }) =>
      readWebsite(ctx, input, { person: ctx.person, tenantId: ctx.tenantId })
    ),
  }),
  builds: t.router({
    events: onBuild(eventsQuerySchema).query(({ ctx, input }) =>
      listEvents(ctx.db, input.buildId, input.afterId)
    ),
    // A queued change only; CONFLICT once it has started.
    editQueued: onBuild(editChangeSchema).mutation(({ ctx, input }) =>
      editQueuedChange(ctx.db, input)
    ),
    removeQueued: onBuild(buildIdSchema).mutation(({ ctx, input }) =>
      removeQueuedChange(ctx.db, input.buildId)
    ),
  }),
});

export type AppRouter = typeof appRouter;
