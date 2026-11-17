CREATE TYPE "public"."build_release" AS ENUM('promoted', 'discarded');--> statement-breakpoint
ALTER TYPE "public"."build_kind" ADD VALUE 'promote';--> statement-breakpoint
ALTER TYPE "public"."build_kind" ADD VALUE 'discard';--> statement-breakpoint
ALTER TABLE "builds" ADD COLUMN "release" "build_release";--> statement-breakpoint
ALTER TABLE "builds" ADD COLUMN "by_user_id" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "staging_url" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "staging_commit" varchar(40);--> statement-breakpoint
ALTER TABLE "builds" ADD CONSTRAINT "builds_by_user_id_users_id_fk" FOREIGN KEY ("by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_web_port_below_staging" CHECK ("projects"."web_port" < 18100);--> statement-breakpoint
-- An app live before staging existed runs every build that passed: none of them waits to be put live.
UPDATE "builds" SET "release" = 'promoted' WHERE "status" = 'passed';
