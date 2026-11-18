ALTER TYPE "public"."build_kind" ADD VALUE 'rollback';--> statement-breakpoint
CREATE TABLE "database_copies" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"build_id" integer NOT NULL,
	"version" integer,
	"taken_at" timestamp with time zone DEFAULT now() NOT NULL,
	"path" text NOT NULL,
	"bytes" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "builds" ADD COLUMN "additive" boolean;--> statement-breakpoint
ALTER TABLE "builds" ADD COLUMN "from_copy_id" integer;--> statement-breakpoint
ALTER TABLE "database_copies" ADD CONSTRAINT "database_copies_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database_copies" ADD CONSTRAINT "database_copies_build_id_builds_id_fk" FOREIGN KEY ("build_id") REFERENCES "public"."builds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "builds" ADD CONSTRAINT "builds_from_copy_id_database_copies_id_fk" FOREIGN KEY ("from_copy_id") REFERENCES "public"."database_copies"("id") ON DELETE set null ON UPDATE no action;