ALTER TYPE "public"."agent_run_kind" ADD VALUE 'acceptance';--> statement-breakpoint
CREATE TABLE "project_acceptance" (
	"project_id" integer PRIMARY KEY NOT NULL,
	"spec_hash" varchar(64) NOT NULL,
	"plan" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_acceptance" ADD CONSTRAINT "project_acceptance_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;