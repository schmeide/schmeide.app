import {
  bigint,
  boolean,
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
} from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";

// Tables are the single source: validation and API types derive from them.

// A business, in customer copy. Everything a person makes belongs to one; `memberships` says who
// may work in it. The seeded `demo` tenant holds what was built before sign-in existed.
export const tenants = pgTable("tenants", {
  id: serial("id").primaryKey(),
  slug: varchar("slug", { length: 64 }).notNull().unique(),
  name: varchar("name", { length: 120 }).notNull().default(""),
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

export const projects = pgTable("projects", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id")
    .notNull()
    .references(() => tenants.id),
  slug: varchar("slug", { length: 48 }).notNull().unique(),
  name: varchar("name", { length: 100 }).notNull(),
  status: projectStatus("status").notNull().default("draft"),
  features: text("features").notNull().default(""),
  spec: text("spec"),
  webPort: integer("web_port").notNull().unique(),
  // The deployed app's <title>; null means the project name.
  pageTitle: varchar("page_title", { length: 100 }),
  previewUrl: text("preview_url"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

// `site`: applies the page title and icon and redeploys, without the agent.
export const buildKind = pgEnum("build_kind", ["initial", "change", "site"]);
// `queued`: a change waiting for the project's running build; it starts once that one passes.
export const buildStatus = pgEnum("build_status", ["queued", "running", "passed", "failed"]);

export const builds = pgTable("builds", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id")
    .notNull()
    .references(() => projects.id),
  kind: buildKind("kind").notNull(),
  request: text("request").notNull(),
  status: buildStatus("status").notNull().default("running"),
  error: text("error"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

// Kept out of projects so project rows, polled by the UI, stay small.
export const projectIcons = pgTable("project_icons", {
  projectId: integer("project_id")
    .primaryKey()
    .references(() => projects.id),
  // Base64 of a PNG or ICO, checked by siteSchema.
  data: text("data").notNull(),
});

export const buildEventKind = pgEnum("build_event_kind", [
  "step",
  "agent",
  "check",
  "deploy",
  "error",
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

// What a model run is for. It labels the run's usage, and for every kind but `interview` it
// decides the run's model (agentModel.ts).
export const agentRunKind = pgEnum("agent_run_kind", ["spec", "initial", "change", "interview"]);

// One row per model per agent run. buildId is null for spec generation and interview questions. model is what the run
// used, as the SDK reports it; runKind is what the run was, so cost can be compared per kind.
export const usage = pgTable("usage", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id")
    .notNull()
    .references(() => projects.id),
  buildId: integer("build_id").references(() => builds.id),
  runKind: agentRunKind("run_kind").notNull(),
  model: text("model").notNull(),
  inputTokens: integer("input_tokens").notNull(),
  outputTokens: integer("output_tokens").notNull(),
  cacheReadTokens: integer("cache_read_tokens").notNull(),
  cacheCreationTokens: integer("cache_creation_tokens").notNull(),
  costUsd: doublePrecision("cost_usd").notNull(),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
});

// The plan the interview builds: the same parts the spec has, plus who uses the app.
export const PLAN_SECTIONS = ["who", "does", "screens", "keeps"] as const;
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
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const questionKind = pgEnum("question_kind", ["pick_one", "pick_many", "yes_no", "text"]);

// Every question can also be answered in the person's own words, or left to Schmeide.
export const answerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("choices"), values: z.array(z.string().max(200)).min(1).max(10) }),
  z.object({ type: z.literal("yes_no"), value: z.boolean() }),
  z.object({ type: z.literal("text"), value: z.string().trim().min(1).max(2000) }),
  z.object({ type: z.literal("you_decide") }),
]);
export type Answer = z.infer<typeof answerSchema>;

// One row per question asked; `answer` is null while it waits for the person.
export const interviewQuestions = pgTable("interview_questions", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id")
    .notNull()
    .references(() => projects.id),
  text: varchar("text", { length: ITEM_MAX }).notNull(),
  kind: questionKind("kind").notNull(),
  choices: jsonb("choices").$type<readonly string[]>().notNull().default([]),
  answer: jsonb("answer").$type<Answer>(),
  askedAt: timestamp("asked_at", { withTimezone: true }).notNull().defaultNow(),
  answeredAt: timestamp("answered_at", { withTimezone: true }),
});

// What the model last said about the interview as a whole.
export const interviews = pgTable("interviews", {
  projectId: integer("project_id")
    .primaryKey()
    .references(() => projects.id),
  // Sections the model considers complete enough to build from.
  ready: jsonb("ready").$type<readonly PlanSection[]>().notNull().default([]),
  // The model has no more questions, or the question limit was reached.
  finished: boolean("finished").notNull().default(false),
});

const projectId = createSelectSchema(projects).shape.id;

export const projectIdSchema = z.object({ id: projectId });

export const newProjectSchema = createInsertSchema(projects, {
  name: (schema) => schema.trim().min(1),
}).pick({ name: true });

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
  .extend({ id: projectId });

const buildId = createSelectSchema(builds).shape.id;

export const buildIdSchema = z.object({ buildId });

export const editChangeSchema = changeRequestSchema.omit({ id: true }).extend({ buildId });

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

export type Project = typeof projects.$inferSelect;
export type Build = typeof builds.$inferSelect;
export type BuildEvent = typeof buildEvents.$inferSelect;
export type BuildEventKind = BuildEvent["kind"];
export type RunKind = (typeof agentRunKind.enumValues)[number];
export type NewUsage = typeof usage.$inferInsert;
export type PlanSection = (typeof PLAN_SECTIONS)[number];
export type PlanItem = typeof planItems.$inferSelect;
export type Question = typeof interviewQuestions.$inferSelect;

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
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

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

// Prelaunch: only these addresses (lowercase) may have an account or a session. Delete the table
// and its checks (services/access.ts) to open sign-up to everyone.
export const approvedEmails = pgTable("approved_emails", {
  email: text("email").primaryKey(),
  // The business this person joins on first sign-in; null gives them a new one of their own.
  tenantId: integer("tenant_id").references(() => tenants.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// A one-time link that lets an approved person set their password. Only the token's hash is kept.
export const invites = pgTable("invites", {
  id: serial("id").primaryKey(),
  email: text("email")
    .notNull()
    .references(() => approvedEmails.email, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const emailSchema = z.string().trim().toLowerCase().pipe(z.email().max(254));

export const inviteTokenSchema = z.object({ token: z.string().min(1).max(200) });

export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_LENGTH = 128;

export const acceptInviteSchema = inviteTokenSchema.extend({
  // Needed for a new person; ignored when the link resets an existing account's password.
  name: z.string().trim().min(1).max(100).optional(),
  password: z.string().min(MIN_PASSWORD_LENGTH).max(MAX_PASSWORD_LENGTH),
});
