import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import {
  changeRequestSchema,
  eventsQuerySchema,
  newProjectSchema,
  projectIdSchema,
  setFeaturesSchema,
} from "./db/schema.ts";
import { listEvents } from "./services/builds.ts";
import { ConflictError, NotFoundError } from "./services/errors.ts";
import {
  approveSpec,
  createProject,
  generateSpec,
  getProject,
  listProjects,
  requestChange,
  setFeatures,
  stopProject,
  type Deps,
} from "./services/projects.ts";

export type Context = Deps;

const t = initTRPC.context<Context>().create({ transformer: superjson });

const procedure = t.procedure.use(async ({ next }) => {
  const result = await next();
  if (!result.ok) {
    const cause = result.error.cause;
    if (cause instanceof NotFoundError)
      throw new TRPCError({ code: "NOT_FOUND", message: cause.message });
    if (cause instanceof ConflictError)
      throw new TRPCError({ code: "CONFLICT", message: cause.message });
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
    stop: procedure.input(projectIdSchema).mutation(({ ctx, input }) => stopProject(ctx, input.id)),
  }),
  builds: t.router({
    events: procedure
      .input(eventsQuerySchema)
      .query(({ ctx, input }) => listEvents(ctx.db, input.buildId, input.afterId)),
  }),
});

export type AppRouter = typeof appRouter;
