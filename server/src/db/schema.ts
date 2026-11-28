import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
  varchar,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { VERDICTS, type AcceptancePlan } from "../services/acceptance.ts";
import { DESIGN_CHOOSERS, type DesignBrief } from "../services/designBrief.ts";

// Tables are the single source: validation and API types derive from them.

// `suspended`: its members cannot open it and nothing in it builds, while its live apps keep
// running (docs/auth.md). An admin suspends one with a reason; #82 suspends an unpaid one the same
// way, with its own reason.
export const TENANT_STATES = ["active", "suspended"] as const;
export const tenantState = pgEnum("tenant_state", TENANT_STATES);

// A business, in customer copy. Everything a person makes belongs to one; `memberships` says who
// may work in it. `demo` (made by `make db/seed`) holds what was built before sign-in existed.
export const tenants = pgTable("tenants", {
  id: serial("id").primaryKey(),
  slug: varchar("slug", { length: 64 }).notNull().unique(),
  name: varchar("name", { length: 120 }).notNull().default(""),
  state: tenantState("state").notNull().default("active"),
  // Why and when the state last changed; null for a business that has never changed state.
  stateReason: text("state_reason"),
  stateChangedAt: timestamp("state_changed_at", { withTimezone: true }),
  country: varchar("country", { length: 2 }),
  // What the business does, in its own words: one optional line from first-run setup.
  description: varchar("description", { length: 200 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const projectStatus = pgEnum("project_status", [
  "draft",
  "spec_generating",
  "spec_ready",
  "building",
  "live",
  "failed",
  "stopped",
]);

// Why the last spec run failed: the server's Claude login, Claude's usage limit, a run that took
// too long, a suspended business, or anything else. The page says what to do about each.
export const SPEC_FAILURES = [
  "claude_login",
  "usage_limit",
  "timed_out",
  "suspended",
  "unknown",
] as const;
export type SpecFailure = (typeof SPEC_FAILURES)[number];

export const projects = pgTable(
  "projects",
  {
    id: serial("id").primaryKey(),
    tenantId: integer("tenant_id")
      .notNull()
      .references(() => tenants.id),
    slug: varchar("slug", { length: 48 }).notNull().unique(),
    name: varchar("name", { length: 100 }).notNull(),
    status: projectStatus("status").notNull().default("draft"),
    need: text("need").notNull().default(""),
    features: text("features").notNull().default(""),
    spec: text("spec"),
    // Null unless the last spec run failed; cleared when a run starts or writes the spec.
    specError: varchar("spec_error", { length: 32 }).$type<SpecFailure>(),
    webPort: integer("web_port").notNull().unique(),
    // The deployed app's <title>; null means the project name.
    pageTitle: varchar("page_title", { length: 100 }),
    // The business's own colors, from reading its website (services/website.ts), most important
    // first. The design lead uses the first that passes contrast (services/designBrief.ts).
    brandColors: jsonb("brand_colors").$type<readonly string[]>().notNull().default([]),
    // The template's app shapes the first build kept (services/shapes.ts), the home page first.
    // Empty until a workspace is prepared, and for a template with no shapes.
    shapes: jsonb("shapes").$type<readonly string[]>().notNull().default([]),
    // Production, the copy the app's own customers use: its address while it runs, and the commit
    // it runs from its own checkout (null for an app deployed before there was one).
    previewUrl: text("preview_url"),
    productionCommit: varchar("production_commit", { length: 40 }),
    // Staging, the copy every build deploys to and the designer shows (services/resources.ts).
    stagingUrl: text("staging_url"),
    stagingCommit: varchar("staging_commit", { length: 40 }),
    // SCHMEIDE_RUNNER=kubernetes: the first label of production's address on the apps domain,
    // <slug>-<6 random>, chosen on the first deploy (docs/stage2.md, "Previews and domains").
    host: varchar("host", { length: 63 }).unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // Staging's port is the web port plus STAGING_PORT_OFFSET, so no web port may reach it.
    check("projects_web_port_below_staging", sql`${table.webPort} < 18100`),
  ]
);

// `site`: applies the page title and icon and redeploys, without the agent. `promote` makes
// production run staging's commit, `discard` returns staging to production's, and `rollback` puts
// an earlier version live; none runs the builder, and each is asked for by a person (`byUserId`).
export const buildKind = pgEnum("build_kind", [
  "initial",
  "change",
  "site",
  "promote",
  "discard",
  "rollback",
]);
// What became of a passed build's work: put live on production, or thrown away from staging.
// Null while it is on staging only. It is history ("was promoted"), not what is live now: after a
// roll back, live is `projects.production_commit`, whatever the flag says.
export const buildRelease = pgEnum("build_release", ["promoted", "discarded"]);
// `queued`: a change waiting for the project's running build; it starts once that one passes.
// `canceled`: the person stopped the build. Nothing failed, so there is no error message.
export const buildStatus = pgEnum("build_status", [
  "queued",
  "running",
  "passed",
  "failed",
  "canceled",
]);

export const builds = pgTable(
  "builds",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id),
    kind: buildKind("kind").notNull(),
    request: text("request").notNull(),
    status: buildStatus("status").notNull().default("running"),
    error: text("error"),
    // The full commit of the project's repository this build deployed; null until it has. For
    // `promote` and `discard`, the commit it moves its copy to.
    commit: varchar("commit", { length: 40 }),
    // The project's version, from 1. Null until a passed `initial`, `change`, or `site` build has
    // a commit of its own. `promote` and `discard` move a copy and get no number.
    version: integer("version"),
    // The commit the workspace was on when this build was prepared, before the builder ran.
    // Null for the first build, which starts from the template commit.
    baseCommit: varchar("base_commit", { length: 40 }),
    release: buildRelease("release"),
    // Whether this version's migrations only add to the database (schmeide/template#25), so an
    // earlier version can still read it. True when the checks passed with the template's
    // check/migrations; null (unknown) for an app whose template has none.
    additive: boolean("additive"),
    // A `rollback` that goes back with the information from a day: the copy it restores.
    fromCopyId: integer("from_copy_id").references((): AnyPgColumn => databaseCopies.id, {
      onDelete: "set null",
    }),
    byUserId: text("by_user_id").references(() => users.id, { onDelete: "set null" }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [uniqueIndex("builds_project_version_idx").on(table.projectId, table.version)]
);

// A copy of the live app's database, taken just before a promote or a roll back moves production
// (#227). `version` was live when it was taken; null for a live commit that has no number.
export const databaseCopies = pgTable("database_copies", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id")
    .notNull()
    .references(() => projects.id),
  buildId: integer("build_id")
    .notNull()
    .references(() => builds.id),
  version: integer("version"),
  takenAt: timestamp("taken_at", { withTimezone: true }).notNull().defaultNow(),
  path: text("path").notNull(),
  bytes: bigint("bytes", { mode: "number" }).notNull(),
});
export type DatabaseCopy = typeof databaseCopies.$inferSelect;

// Kept out of projects so project rows, polled by the UI, stay small.
export const projectIcons = pgTable("project_icons", {
  projectId: integer("project_id")
    .primaryKey()
    .references(() => projects.id),
  // Base64 of a PNG or ICO, checked by siteSchema.
  data: text("data").notNull(),
});

// What a passed build's home page looked like once staging answered (#229), at a desktop and a
// phone width. Kept out of builds for the same reason icons are kept out of projects.
// ponytail: a row in Postgres; blob storage (#195) in production.
export const pictureWidth = pgEnum("picture_width", ["desktop", "phone"]);
export type PictureWidth = (typeof pictureWidth.enumValues)[number];

export const versionPictures = pgTable(
  "version_pictures",
  {
    buildId: integer("build_id")
      .notNull()
      .references(() => builds.id, { onDelete: "cascade" }),
    width: pictureWidth("width").notNull(),
    // Base64 of a WebP no wider than 640 px.
    data: text("data").notNull(),
  },
  (table) => [primaryKey({ columns: [table.buildId, table.width] })]
);

export const buildEventKind = pgEnum("build_event_kind", [
  "step",
  "agent",
  "check",
  "deploy",
  "error",
  // A Skill the builder ran, named by the message (#341).
  "skill",
  // Something worth knowing that does not fail the build.
  "warning",
]);

export const buildEvents = pgTable("build_events", {
  id: serial("id").primaryKey(),
  buildId: integer("build_id")
    .notNull()
    .references(() => builds.id),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  kind: buildEventKind("kind").notNull(),
  message: text("message").notNull(),
});

// What a model run is for. It labels the run's usage, and for every kind but `interview`,
// `website`, `read` and `summary` it decides the run's model (agentModel.ts). `summary` is
// Schmeide's own running account of a build (services/summaries.ts): it is not counted against the
// customer.
export const agentRunKind = pgEnum("agent_run_kind", [
  "spec",
  "initial",
  "change",
  "interview",
  "website",
  "read",
  "summary",
  "design",
  "review",
  "acceptance",
]);

// A plain-language account of a build, written as it runs from its events (services/summaries.ts).
// Each covers the events up to and including throughEventId; the `final` one is written once the
// build has ended. Stored as plain text and shown only as text.
export const buildSummaries = pgTable(
  "build_summaries",
  {
    id: serial("id").primaryKey(),
    buildId: integer("build_id")
      .notNull()
      .references(() => builds.id),
    throughEventId: integer("through_event_id").notNull(),
    final: boolean("final").notNull().default(false),
    text: text("text").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("build_summaries_build_id_idx").on(table.buildId)]
);

// One row per agent run: how long the model ran, as the SDK's result reports it. A run's tokens and
// cost are its `usage` rows, one per model, so the time is kept once here rather than on each.
export const agentRuns = pgTable("agent_runs", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id")
    .notNull()
    .references(() => projects.id),
  buildId: integer("build_id").references(() => builds.id),
  runKind: agentRunKind("run_kind").notNull(),
  durationMs: integer("duration_ms").notNull(),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
});

// One row per model per agent run. buildId is null for spec generation and interview questions. model is what the run
// used, as the SDK reports it; runKind is what the run was, so cost can be compared per kind.
export const usage = pgTable("usage", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id")
    .notNull()
    .references(() => projects.id),
  buildId: integer("build_id").references(() => builds.id),
  // Null for rows recorded before runs were: their run's time is not known.
  runId: integer("run_id").references(() => agentRuns.id),
  runKind: agentRunKind("run_kind").notNull(),
  model: text("model").notNull(),
  inputTokens: integer("input_tokens").notNull(),
  outputTokens: integer("output_tokens").notNull(),
  cacheReadTokens: integer("cache_read_tokens").notNull(),
  cacheCreationTokens: integer("cache_creation_tokens").notNull(),
  costUsd: doublePrecision("cost_usd").notNull(),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
});

export const designChooser = pgEnum("design_chooser", DESIGN_CHOOSERS);

// The look of a project's app (services/designBrief.ts): made once, on its first build with the
// design team on, or when the person picks a look, and kept for every build after it.
export const projectDesigns = pgTable("project_designs", {
  projectId: integer("project_id")
    .primaryKey()
    .references(() => projects.id),
  style: varchar("style", { length: 32 }).notNull(),
  chosenBy: designChooser("chosen_by").notNull(),
  brief: jsonb("brief").$type<DesignBrief>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

// The acceptance checks of a project's app (services/acceptance.ts): written from the spec before
// its first build and added to by every change. specHash is the spec they were written from, so
// a first build from another spec writes them again.
export const projectAcceptance = pgTable("project_acceptance", {
  projectId: integer("project_id")
    .primaryKey()
    .references(() => projects.id),
  specHash: varchar("spec_hash", { length: 64 }).notNull(),
  plan: jsonb("plan").$type<AcceptancePlan>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const acceptanceVerdict = pgEnum("acceptance_verdict", VERDICTS);

// What the tester found for each acceptance check of a build (#356), from the last time it
// followed them: a fix round's results replace the round before.
export const buildAcceptance = pgTable(
  "build_acceptance",
  {
    buildId: integer("build_id")
      .notNull()
      .references(() => builds.id, { onDelete: "cascade" }),
    checkId: varchar("check_id", { length: 16 }).notNull(),
    feature: text("feature").notNull(),
    verdict: acceptanceVerdict("verdict").notNull(),
    saw: text("saw").notNull(),
    round: integer("round").notNull(),
  },
  (table) => [primaryKey({ columns: [table.buildId, table.checkId] })]
);

// The plan the interview builds: the same parts the spec has, plus the business it serves, who uses
// the app, and the rules that break a simple version of it.
export const PLAN_SECTIONS = [
  "business",
  "who",
  "does",
  "rules",
  "screens",
  "keeps",
  "replaces",
] as const;
export const planSection = pgEnum("plan_section", PLAN_SECTIONS);
// `schmeide`: an item the model added that the person did not state themselves.
export const planSource = pgEnum("plan_source", ["you", "schmeide"]);
// `later`: wanted, but left out of the first build to keep it small.
export const planPhase = pgEnum("plan_phase", ["day_one", "later"]);

export const ITEM_MAX = 300;

export const planItems = pgTable("plan_items", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id")
    .notNull()
    .references(() => projects.id),
  section: planSection("section").notNull(),
  text: varchar("text", { length: ITEM_MAX }).notNull(),
  source: planSource("source").notNull().default("you"),
  phase: planPhase("phase").notNull().default("day_one"),
  // A point the interview did not settle. The text is what will be assumed if it is left open,
  // and the spec states it as an assumption.
  open: boolean("open").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const questionKind = pgEnum("question_kind", ["pick_one", "pick_many", "yes_no", "text"]);

// The most a person writes at once: an answer in their own words, or a note.
export const WORDS_MAX = 2000;

// Every question can also be answered in the person's own words, or left to Schmeide.
export const answerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("choices"), values: z.array(z.string().max(200)).min(1).max(10) }),
  z.object({ type: z.literal("yes_no"), value: z.boolean() }),
  z.object({ type: z.literal("text"), value: z.string().trim().min(1).max(WORDS_MAX) }),
  z.object({ type: z.literal("you_decide") }),
]);
export type Answer = z.infer<typeof answerSchema>;

// One row per question asked; `answer` is null while it waits for the person. A note the person
// added on their own, outside any question, is a row too, so the trail keeps one order: `note` is
// set, `text` is empty, and the note is the text answer. A note is not a question, so it never
// counts against the question limit.
export const interviewQuestions = pgTable("interview_questions", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id")
    .notNull()
    .references(() => projects.id),
  text: varchar("text", { length: ITEM_MAX }).notNull(),
  kind: questionKind("kind").notNull(),
  choices: jsonb("choices").$type<readonly string[]>().notNull().default([]),
  // One short line on why it is asked, so a pointed question reads as care, not as a quiz.
  why: varchar("why", { length: ITEM_MAX }).notNull().default(""),
  answer: jsonb("answer").$type<Answer>(),
  note: boolean("note").notNull().default(false),
  askedAt: timestamp("asked_at", { withTimezone: true }).notNull().defaultNow(),
  answeredAt: timestamp("answered_at", { withTimezone: true }),
});

// How far the person wants the questions to go: a quick sketch, or the thorough interview.
export const INTERVIEW_DEPTHS = ["quick", "thorough"] as const;
export const interviewDepth = pgEnum("interview_depth", INTERVIEW_DEPTHS);

// Where the interview stands as a whole.
export const interviews = pgTable("interviews", {
  projectId: integer("project_id")
    .primaryKey()
    .references(() => projects.id),
  depth: interviewDepth("depth").notNull().default("thorough"),
  // The checklist points the answers have settled (see services/interview.ts); a section is ready
  // when every point it needs is here.
  covered: jsonb("covered").$type<readonly string[]>().notNull().default([]),
  // The model has no more questions, or the question limit was reached.
  finished: boolean("finished").notNull().default(false),
});

// One sentence of the read-back, with the single question asked when it is marked as wrong.
export type ReadBackSentence = { readonly text: string; readonly ask: string };

// What Schmeide understood, said back in the owner's terms before the spec is written. Written
// from the plan, and dropped whenever the plan changes so it is never older than the plan.
export const readBacks = pgTable("read_backs", {
  projectId: integer("project_id")
    .primaryKey()
    .references(() => projects.id),
  // The business in a few sentences.
  business: jsonb("business").$type<readonly ReadBackSentence[]>().notNull(),
  // How a piece of work goes through the app, start to finish.
  steps: jsonb("steps").$type<readonly ReadBackSentence[]>().notNull(),
  writtenAt: timestamp("written_at", { withTimezone: true }).notNull().defaultNow(),
});

const projectId = createSelectSchema(projects).shape.id;

export const FILE_TYPES = ["png", "jpeg", "webp", "pdf", "csv", "xlsx"] as const;
export const fileType = pgEnum("file_type", FILE_TYPES);
export const FILE_OWNERS = ["mine", "someone_else"] as const;
export const fileOwner = pgEnum("file_owner", FILE_OWNERS);
export const FILE_PURPOSES = ["reference", "in_app"] as const;
export const filePurpose = pgEnum("file_purpose", FILE_PURPOSES);

export const FILE_NAME_MAX = 200;

export const files = pgTable(
  "files",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id),
    uploadedBy: text("uploaded_by").references(() => users.id, { onDelete: "set null" }),
    owner: fileOwner("owner").notNull(),
    purpose: filePurpose("purpose").notNull().default("reference"),
    type: fileType("type").notNull(),
    size: integer("size").notNull(),
    originalName: varchar("original_name", { length: FILE_NAME_MAX }).notNull(),
    displayName: varchar("display_name", { length: FILE_NAME_MAX }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [index("files_project_id_idx").on(table.projectId)]
);

export const buildFiles = pgTable(
  "build_files",
  {
    buildId: integer("build_id")
      .notNull()
      .references(() => builds.id, { onDelete: "cascade" }),
    fileId: integer("file_id")
      .notNull()
      .references(() => files.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.buildId, table.fileId] })]
);

// The production packages a passed build ships (#270), from the app's lock files.
export const buildDependencies = pgTable(
  "build_dependencies",
  {
    buildId: integer("build_id")
      .notNull()
      .references(() => builds.id, { onDelete: "cascade" }),
    dir: text("dir").notNull(),
    name: text("name").notNull(),
    version: text("version").notNull(),
    license: text("license"),
  },
  (table) => [primaryKey({ columns: [table.buildId, table.dir, table.name, table.version] })]
);

const fileId = createSelectSchema(files).shape.id;

export const MAX_ATTACHED_FILES = 10;

export const fileIdSchema = z.object({ id: projectId, fileId });

export const renameFileSchema = createInsertSchema(files, {
  displayName: (schema) => schema.trim().min(1).max(FILE_NAME_MAX),
})
  .pick({ displayName: true })
  .extend({ id: projectId, fileId });

export const projectIdSchema = z.object({ id: projectId });

export const NEED_MAX = 2000;

export const todaySchema = z.object({
  uses: z.array(z.string().trim().min(1).max(100)).min(1).max(5),
  keep: z.string().trim().min(1).max(500).optional(),
  keepDecided: z.boolean().optional(),
  fix: z.string().trim().min(1).max(500),
});
export type Today = z.infer<typeof todaySchema>;

export const newProjectSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    need: z.string().trim().min(1).max(NEED_MAX).optional(),
    today: todaySchema.optional(),
  })
  .refine((input) => [input.name, input.need, input.today].some((given) => given !== undefined), {
    message: "Say what you need, or give the app a name",
    path: ["need"],
  });

export const setFeaturesSchema = createInsertSchema(projects, {
  features: (schema) => schema.max(5000),
})
  .pick({ features: true })
  .required()
  .extend({ id: projectId });

export const changeRequestSchema = createInsertSchema(builds, {
  request: (schema) => schema.trim().min(1).max(5000),
})
  .pick({ request: true })
  .extend({ id: projectId, fileIds: z.array(fileId).max(MAX_ATTACHED_FILES).optional() });

const buildId = createSelectSchema(builds).shape.id;

export const buildIdSchema = z.object({ buildId });

// One of a build's pictures; see services/pictures.ts.
export const pictureSchema = z.object({ buildId, width: z.enum(pictureWidth.enumValues) });

export const editChangeSchema = changeRequestSchema
  .omit({ id: true, fileIds: true })
  .extend({ buildId });

export const eventsQuerySchema = z.object({
  buildId,
  afterId: z.number().int().min(0).default(0),
});

const planItemFields = createInsertSchema(planItems, {
  text: (schema) => schema.trim().min(1).max(ITEM_MAX),
});

export const newPlanItemSchema = planItemFields
  .pick({ section: true, text: true, phase: true })
  .extend({ id: projectId });

const itemId = createSelectSchema(planItems).shape.id;

export const planItemIdSchema = z.object({ id: projectId, itemId });

export const editPlanItemSchema = planItemFields
  .pick({ section: true, text: true, phase: true })
  .partial()
  .extend({ id: projectId, itemId });

export const answerQuestionSchema = z.object({
  id: projectId,
  questionId: createSelectSchema(interviewQuestions).shape.id,
  answer: answerSchema,
});

export const addNoteSchema = z.object({
  id: projectId,
  text: z.string().trim().min(1).max(WORDS_MAX),
});

export type Project = typeof projects.$inferSelect;
export type Build = typeof builds.$inferSelect;
export type BuildEvent = typeof buildEvents.$inferSelect;
export type BuildEventKind = BuildEvent["kind"];
export type BuildSummary = typeof buildSummaries.$inferSelect;
export type RunKind = (typeof agentRunKind.enumValues)[number];
export type NewUsage = typeof usage.$inferInsert;
export type NewAgentRun = typeof agentRuns.$inferInsert;
export type PlanSection = (typeof PLAN_SECTIONS)[number];
export type InterviewDepth = (typeof INTERVIEW_DEPTHS)[number];
export type PlanItem = typeof planItems.$inferSelect;
export type Question = typeof interviewQuestions.$inferSelect;
export type FileRow = typeof files.$inferSelect;
export type FileType = (typeof FILE_TYPES)[number];
export type FileOwner = (typeof FILE_OWNERS)[number];
export type FilePurpose = (typeof FILE_PURPOSES)[number];

// Sign-in. `users`, `sessions`, `accounts`, `verifications`, and `rateLimits` are Better Auth's
// tables (services/auth.ts): it reads and writes them by these property names, so the names are
// its, and only the column names are ours.
export const users = pgTable("users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  // Lowercase; Better Auth lowercases before every read and write.
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  // The platform role, separate from what a person is in a business (`memberships.role`):
  // ADMIN_ROLE for the people who run Schmeide, null for everyone else. Better Auth's admin
  // plugin owns this and the `ban*` columns; nobody can set them about themselves.
  role: text("role"),
  banned: boolean("banned").default(false),
  banReason: text("ban_reason"),
  banExpires: timestamp("ban_expires", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const ADMIN_ROLE = "admin";

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    token: text("token").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    // The admin acting as this session's person, when one is (Better Auth's admin plugin).
    impersonatedBy: text("impersonated_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [index("sessions_user_id_idx").on(table.userId)]
);

// One row per way a user signs in: `credential` holds the password hash, the others a provider id.
export const accounts = pgTable(
  "accounts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("accounts_user_id_idx").on(table.userId),
    uniqueIndex("accounts_provider_account_idx").on(table.providerId, table.accountId),
  ]
);

// Short-lived values of a provider sign-in in progress.
export const verifications = pgTable(
  "verifications",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [index("verifications_identifier_idx").on(table.identifier)]
);

// Sign-in attempts per address and path, kept in the database so a restart does not reset them.
export const rateLimits = pgTable("rate_limits", {
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(),
  count: integer("count").notNull(),
  lastRequest: bigint("last_request", { mode: "number" }).notNull(),
});

export const memberRole = pgEnum("member_role", ["owner", "editor"]);

// Who may work in which business.
export const memberships = pgTable(
  "memberships",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tenantId: integer("tenant_id")
      .notNull()
      .references(() => tenants.id),
    role: memberRole("role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.tenantId] })]
);

// What admins did, written only by `withAudit` (services/audit.ts) in the same transaction as the
// action. The app never updates or deletes a row; deleting a person or business keeps their rows.
export const adminActions = pgTable(
  "admin_actions",
  {
    id: serial("id").primaryKey(),
    // Null when done from the command line. The label (an email, or "command line") keeps the
    // row readable once the person is gone.
    adminId: text("admin_id").references(() => users.id, { onDelete: "set null" }),
    adminLabel: text("admin_label").notNull(),
    action: text("action").notNull(),
    targetUserId: text("target_user_id").references(() => users.id, { onDelete: "set null" }),
    targetTenantId: integer("target_tenant_id").references(() => tenants.id, {
      onDelete: "set null",
    }),
    detail: text("detail").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("admin_actions_admin_label_idx").on(table.adminLabel),
    index("admin_actions_target_tenant_id_idx").on(table.targetTenantId),
  ]
);

export const auditQuerySchema = z.object({
  admin: z.string().max(254).optional(),
  tenantId: z.number().int().positive().optional(),
  // The id of the last entry already shown; older entries follow.
  cursor: z.number().int().positive().nullish(),
  limit: z.number().int().min(1).max(100).default(50),
});

// A page of an admin list, newest first, narrowed by a search. `cursor` is how many rows were
// already shown; the answer's `nextCursor` is passed back for the next page.
export const adminListSchema = z.object({
  search: z.string().trim().max(254).optional(),
  cursor: z.number().int().min(0).nullish(),
  limit: z.number().int().min(1).max(100).default(50),
});

export const tenantIdSchema = z.object({ id: createSelectSchema(tenants).shape.id });

// A period of whole days, both ends included, in UTC (services/usageSummary.ts); either end left
// out is open.
const period = z.object({ from: z.iso.date().optional(), to: z.iso.date().optional() });
const inOrder = <T extends z.ZodType<z.infer<typeof period>>>(schema: T) =>
  schema.refine(({ from, to }) => from === undefined || to === undefined || from <= to, {
    message: "The period ends before it starts",
    path: ["to"],
  });
export const periodSchema = inOrder(period);
// `tenantId` narrows it to one business.
export const usageQuerySchema = inOrder(
  period.extend({ tenantId: createSelectSchema(tenants).shape.id.optional() })
);

// Projects to read what they take up, at most a page of them at a time.
export const projectIdsSchema = z.object({ ids: z.array(projectId).max(100) });

// Prelaunch: only these addresses (lowercase) may have an account or a session. Delete the table
// and its checks (services/access.ts) to open sign-up to everyone.
export const approvedEmails = pgTable("approved_emails", {
  email: text("email").primaryKey(),
  // The business this person joins on first sign-in; null gives them a new one of their own.
  tenantId: integer("tenant_id").references(() => tenants.id),
  // An admin made this person an admin before they had an account: their account is created with
  // the role (services/access.ts, services/auth.ts), and this is cleared. Set only by an admin.
  admin: boolean("admin").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// A one-time link. With no business it lets an approved person set their password. With one it
// is an owner's invitation to that business: it opens an account for a new person, or lets a
// signed-in person join, and never changes an existing password. Only the token's hash is kept.
export const invites = pgTable(
  "invites",
  {
    id: serial("id").primaryKey(),
    email: text("email")
      .notNull()
      .references(() => approvedEmails.email, { onDelete: "cascade" }),
    tenantId: integer("tenant_id").references(() => tenants.id),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("invites_waiting_idx")
      .on(table.tenantId, table.email)
      .where(sql`${table.usedAt} is null`),
  ]
);

export type MemberRole = (typeof memberRole.enumValues)[number];

export const websiteReads = pgTable(
  "website_reads",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tenantId: integer("tenant_id")
      .notNull()
      .references(() => tenants.id),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("website_reads_user_at_idx").on(table.userId, table.at),
    index("website_reads_tenant_at_idx").on(table.tenantId, table.at),
  ]
);

// Someone asking for access on schmeide.com. One row per address. `website` on the public
// request is not stored: it is the field real people leave empty (services/accessRequests.ts).
export const ACCESS_NAME_MAX = 100;
export const ACCESS_BUSINESS_MAX = 280;
export const ACCESS_MESSAGE_MAX = 1000;

export const ACCESS_WHO = ["owner", "investor", "other"] as const;
export const accessRequestWho = pgEnum("access_request_who", ACCESS_WHO);

export const ACCESS_REQUEST_STATES = ["waiting", "approved", "declined"] as const;
export const accessRequestState = pgEnum("access_request_state", ACCESS_REQUEST_STATES);

export const accessRequests = pgTable("access_requests", {
  email: text("email").primaryKey(),
  name: varchar("name", { length: ACCESS_NAME_MAX }).notNull(),
  business: varchar("business", { length: ACCESS_BUSINESS_MAX }).notNull(),
  who: accessRequestWho("who").notNull(),
  message: varchar("message", { length: ACCESS_MESSAGE_MAX }),
  state: accessRequestState("state").notNull().default("waiting"),
  arrivedAt: timestamp("arrived_at", { withTimezone: true }).notNull().defaultNow(),
});

// Recent public requests, so a restart does not clear the per-address and per-email limits.
export const accessRequestHits = pgTable(
  "access_request_hits",
  {
    id: serial("id").primaryKey(),
    bucket: text("bucket").notNull(),
    key: text("key").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull(),
  },
  (table) => [index("access_request_hits_bucket_key_at_idx").on(table.bucket, table.key, table.at)]
);

export const WEBSITE_OWNERS = ["mine", "someone_else"] as const;

export const readWebsiteSchema = z.object({
  id: projectId,
  address: z.string().trim().min(1).max(2000),
  whose: z.enum(WEBSITE_OWNERS).optional(),
});

export const emailSchema = z.string().trim().toLowerCase().pipe(z.email().max(254));

// Why an admin acts on a person or a business, which the audit log keeps.
const reasonSchema = z.string().trim().min(1).max(500);

// Starting to view the app as a person: whom, and why.
export const impersonateSchema = z.object({ email: emailSchema, reason: reasonSchema });

// Approving an address, or taking it off the approved list.
export const accessChangeSchema = impersonateSchema;

export const businessStateSchema = tenantIdSchema.extend({ reason: reasonSchema });

export const removeMemberSchema = tenantIdSchema.extend({
  email: emailSchema,
  reason: reasonSchema,
});

export const newBusinessSchema = z.object({
  // As long as `tenants.name` holds.
  name: z.string().trim().min(1).max(120),
  ownerEmail: emailSchema,
  reason: reasonSchema,
});

// A path on this site, the same rule as sitePath in utils/routes.ts. The set-password page sends
// it with the token so the link keeps where `/go` was headed. It is not stored.
const nextOnThisSite = z
  .string()
  .max(2000)
  .refine((value) => /^\/(?![/\\])/.test(value));

export const inviteTokenSchema = z.object({
  token: z.string().min(1).max(200),
  next: nextOnThisSite.optional(),
});

export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_LENGTH = 128;

export const acceptInviteSchema = inviteTokenSchema.extend({
  // Needed for a new person; ignored when the link resets an existing account's password.
  name: z.string().trim().min(1).max(100).optional(),
  password: z.string().min(MIN_PASSWORD_LENGTH).max(MAX_PASSWORD_LENGTH),
});

// The signed-in person's own account (services/account.ts).
export const renameAccountSchema = z.object({ name: z.string().trim().min(1).max(100) });
export const signInMethodIdSchema = z.object({ id: z.string().min(1).max(200) });
// The person types their own email address to confirm deleting the account.
export const deleteAccountSchema = z.object({ email: emailSchema });
