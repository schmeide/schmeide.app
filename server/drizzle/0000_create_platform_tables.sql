CREATE TYPE "public"."build_event_kind" AS ENUM('step', 'agent', 'check', 'deploy', 'error');--> statement-breakpoint
CREATE TYPE "public"."build_kind" AS ENUM('initial', 'change');--> statement-breakpoint
CREATE TYPE "public"."build_status" AS ENUM('running', 'passed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."project_status" AS ENUM('draft', 'spec_generating', 'spec_ready', 'building', 'live', 'failed', 'stopped');--> statement-breakpoint
CREATE TABLE "build_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"build_id" integer NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" "build_event_kind" NOT NULL,
	"message" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "builds" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"kind" "build_kind" NOT NULL,
	"request" text NOT NULL,
	"status" "build_status" DEFAULT 'running' NOT NULL,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"slug" varchar(48) NOT NULL,
	"name" varchar(100) NOT NULL,
	"status" "project_status" DEFAULT 'draft' NOT NULL,
	"features" text DEFAULT '' NOT NULL,
	"spec" text,
	"web_port" integer NOT NULL,
	"preview_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_slug_unique" UNIQUE("slug"),
	CONSTRAINT "projects_web_port_unique" UNIQUE("web_port")
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenants_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "usage" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"build_id" integer,
	"model" text NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"cache_read_tokens" integer NOT NULL,
	"cache_creation_tokens" integer NOT NULL,
	"cost_usd" double precision NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "build_events" ADD CONSTRAINT "build_events_build_id_builds_id_fk" FOREIGN KEY ("build_id") REFERENCES "public"."builds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "builds" ADD CONSTRAINT "builds_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage" ADD CONSTRAINT "usage_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage" ADD CONSTRAINT "usage_build_id_builds_id_fk" FOREIGN KEY ("build_id") REFERENCES "public"."builds"("id") ON DELETE no action ON UPDATE no action;