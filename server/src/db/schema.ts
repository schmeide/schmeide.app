import {
  boolean,
  doublePrecision,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";

// Tables are the single source: validation and API types derive from them.

// ponytail: one seeded tenant (`demo`) and no auth; add accounts and tenant-scoped sessions for production
export const tenants = pgTable("tenants", {
  id: serial("id").primaryKey(),
  slug: varchar("slug", { length: 64 }).notNull().unique(),
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

// One row per model per agent run. buildId is null for spec generation.
export const usage = pgTable("usage", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id")
    .notNull()
    .references(() => projects.id),
  buildId: integer("build_id").references(() => builds.id),
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
export type NewUsage = typeof usage.$inferInsert;
export type PlanSection = (typeof PLAN_SECTIONS)[number];
export type PlanItem = typeof planItems.$inferSelect;
export type Question = typeof interviewQuestions.$inferSelect;
