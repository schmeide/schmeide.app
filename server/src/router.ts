import { initTRPC, TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import superjson from "superjson";
import type { z } from "zod";
import {
  acceptInviteSchema,
  ADMIN_ROLE,
  answerQuestionSchema,
  auditQuerySchema,
  buildIdSchema,
  changeRequestSchema,
  editChangeSchema,
  editPlanItemSchema,
  eventsQuerySchema,
  fileIdSchema,
  impersonateSchema,
  inviteTokenSchema,
  newPlanItemSchema,
  newProjectSchema,
  planItemIdSchema,
  projectIdSchema,
  readWebsiteSchema,
  renameFileSchema,
  setFeaturesSchema,
  sessions,
  users,
} from "./db/schema.ts";
import { acceptInvite, getInvite } from "./services/access.ts";
import { auditFilters, listAdminActions, withAudit, type Actor } from "./services/audit.ts";
import {
  currentPerson,
  type Auth,
  type Impersonator,
  type Person,
  type Provider,
} from "./services/auth.ts";
import { assertBuildIn, assertProjectIn, businessesOf } from "./services/businesses.ts";
import { listEvents } from "./services/builds.ts";
import {
  ConflictError,
  InterviewUnavailableError,
  NotFoundError,
  ReaderUnavailableError,
} from "./services/errors.ts";
import type { FileReader } from "./services/fileReader.ts";
import type { FileStore } from "./services/fileStore.ts";
import { deleteFile, listFiles, readFileIntoProposals, renameFile } from "./services/files.ts";
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
    readonly files: FileStore;
    readonly reader: FileReader;
    readonly auth: Auth;
    // The sign-in providers that have credentials, for the sign-in page.
    readonly providers: readonly Provider[];
  };

export type Context = AppContext & {
  readonly headers: Headers;
  // Cookies to set on the answer: sent only when every call in the request succeeded (app.ts),
  // so a session an audit row failed to record never reaches the browser.
  readonly responseCookies: string[];
};

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

// What tRPC itself answers for a path with no procedure behind it.
const noProcedure = (path: string) =>
  new TRPCError({ code: "NOT_FOUND", message: `No procedure found on path "${path}"` });

const actorOf = (admin: Impersonator): Actor => ({ id: admin.id, label: admin.email });

// The header a person in several businesses names the one they are working in with.
export const BUSINESS_HEADER = "x-schmeide-business";

// Everything below `open` needs a signed-in, approved caller, and acts inside one of their
// businesses: the one the header names when they belong to it, otherwise their first.
const open = procedure;
export const SIGN_IN_FIRST = "Sign in to continue";
export const NOT_IN_A_BUSINESS = "You are not in a business";

export const callerOf = async (
  ctx: Pick<AppContext, "auth" | "db">,
  headers: Headers
): Promise<{ readonly person: Person; readonly tenantId: number } | null> => {
  const person = await currentPerson(ctx, headers);
  if (!person) return null;
  const businesses = await businessesOf(ctx.db, person);
  const asked = Number(headers.get(BUSINESS_HEADER));
  const business = businesses.find(({ id }) => id === asked) ?? businesses[0];
  // Only an admin can have none (businessesOf). The uploads route answers this with a 403.
  if (!business) throw new TRPCError({ code: "FORBIDDEN", message: NOT_IN_A_BUSINESS });
  return { person, tenantId: business.id };
};

// While an admin views the app as the person, every write is first recorded against the admin,
// naming the person, the business, and what was called: a procedure path, or "files.upload" for
// the upload route (uploads.ts). Written before the input is read, so an attempt is on record
// even when it is refused.
export const recordWrite = async (
  ctx: Pick<AppContext, "db">,
  { person, tenantId }: { readonly person: Person; readonly tenantId: number },
  what: string
): Promise<void> => {
  const { impersonatedBy } = person;
  if (impersonatedBy)
    await withAudit(ctx.db, actorOf(impersonatedBy), "impersonation.write", async (_tx, audit) =>
      audit({ targetUserId: person.id, targetTenantId: tenantId, detail: what })
    );
};

const signedIn = procedure.use(async ({ ctx, type, path, next }) => {
  const caller = await callerOf(ctx, ctx.headers);
  if (!caller) throw new TRPCError({ code: "UNAUTHORIZED", message: SIGN_IN_FIRST });
  if (type === "mutation") await recordWrite(ctx, caller, path);
  return next({ ctx: { ...ctx, ...caller } });
});

// The only procedures that read across businesses, for people with the platform role. Anyone
// else, signed out included, gets exactly what tRPC answers for a path with no procedure, so the
// admin area cannot be found by asking. It runs before input is read, so input reveals nothing.
const admin = procedure.use(async ({ ctx, path, next }) => {
  const person = await currentPerson(ctx, ctx.headers);
  if (!person?.admin) throw noProcedure(path);
  return next({ ctx: { ...ctx, person } });
});

// For a session an admin views the app through; to anyone else, exactly a missing procedure.
const impersonating = procedure.use(async ({ ctx, path, next }) => {
  const person = await currentPerson(ctx, ctx.headers);
  if (!person?.impersonatedBy) throw noProcedure(path);
  return next({ ctx: { ...ctx, person, impersonator: person.impersonatedBy } });
});

// Refused while an admin views the app as the person: what changes how the person signs in
// (`/api/auth` is refused as a whole in app.ts), and anything that charges money (#82 builds its
// payment procedures with `.use(refuseImpersonation)`).
const refuseImpersonation = t.middleware(async ({ ctx, next }) => {
  if ((await currentPerson(ctx, ctx.headers))?.impersonatedBy)
    throw new TRPCError({ code: "FORBIDDEN", message: "Not while viewing as someone else" });
  return next();
});

// The only way to declare an admin write: `adminMutation("business.suspend").input(...)
// .mutation(({ ctx }) => ...)`. The handler writes through `ctx.db`, a transaction that also
// stores the audit row, and names whom it acted on with `ctx.audit({ targetUserId, ... })`. When
// it throws, neither is stored. audit.test.ts fails for an admin mutation built any other way.
export const adminMutation = (action: string) =>
  admin.use(({ ctx, next }) =>
    withAudit(ctx.db, { id: ctx.person.id, label: ctx.person.email }, action, async (tx, audit) => {
      const result = await next({ ctx: { ...ctx, db: tx, audit } });
      // tRPC hands a failed handler back as a result; throwing it rolls the transaction back.
      if (!result.ok) throw result.error;
      return result;
    })
  );

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
        person: person && {
          name: person.name,
          email: person.email,
          ...(person.admin && { role: "admin" as const }),
        },
        // The admin viewing the app as this person, for the banner; null otherwise.
        impersonatedBy: person?.impersonatedBy
          ? { name: person.impersonatedBy.name, email: person.impersonatedBy.email }
          : null,
        businesses: person ? await businessesOf(ctx.db, person) : [],
        providers: ctx.providers,
      };
    }),
  }),
  // Every procedure here is built on `admin`; admin.test.ts walks them all as a customer.
  admin: t.router({
    whoami: admin.query(({ ctx }) => ({ name: ctx.person.name, email: ctx.person.email })),
    audit: t.router({
      list: admin
        .input(auditQuerySchema)
        .query(({ ctx, input }) => listAdminActions(ctx.db, input)),
      filters: admin.query(({ ctx }) => auditFilters(ctx.db)),
    }),
    impersonation: t.router({
      // Switches the caller to a session as the person, for an hour at most (services/auth.ts).
      // Not another admin, not themselves; from inside a view the caller is no admin at all.
      start: adminMutation("impersonation.start")
        .input(impersonateSchema)
        .mutation(async ({ ctx, input }) => {
          const [person] = await ctx.db
            .select({ id: users.id, name: users.name, email: users.email, role: users.role })
            .from(users)
            .where(eq(users.email, input.email));
          if (!person) throw new NotFoundError("Nobody has an account with that email");
          if (person.role === ADMIN_ROLE || person.id === ctx.person.id)
            throw new TRPCError({ code: "FORBIDDEN", message: "An admin cannot be viewed as" });
          ctx.audit({ targetUserId: person.id, detail: input.reason });
          const { headers } = await ctx.auth.api.impersonateUser({
            body: { userId: person.id },
            headers: ctx.headers,
            returnHeaders: true,
          });
          ctx.responseCookies.push(...headers.getSetCookie());
          return { name: person.name, email: person.email };
        }),
    }),
  }),
  // Outside `admin`: the caller is the person at this point, not an admin.
  impersonation: t.router({
    // Back to the admin's own session, recorded against the admin. When that session has gone,
    // the view still ends, signed out.
    stop: impersonating.mutation(({ ctx }) =>
      withAudit(ctx.db, actorOf(ctx.impersonator), "impersonation.stop", async (tx, audit) => {
        audit({ targetUserId: ctx.person.id });
        try {
          const { headers } = await ctx.auth.api.stopImpersonating({
            headers: ctx.headers,
            returnHeaders: true,
          });
          ctx.responseCookies.push(...headers.getSetCookie());
        } catch {
          await tx
            .delete(sessions)
            .where(
              and(
                eq(sessions.userId, ctx.person.id),
                eq(sessions.impersonatedBy, ctx.impersonator.id)
              )
            );
        }
        return null;
      })
    ),
  }),
  // One-time links that let an approved person set a password; see services/access.ts.
  invites: t.router({
    get: open.input(inviteTokenSchema).query(({ ctx, input }) => getInvite(ctx.db, input.token)),
    accept: open
      .use(refuseImpersonation)
      .input(acceptInviteSchema)
      .mutation(({ ctx, input }) => acceptInvite(ctx, input)),
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
  files: t.router({
    list: onProject(projectIdSchema).query(({ ctx, input }) => listFiles(ctx.db, input.id)),
    rename: onProject(renameFileSchema).mutation(({ ctx, input }) => renameFile(ctx.db, input)),
    delete: onProject(fileIdSchema).mutation(({ ctx, input }) => deleteFile(ctx, input)),
    read: onProject(fileIdSchema).mutation(({ ctx, input }) => readFileIntoProposals(ctx, input)),
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
