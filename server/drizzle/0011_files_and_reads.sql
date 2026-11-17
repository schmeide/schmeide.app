CREATE TYPE "public"."file_owner" AS ENUM('mine', 'someone_else');--> statement-breakpoint
CREATE TYPE "public"."file_purpose" AS ENUM('reference', 'in_app');--> statement-breakpoint
CREATE TYPE "public"."file_type" AS ENUM('png', 'jpeg', 'webp', 'pdf', 'csv', 'xlsx');--> statement-breakpoint
ALTER TYPE "public"."agent_run_kind" ADD VALUE 'read';--> statement-breakpoint
CREATE TABLE "build_files" (
	"build_id" integer NOT NULL,
	"file_id" integer NOT NULL,
	CONSTRAINT "build_files_build_id_file_id_pk" PRIMARY KEY("build_id","file_id")
);
--> statement-breakpoint
CREATE TABLE "files" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"uploaded_by" text,
	"owner" "file_owner" NOT NULL,
	"purpose" "file_purpose" DEFAULT 'reference' NOT NULL,
	"type" "file_type" NOT NULL,
	"size" integer NOT NULL,
	"original_name" varchar(200) NOT NULL,
	"display_name" varchar(200) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "build_files" ADD CONSTRAINT "build_files_build_id_builds_id_fk" FOREIGN KEY ("build_id") REFERENCES "public"."builds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "build_files" ADD CONSTRAINT "build_files_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "files_project_id_idx" ON "files" USING btree ("project_id");