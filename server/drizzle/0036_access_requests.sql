CREATE TYPE "public"."access_request_state" AS ENUM('waiting', 'approved', 'declined');--> statement-breakpoint
CREATE TYPE "public"."access_request_who" AS ENUM('owner', 'investor', 'other');--> statement-breakpoint
CREATE TABLE "access_request_hits" (
	"id" serial PRIMARY KEY NOT NULL,
	"bucket" text NOT NULL,
	"key" text NOT NULL,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "access_requests" (
	"email" text PRIMARY KEY NOT NULL,
	"name" varchar(100) NOT NULL,
	"business" varchar(280) NOT NULL,
	"who" "access_request_who" NOT NULL,
	"message" varchar(1000),
	"state" "access_request_state" DEFAULT 'waiting' NOT NULL,
	"arrived_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "access_request_hits_bucket_key_at_idx" ON "access_request_hits" USING btree ("bucket","key","at");
