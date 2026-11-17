CREATE TYPE "public"."tenant_state" AS ENUM('active', 'suspended');--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "state" "tenant_state" DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "state_reason" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "state_changed_at" timestamp with time zone;