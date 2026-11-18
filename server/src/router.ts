import { initTRPC, TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import superjson from "superjson";
import type { z } from "zod";
import {
  acceptInviteSchema,
  accessChangeSchema,
  adminListSchema,
  ADMIN_ROLE,
  answerQuestionSchema,
  auditQuerySchema,
  buildIdSchema,
  businessStateSchema,
  changeRequestSchema,
  deleteAccountSchema,
  editChangeSchema,
  editPlanItemSchema,
  eventsQuerySchema,
  fileIdSchema,
  impersonateSchema,
  inviteTokenSchema,
  newBusinessSchema,
  newPlanItemSchema,
  newProjectSchema,
  periodSchema,
  planItemIdSchema,
  projectIdSchema,
  projectIdsSchema,
  readWebsiteSchema,
  removeMemberSchema,
  renameAccountSchema,
  renameFileSchema,
  setFeaturesSchema,
  signInMethodIdSchema,
  sessions,
  tenantIdSchema,
  usageQuerySchema,
  users,
} from "./db/schema.ts";
import {
  acceptInvite,
  approveAccess,
  createBusiness,
  getInvite,
  joinByInvite,
  grantAdminRole,
  listAdmins,
  removeAccess,
  revokeAdmin,
} from "./services/access.ts";
import {
  deleteAccount,
  disconnectMethod,
  exportAccount,
  getAccount,
  renameAccount,
  signOutOthers,
} from "./services/account.ts";
import { auditFilters, listAdminActions, withAudit, type Actor } from "./services/audit.ts";
import {
  currentPerson,
  type Auth,
  type Impersonator,
  type Person,
  type Provider,
} from "./services/auth.ts";
import {
  assertBuildIn,
  assertProjectIn,
  businessesOf,
  roleIn,
  removeMember,
  setBusinessState,
  startBusiness,
  startBusinessSchema,
} from "./services/businesses.ts";
import { buildListSchema, listBuilds, listEvents } from "./services/builds.ts";
import { listSummaries } from "./services/summaries.ts";
import {
  getBusiness,
  hostedResources,
  listBusinesses,
  listHostedProjects,
  listPeople,
} from "./services/directory.ts";
import {
  BUILDS_OFF,
  BUSINESS_SUSPENDED,
  BadInputError,
  BusinessSuspendedError,
  ConflictError,
  ForbiddenError,
  InterviewUnavailableError,
  NotFoundError,
  ReaderUnavailableError,
} from "./services/errors.ts";
import type { FileReader } from "./services/fileReader.ts";
import type { FileStore } from "./services/fileStore.ts";
import type { ResourceReader } from "./services/resources.ts";
import {
  closeReviewSchema,
  listReviewItems,
  pageReviewItems,
  reviewListSchema,
  reviewOpen,
  writeClosure,
} from "./services/review.ts";
import { businessTime, usageSummary } from "./services/usageSummary.ts";
import { deleteFile, listFiles, readFileIntoProposals, renameFile } from "./services/files.ts";
import {
  addPlanItem,
  answerQuestion,
  depthSchema,
  getInterview,
  removePlanItem,
  restartInterview,
  restartInterviewSchema,
  setInterviewDepth,
  startInterview,
  startInterviewSchema,
  updatePlanItem,
  type Interviewer,
} from "./services/interview.ts";
import {
  correctReadBack,
  correctReadBackSchema,
  getReadBack,
  writeReadBack,
  type ReadBackWriter,
} from "./services/readBack.ts";
import {
  getBusiness as getOwnBusiness,
  invitationSchema,
  inviteToBusiness,
  memberRoleSchema,
  memberSchema,
  reissueInvitation,
  removeMember as removeFromBusiness,
  setMemberRole,
  transferOwnership,
  updateBusiness,
  updateBusinessSchema,
  withdrawInvitation,
} from "./services/members.ts";
import { siteSchema } from "./services/site.ts";
import { getDesign, pickLook, pickLookSchema } from "./services/designs.ts";
import { readWebsite, type WebsiteDeps } from "./services/website.ts";
import {
  approveSpec,
  buildWaitingChanges,
  createProject,
  deleteProject,
  discardStaging,
  editQueuedChange,
  generateSpec,
  getProject,
  listProjects,
  promoteStaging,
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
    // Absent (as in most tests), the read-back cannot be written; see services/readBack.ts.
    readonly readBackWriter?: ReadBackWriter;
    readonly files: FileStore;
    readonly reader: FileReader;
    // What hosted projects take up, read from the container runtime and the disk when asked.
    readonly resources: ResourceReader;
    // Review records live under this directory (services/review.ts). Absent in tests that
    // never open the review list: it is empty, and closing an item is not found.
    readonly dataDir?: string;
    readonly auth: Auth;
    // The sign-in providers that have credentials, for the sign-in page.
    readonly providers: readonly Provider[];
    // SCHMEIDE_BUILDS=admins: builds are on for platform admins and off for everyone else.
    readonly buildsAdminsOnly?: boolean;
    // The design team (SCHMEIDE_DESIGN_TEAM); absent is off.
    readonly designTeam?: boolean;
  };

// Whether this caller may build: never with builds off, and with builds for admins only, only a
// platform admin. An admin viewing as a customer is not one then (auth.ts), so builds nothing.
const canBuild = (ctx: AppContext, person: Person): boolean =>
  !ctx.buildsOff && (!ctx.buildsAdminsOnly || person.admin);

export type Context = AppContext & {
  readonly headers: Headers;
  // Cookies to set on the answer: sent only when every call in the request succeeded (app.ts),
  // so a session an audit row failed to record never reaches the browser.
  readonly responseCookies: string[];
};

// Stack traces in error responses are opt-in (SCHMEIDE_ENV=development, set by the Makefile), never
// inferred from NODE_ENV, so a deployed image cannot leak file paths by accident.
const t = initTRPC.context<Context>().create({
  transformer: superjson,
  isDev: process.env.SCHMEIDE_ENV === "development",
});

const procedure = t.procedure.use(async ({ next }) => {
  const result = await next();
  if (!result.ok) {
    const cause = result.error.cause;
    if (cause instanceof NotFoundError)
      throw new TRPCError({ code: "NOT_FOUND", message: cause.message });
    if (cause instanceof BadInputError)
      throw new TRPCError({ code: "BAD_REQUEST", message: cause.message, cause });
    if (cause instanceof ConflictError)
      throw new TRPCError({ code: "CONFLICT", message: cause.message, cause });
    if (cause instanceof ForbiddenError)
      throw new TRPCError({ code: "FORBIDDEN", message: cause.message, cause });
    if (cause instanceof BusinessSuspendedError) throw suspended();
    // The UI falls back to typed requests, or offers to try again.
    if (cause instanceof InterviewUnavailableError || cause instanceof ReaderUnavailableError)
      throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: cause.message, cause });
  }
  return result;
});

// What tRPC itself answers for a path with no procedure behind it.
const noProcedure = (path: string) =>
  new TRPCError({ code: "NOT_FOUND", message: `No procedure found on path "${path}"` });

// What a member of a suspended business is answered: a code of its own, so the client shows the
// suspended page rather than an error.
const suspended = () => new TRPCError({ code: "PRECONDITION_FAILED", message: BUSINESS_SUSPENDED });

const actorOf = (admin: Impersonator): Actor => ({ id: admin.id, label: admin.email });

// The header a person in several businesses names the one they are working in with.
export const BUSINESS_HEADER = "x-schmeide-business";

// Everything below `open` needs a signed-in, approved caller, and acts inside one of their
// businesses: the one the header names when they belong to it, otherwise their first that is not
// suspended. A suspended one is refused here, for tRPC and the uploads route alike, and so for an
// admin viewing the app as a member too.
const open = procedure;
export const SIGN_IN_FIRST = "Sign in to continue";
export const NOT_IN_A_BUSINESS = "You are not in a business";

// The business the person works in: the one the header names when they belong to it, otherwise
// their first that is not suspended. None for someone not yet through first-run setup, or an admin.
const workingIn = async (ctx: Pick<AppContext, "db">, person: Person, headers: Headers) => {
  const businesses = await businessesOf(ctx.db, person);
  const asked = Number(headers.get(BUSINESS_HEADER));
  return (
    businesses.find(({ id }) => id === asked) ??
    businesses.find(({ suspended }) => !suspended) ??
    businesses[0]
  );
};

export const callerOf = async (
  ctx: Pick<AppContext, "auth" | "db">,
  headers: Headers
): Promise<{ readonly person: Person; readonly tenantId: number } | null> => {
  const person = await currentPerson(ctx, headers);
  if (!person) return null;
  const business = await workingIn(ctx, person, headers);
  // Someone not yet through first-run setup, or an admin, has none (businessesOf). The uploads
  // route answers both with a 403.
  if (!business) throw new TRPCError({ code: "FORBIDDEN", message: NOT_IN_A_BUSINESS });
  if (business.suspended) throw suspended();
  return { person, tenantId: business.id };
};

// While an admin views the app as the person, every write is first recorded against the admin,
// naming the person, the business, and what was called: a procedure path, or "files.upload" for
// the upload route (uploads.ts). Written before the input is read, so an attempt is on record
// even when it is refused.
export const recordWrite = async (
  ctx: Pick<AppContext, "db">,
  { person, tenantId }: { readonly person: Person; readonly tenantId: number | null },
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

// About the signed-in person, not a business, so it works before first-run setup too: their own
// account. Writes while an admin views as them are recorded against the business they work in,
// or none when they have none.
const personal = procedure.use(async ({ ctx, type, path, next }) => {
  const person = await currentPerson(ctx, ctx.headers);
  if (!person) throw new TRPCError({ code: "UNAUTHORIZED", message: SIGN_IN_FIRST });
  if (type === "mutation") {
    const business = await workingIn(ctx, person, ctx.headers);
    await recordWrite(ctx, { person, tenantId: business?.id ?? null }, path);
  }
  return next({ ctx: { ...ctx, person } });
});

// For a signed-in person who may be in no business yet: first-run setup. Viewing as someone is
// recorded like every write, then refused: the person would find a business they did not make.
const newcomer = procedure.use(async ({ ctx, path, next }) => {
  const person = await currentPerson(ctx, ctx.headers);
  if (!person) throw new TRPCError({ code: "UNAUTHORIZED", message: SIGN_IN_FIRST });
  if (person.impersonatedBy) {
    await recordWrite(ctx, { person, tenantId: null }, path);
    throw new TRPCError({ code: "FORBIDDEN", message: "Not while viewing as someone else" });
  }
  return next({ ctx: { ...ctx, person } });
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
// (`/auth` is refused as a whole in app.ts; the account's sign-in methods, devices and deletion
// here), and anything that charges money (#82 builds its
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

const ownerOnly = signedIn.use(async ({ ctx, next }) => {
  if ((await roleIn(ctx.db, ctx.tenantId, ctx.person.id)) !== "owner")
    throw new TRPCError({
      code: "FORBIDDEN",
      message:
        "Only an owner of this business can do this. Ask an owner to do it, or to make you an owner.",
    });
  return next();
});

// A procedure about one project (`id`) or one build (`buildId`). Either in another business
// answers NOT_FOUND, exactly as one that does not exist.
const onProject = <Schema extends z.ZodType<{ readonly id: number }>>(schema: Schema) =>
  signedIn.input(schema).use(async ({ ctx, input, next }) => {
    await assertProjectIn(ctx.db, ctx.tenantId, input.id);
    return next();
  });
// A procedure about one project that builds, deploys, or stops it. A caller who may not build gets
// the services as with builds off, so exactly what builds off answers.
const building = <Schema extends z.ZodType<{ readonly id: number }>>(schema: Schema) =>
  onProject(schema).use(({ ctx, next }) =>
    next({ ctx: { ...ctx, buildsOff: !canBuild(ctx, ctx.person) } })
  );
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
        // SCHMEIDE_BUILDS=off: the server hosts nothing, for the admin resources pages.
        buildsOff: ctx.buildsOff ?? false,
        // When false, the client offers this caller no build, and says why.
        canBuild: person !== null && canBuild(ctx, person),
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
    // Flagged requests, tier changes, refused uploads, app reports, and repeated refusals.
    review: t.router({
      list: admin.input(reviewListSchema).query(async ({ ctx, input }) => {
        const items = ctx.dataDir ? await listReviewItems(ctx.db, ctx.dataDir) : [];
        return pageReviewItems(items, input.cursor, input.limit);
      }),
      open: admin.query(async ({ ctx }) =>
        reviewOpen(ctx.dataDir ? await listReviewItems(ctx.db, ctx.dataDir) : [])
      ),
      close: adminMutation("review.close")
        .input(closeReviewSchema)
        .mutation(async ({ ctx, input }) => {
          if (!ctx.dataDir) throw new NotFoundError("That review item does not exist");
          const items = await listReviewItems(ctx.db, ctx.dataDir);
          const item = items.find((entry) => entry.id === input.id);
          if (!item) throw new NotFoundError("That review item does not exist");
          const recorded = await writeClosure(
            ctx.dataDir,
            item,
            { disposition: input.disposition, reason: input.reason },
            ctx.person.email
          );
          ctx.audit({ targetTenantId: recorded.targetTenantId, detail: recorded.detail });
          return null;
        }),
    }),
    // Every business and every person, read-only; see services/directory.ts.
    businesses: t.router({
      list: admin.input(adminListSchema).query(({ ctx, input }) => listBusinesses(ctx.db, input)),
      get: admin.input(tenantIdSchema).query(({ ctx, input }) => getBusiness(ctx.db, input.id)),
      // The owner's set-password link is answered here once, only when they have no account yet.
      create: adminMutation("business.create")
        .input(newBusinessSchema)
        .mutation(async ({ ctx, input }) => {
          const { id, created, email, hasAccount, token } = await createBusiness(
            ctx.db,
            ctx.audit,
            input
          );
          return { id, created, email, hasAccount, token: hasAccount ? null : token };
        }),
      removeMember: adminMutation("business.removeMember")
        .input(removeMemberSchema)
        .mutation(({ ctx, input }) => removeMember(ctx.db, ctx.audit, input)),
      // Its members cannot open it and nothing in it builds; its live apps keep running.
      suspend: adminMutation("business.suspend")
        .input(businessStateSchema)
        .mutation(({ ctx, input }) => setBusinessState(ctx.db, ctx.audit, input, "suspended")),
      restore: adminMutation("business.restore")
        .input(businessStateSchema)
        .mutation(({ ctx, input }) => setBusinessState(ctx.db, ctx.audit, input, "active")),
    }),
    people: t.router({
      list: admin.input(adminListSchema).query(({ ctx, input }) => listPeople(ctx.db, input)),
    }),
    // The approved list, as `make access/approve` and `access/remove` change it.
    access: t.router({
      // Approves an address, again or for the first time. The set-password link is answered here
      // once, only for someone with no account yet; anyone else signs in as before.
      approve: adminMutation("access.approve")
        .input(accessChangeSchema)
        .mutation(async ({ ctx, input }) => {
          const { email, hasAccount, token } = await approveAccess(ctx.db, ctx.audit, input.email, {
            reason: input.reason,
          });
          return { email, hasAccount, token: hasAccount ? null : token };
        }),
      // Takes the address off the list and signs them out everywhere. Not an admin, the caller
      // included: that would take the admin area from them without the checks of taking the role.
      remove: adminMutation("access.remove")
        .input(accessChangeSchema)
        .mutation(async ({ ctx, input }) => {
          const [target] = await ctx.db
            .select({ role: users.role })
            .from(users)
            .where(eq(users.email, input.email));
          if (target?.role === ADMIN_ROLE)
            throw new TRPCError({
              code: "FORBIDDEN",
              message: "An admin's access cannot be removed here",
            });
          return removeAccess(ctx.db, ctx.audit, input.email, input.reason);
        }),
    }),
    // Who has the platform role, and making and unmaking admins; see services/access.ts.
    admins: t.router({
      list: admin.query(({ ctx }) => listAdmins(ctx.db)),
      // Someone with no account yet is approved, their link answered here once, and they are an
      // admin from their first sign-in.
      grant: adminMutation("admin.grant")
        .input(accessChangeSchema)
        .mutation(({ ctx, input }) =>
          grantAdminRole(ctx.db, ctx.audit, input.email, { reason: input.reason, invite: true })
        ),
      // Not your own role, and not the last admin's. Ends their sessions and views.
      revoke: adminMutation("admin.revoke")
        .input(accessChangeSchema)
        .mutation(({ ctx, input }) =>
          revokeAdmin(ctx.db, ctx.audit, { ...input, byId: ctx.person.id })
        ),
    }),
    // The list answers from the database alone; what each project takes up is a second call, so
    // a slow or missing container runtime never holds the list back.
    projects: t.router({
      list: admin
        .input(adminListSchema)
        .query(({ ctx, input }) => listHostedProjects(ctx.db, input)),
      resources: admin
        .input(projectIdsSchema)
        .query(({ ctx, input }) => hostedResources(ctx, input.ids)),
    }),
    // Tokens and cost per business, project, model, and kind of run; see services/usageSummary.ts.
    usage: t.router({
      summary: admin.input(usageQuerySchema).query(({ ctx, input }) => usageSummary(ctx.db, input)),
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
  // The signed-in person's own account; see services/account.ts.
  account: t.router({
    get: personal.query(({ ctx }) => getAccount(ctx, ctx.person, ctx.headers)),
    rename: personal
      .input(renameAccountSchema)
      .mutation(({ ctx, input }) => renameAccount(ctx.db, ctx.person, input)),
    disconnect: personal
      .use(refuseImpersonation)
      .input(signInMethodIdSchema)
      .mutation(({ ctx, input }) => disconnectMethod(ctx, ctx.person, input, ctx.headers)),
    signOutOthers: personal
      .use(refuseImpersonation)
      .mutation(({ ctx }) => signOutOthers(ctx, ctx.headers)),
    export: personal.query(({ ctx }) => exportAccount(ctx, ctx.person, ctx.headers)),
    delete: personal
      .use(refuseImpersonation)
      .input(deleteAccountSchema)
      .mutation(({ ctx, input }) => deleteAccount(ctx.db, ctx.person, input)),
  }),
  // One-time links that let an approved person set a password; see services/access.ts.
  // `next` arrives with the token (a path on this site) and is not stored: the page reads it
  // back from the address after the password is set, so `/go` can run again.
  invites: t.router({
    get: open.input(inviteTokenSchema).query(({ ctx, input }) => getInvite(ctx.db, input.token)),
    accept: open
      .use(refuseImpersonation)
      .input(acceptInviteSchema)
      .mutation(({ ctx, input }) =>
        acceptInvite(ctx, { token: input.token, name: input.name, password: input.password })
      ),
    join: signedIn
      .use(refuseImpersonation)
      .input(inviteTokenSchema)
      .mutation(({ ctx, input }) => joinByInvite(ctx.db, ctx.person, input.token)),
  }),
  // First-run setup, for a person in no business yet; see services/businesses.ts.
  setup: t.router({
    createBusiness: newcomer
      .input(startBusinessSchema)
      .mutation(({ ctx, input }) => startBusiness(ctx.db, ctx.person.id, input)),
  }),
  business: t.router({
    get: signedIn.query(({ ctx }) => getOwnBusiness(ctx.db, ctx.tenantId, ctx.person.id)),
    update: ownerOnly
      .input(updateBusinessSchema)
      .mutation(({ ctx, input }) => updateBusiness(ctx.db, ctx.tenantId, input)),
    invite: ownerOnly
      .input(invitationSchema)
      .mutation(({ ctx, input }) => inviteToBusiness(ctx.db, ctx.tenantId, input.email)),
    reissueInvitation: ownerOnly
      .input(invitationSchema)
      .mutation(({ ctx, input }) => reissueInvitation(ctx.db, ctx.tenantId, input.email)),
    withdrawInvitation: ownerOnly
      .input(invitationSchema)
      .mutation(({ ctx, input }) => withdrawInvitation(ctx.db, ctx.tenantId, input.email)),
    removeMember: ownerOnly
      .input(memberSchema)
      .mutation(({ ctx, input }) => removeFromBusiness(ctx.db, ctx.tenantId, input.userId)),
    leave: signedIn.mutation(({ ctx }) => removeFromBusiness(ctx.db, ctx.tenantId, ctx.person.id)),
    setRole: ownerOnly
      .input(memberRoleSchema)
      .mutation(({ ctx, input }) => setMemberRole(ctx.db, ctx.tenantId, input)),
    transferOwnership: ownerOnly
      .input(memberSchema)
      .mutation(({ ctx, input }) =>
        transferOwnership(ctx.db, ctx.tenantId, ctx.person.id, input.userId)
      ),
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
    approveSpec: building(projectIdSchema).mutation(({ ctx, input }) => approveSpec(ctx, input.id)),
    requestChange: building(changeRequestSchema).mutation(({ ctx, input }) =>
      requestChange(ctx, input)
    ),
    // The deployed app's page title and icon (base64 PNG or ICO); see services/site.ts.
    setSite: building(siteSchema).mutation(({ ctx, input }) => setSite(ctx, input)),
    // Production runs what staging runs; or staging goes back to what production runs. Each is a
    // build of its own, recorded with who asked.
    promote: building(projectIdSchema).mutation(({ ctx, input }) =>
      promoteStaging(ctx, { id: input.id, byUserId: ctx.person.id })
    ),
    discard: building(projectIdSchema).mutation(({ ctx, input }) =>
      discardStaging(ctx, { id: input.id, byUserId: ctx.person.id })
    ),
    // After a failed or canceled build; CONFLICT while one runs.
    buildWaiting: building(projectIdSchema).mutation(({ ctx, input }) =>
      buildWaitingChanges(ctx, input.id)
    ),
    stop: building(projectIdSchema).mutation(({ ctx, input }) => stopProject(ctx, input.id)),
    delete: onProject(projectIdSchema).mutation(({ ctx, input }) => deleteProject(ctx, input.id)),
  }),
  // The guided questions that build a project's plan; see services/interview.ts.
  interview: t.router({
    get: onProject(projectIdSchema).query(({ ctx, input }) => getInterview(ctx.db, input.id)),
    // Asks the first question, or the next one after a turn that failed.
    start: onProject(startInterviewSchema).mutation(({ ctx, input }) =>
      startInterview(ctx, input.id, input.depth)
    ),
    // A quick sketch or the thorough interview; it can change at any time.
    setDepth: onProject(depthSchema).mutation(({ ctx, input }) => setInterviewDepth(ctx.db, input)),
    // New wording of the prompt: clears the questions and the plan, and asks the first one again.
    restart: onProject(restartInterviewSchema).mutation(({ ctx, input }) =>
      restartInterview(ctx, input)
    ),
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
  // What was understood, said back before the spec is written; see services/readBack.ts.
  readBack: t.router({
    get: onProject(projectIdSchema).query(({ ctx, input }) => getReadBack(ctx.db, input.id)),
    // Writes the account from the plan if there is none yet.
    write: onProject(projectIdSchema).mutation(({ ctx, input }) => writeReadBack(ctx, input.id)),
    // One answer about a sentence marked wrong, or an open point.
    correct: onProject(correctReadBackSchema).mutation(({ ctx, input }) =>
      correctReadBack(ctx, input)
    ),
  }),
  // The look of the app: the one it has and why, and picking another; see services/designs.ts.
  design: t.router({
    get: onProject(projectIdSchema).query(({ ctx, input }) => getDesign(ctx, input.id)),
    pick: building(pickLookSchema).mutation(({ ctx, input }) => pickLook(ctx, input)),
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
  // The caller's business's building and builder time for a period (all time when none is given),
  // for the usage page.
  usage: t.router({
    time: signedIn
      .input(periodSchema.default({}))
      .query(({ ctx, input }) => businessTime(ctx.db, ctx.tenantId, input)),
  }),
  builds: t.router({
    // A project's builds that have started, newest first, a page at a time, each with its cost.
    list: onProject(buildListSchema).query(({ ctx, input }) => listBuilds(ctx.db, input)),
    events: onBuild(eventsQuerySchema).query(({ ctx, input }) =>
      listEvents(ctx.db, input.buildId, input.afterId)
    ),
    // The plain-language account of the build so far, oldest first; services/summaries.ts.
    summaries: onBuild(buildIdSchema).query(({ ctx, input }) =>
      listSummaries(ctx.db, input.buildId)
    ),
    // A queued change only; CONFLICT once it has started.
    // Rewriting a queued change is requesting one, so only for a caller who may build.
    editQueued: onBuild(editChangeSchema).mutation(({ ctx, input }) => {
      if (!canBuild(ctx, ctx.person)) throw new ConflictError(BUILDS_OFF);
      return editQueuedChange(ctx.db, input);
    }),
    removeQueued: onBuild(buildIdSchema).mutation(({ ctx, input }) =>
      removeQueuedChange(ctx.db, input.buildId)
    ),
  }),
});

export type AppRouter = typeof appRouter;
