import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import {
  answerQuestionSchema,
  buildIdSchema,
  changeRequestSchema,
  editChangeSchema,
  editPlanItemSchema,
  eventsQuerySchema,
  newPlanItemSchema,
  newProjectSchema,
  planItemIdSchema,
  projectIdSchema,
  setFeaturesSchema,
} from "./db/schema.ts";
import { listEvents } from "./services/builds.ts";
import { ConflictError, InterviewUnavailableError, NotFoundError } from "./services/errors.ts";
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

export type Context = Deps & { readonly interviewer: Interviewer };

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
    if (cause instanceof InterviewUnavailableError)
      throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: cause.message, cause });
  }
  return result;
});

export const appRouter = t.router({
  projects: t.router({
    list: procedure.query(({ ctx }) => listProjects(ctx.db)),
    get: procedure.input(projectIdSchema).query(({ ctx, input }) => getProject(ctx.db, input.id)),
    create: procedure
      .input(newProjectSchema)
      .mutation(({ ctx, input }) => createProject(ctx.db, input)),
    setFeatures: procedure
      .input(setFeaturesSchema)
      .mutation(({ ctx, input }) => setFeatures(ctx.db, input)),
    generateSpec: procedure
      .input(projectIdSchema)
      .mutation(({ ctx, input }) => generateSpec(ctx, input.id)),
    approveSpec: procedure
      .input(projectIdSchema)
      .mutation(({ ctx, input }) => approveSpec(ctx, input.id)),
    requestChange: procedure
      .input(changeRequestSchema)
      .mutation(({ ctx, input }) => requestChange(ctx, input)),
    // The deployed app's page title and icon (base64 PNG or ICO); see services/site.ts.
    setSite: procedure.input(siteSchema).mutation(({ ctx, input }) => setSite(ctx, input)),
    stop: procedure.input(projectIdSchema).mutation(({ ctx, input }) => stopProject(ctx, input.id)),
    delete: procedure
      .input(projectIdSchema)
      .mutation(({ ctx, input }) => deleteProject(ctx, input.id)),
  }),
  // The guided questions that build a project's plan; see services/interview.ts.
  interview: t.router({
    get: procedure.input(projectIdSchema).query(({ ctx, input }) => getInterview(ctx.db, input.id)),
    // Asks the first question, or the next one after a turn that failed.
    start: procedure
      .input(projectIdSchema)
      .mutation(({ ctx, input }) => startInterview(ctx, input.id)),
    answer: procedure
      .input(answerQuestionSchema)
      .mutation(({ ctx, input }) => answerQuestion(ctx, input)),
    addItem: procedure
      .input(newPlanItemSchema)
      .mutation(({ ctx, input }) => addPlanItem(ctx.db, input)),
    updateItem: procedure
      .input(editPlanItemSchema)
      .mutation(({ ctx, input }) => updatePlanItem(ctx.db, input)),
    removeItem: procedure
      .input(planItemIdSchema)
      .mutation(({ ctx, input }) => removePlanItem(ctx.db, input)),
  }),
  builds: t.router({
    events: procedure
      .input(eventsQuerySchema)
      .query(({ ctx, input }) => listEvents(ctx.db, input.buildId, input.afterId)),
    // A queued change only; CONFLICT once it has started.
    editQueued: procedure
      .input(editChangeSchema)
      .mutation(({ ctx, input }) => editQueuedChange(ctx.db, input)),
    removeQueued: procedure
      .input(buildIdSchema)
      .mutation(({ ctx, input }) => removeQueuedChange(ctx.db, input.buildId)),
  }),
});

export type AppRouter = typeof appRouter;
