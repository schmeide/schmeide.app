CREATE TABLE "read_backs" (
	"project_id" integer PRIMARY KEY NOT NULL,
	"business" jsonb NOT NULL,
	"steps" jsonb NOT NULL,
	"written_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "plan_items" ADD COLUMN "open" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "read_backs" ADD CONSTRAINT "read_backs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;