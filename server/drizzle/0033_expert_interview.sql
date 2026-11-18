CREATE TYPE "public"."interview_depth" AS ENUM('quick', 'thorough');--> statement-breakpoint
ALTER TYPE "public"."plan_section" ADD VALUE 'business' BEFORE 'who';--> statement-breakpoint
ALTER TYPE "public"."plan_section" ADD VALUE 'rules' BEFORE 'screens';--> statement-breakpoint
ALTER TABLE "interview_questions" ADD COLUMN "why" varchar(300) DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "interviews" ADD COLUMN "depth" "interview_depth" DEFAULT 'thorough' NOT NULL;--> statement-breakpoint
ALTER TABLE "interviews" ADD COLUMN "covered" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "interviews" DROP COLUMN "ready";