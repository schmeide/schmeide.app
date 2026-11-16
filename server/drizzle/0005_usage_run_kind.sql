CREATE TYPE "public"."agent_run_kind" AS ENUM('spec', 'initial', 'change', 'interview');--> statement-breakpoint
ALTER TABLE "usage" ADD COLUMN "run_kind" "agent_run_kind";--> statement-breakpoint
UPDATE "usage" SET "run_kind" = CASE
	WHEN "build_id" IS NULL THEN 'spec'
	WHEN (SELECT "kind" FROM "builds" WHERE "builds"."id" = "usage"."build_id") = 'initial' THEN 'initial'
	ELSE 'change'
END::"agent_run_kind";--> statement-breakpoint
ALTER TABLE "usage" ALTER COLUMN "run_kind" SET NOT NULL;
