ALTER TYPE "public"."agent_run_kind" ADD VALUE 'summary';--> statement-breakpoint
CREATE TABLE "build_summaries" (
	"id" serial PRIMARY KEY NOT NULL,
	"build_id" integer NOT NULL,
	"through_event_id" integer NOT NULL,
	"final" boolean DEFAULT false NOT NULL,
	"text" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "build_summaries" ADD CONSTRAINT "build_summaries_build_id_builds_id_fk" FOREIGN KEY ("build_id") REFERENCES "public"."builds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "build_summaries_build_id_idx" ON "build_summaries" USING btree ("build_id");