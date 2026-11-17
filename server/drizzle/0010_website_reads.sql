ALTER TYPE "public"."agent_run_kind" ADD VALUE 'website';--> statement-breakpoint
CREATE TABLE "website_reads" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"tenant_id" integer NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "website_reads" ADD CONSTRAINT "website_reads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "website_reads" ADD CONSTRAINT "website_reads_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "website_reads_user_at_idx" ON "website_reads" USING btree ("user_id","at");--> statement-breakpoint
CREATE INDEX "website_reads_tenant_at_idx" ON "website_reads" USING btree ("tenant_id","at");