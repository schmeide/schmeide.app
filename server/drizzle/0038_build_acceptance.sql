CREATE TYPE "public"."acceptance_verdict" AS ENUM('works', 'broken', 'could_not_check');--> statement-breakpoint
CREATE TABLE "build_acceptance" (
	"build_id" integer NOT NULL,
	"check_id" varchar(16) NOT NULL,
	"feature" text NOT NULL,
	"verdict" "acceptance_verdict" NOT NULL,
	"saw" text NOT NULL,
	"round" integer NOT NULL,
	CONSTRAINT "build_acceptance_build_id_check_id_pk" PRIMARY KEY("build_id","check_id")
);
--> statement-breakpoint
ALTER TABLE "build_acceptance" ADD CONSTRAINT "build_acceptance_build_id_builds_id_fk" FOREIGN KEY ("build_id") REFERENCES "public"."builds"("id") ON DELETE cascade ON UPDATE no action;