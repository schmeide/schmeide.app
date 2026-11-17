CREATE TYPE "public"."design_chooser" AS ENUM('lead', 'fallback', 'person');--> statement-breakpoint
ALTER TYPE "public"."agent_run_kind" ADD VALUE 'design';--> statement-breakpoint
CREATE TABLE "project_designs" (
	"project_id" integer PRIMARY KEY NOT NULL,
	"style" varchar(32) NOT NULL,
	"chosen_by" "design_chooser" NOT NULL,
	"brief" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "brand_colors" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "project_designs" ADD CONSTRAINT "project_designs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;