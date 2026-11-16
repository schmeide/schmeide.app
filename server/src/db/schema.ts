import {
  doublePrecision,
  integer,
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
  previewUrl: text("preview_url"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const buildKind = pgEnum("build_kind", ["initial", "change"]);
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

export type Project = typeof projects.$inferSelect;
export type Build = typeof builds.$inferSelect;
export type BuildEvent = typeof buildEvents.$inferSelect;
export type BuildEventKind = BuildEvent["kind"];
export type NewUsage = typeof usage.$inferInsert;
