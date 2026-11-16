ALTER TYPE "public"."build_kind" ADD VALUE 'site';--> statement-breakpoint
CREATE TABLE "project_icons" (
	"project_id" integer PRIMARY KEY NOT NULL,
	"data" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "page_title" varchar(100);--> statement-breakpoint
ALTER TABLE "project_icons" ADD CONSTRAINT "project_icons_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;