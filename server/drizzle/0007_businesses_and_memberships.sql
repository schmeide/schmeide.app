CREATE TYPE "public"."member_role" AS ENUM('owner', 'editor');--> statement-breakpoint
CREATE TABLE "memberships" (
	"user_id" text NOT NULL,
	"tenant_id" integer NOT NULL,
	"role" "member_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_user_id_tenant_id_pk" PRIMARY KEY("user_id","tenant_id")
);
--> statement-breakpoint
ALTER TABLE "approved_emails" ADD COLUMN "tenant_id" integer;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "name" varchar(120) DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approved_emails" ADD CONSTRAINT "approved_emails_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
UPDATE "tenants" SET "name" = 'Demo business' WHERE "slug" = 'demo';
