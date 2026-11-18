CREATE TABLE "build_dependencies" (
	"build_id" integer NOT NULL,
	"dir" text NOT NULL,
	"name" text NOT NULL,
	"version" text NOT NULL,
	"license" text,
	CONSTRAINT "build_dependencies_build_id_dir_name_version_pk" PRIMARY KEY("build_id","dir","name","version")
);
--> statement-breakpoint
ALTER TABLE "build_dependencies" ADD CONSTRAINT "build_dependencies_build_id_builds_id_fk" FOREIGN KEY ("build_id") REFERENCES "public"."builds"("id") ON DELETE cascade ON UPDATE no action;