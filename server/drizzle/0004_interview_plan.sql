CREATE TYPE "public"."plan_phase" AS ENUM('day_one', 'later');--> statement-breakpoint
CREATE TYPE "public"."plan_section" AS ENUM('who', 'does', 'screens', 'keeps');--> statement-breakpoint
CREATE TYPE "public"."plan_source" AS ENUM('you', 'schmeide');--> statement-breakpoint
CREATE TYPE "public"."question_kind" AS ENUM('pick_one', 'pick_many', 'yes_no', 'text');--> statement-breakpoint
CREATE TABLE "interview_questions" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"text" varchar(300) NOT NULL,
	"kind" "question_kind" NOT NULL,
	"choices" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"answer" jsonb,
	"asked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"answered_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "interviews" (
	"project_id" integer PRIMARY KEY NOT NULL,
	"ready" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"finished" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plan_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"section" "plan_section" NOT NULL,
	"text" varchar(300) NOT NULL,
	"source" "plan_source" DEFAULT 'you' NOT NULL,
	"phase" "plan_phase" DEFAULT 'day_one' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "interview_questions" ADD CONSTRAINT "interview_questions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_items" ADD CONSTRAINT "plan_items_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;