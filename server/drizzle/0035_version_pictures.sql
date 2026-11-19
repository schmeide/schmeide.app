CREATE TYPE "public"."picture_width" AS ENUM('desktop', 'phone');--> statement-breakpoint
CREATE TABLE "version_pictures" (
	"build_id" integer NOT NULL,
	"width" "picture_width" NOT NULL,
	"data" text NOT NULL,
	CONSTRAINT "version_pictures_build_id_width_pk" PRIMARY KEY("build_id","width")
);
--> statement-breakpoint
ALTER TABLE "version_pictures" ADD CONSTRAINT "version_pictures_build_id_builds_id_fk" FOREIGN KEY ("build_id") REFERENCES "public"."builds"("id") ON DELETE cascade ON UPDATE no action;