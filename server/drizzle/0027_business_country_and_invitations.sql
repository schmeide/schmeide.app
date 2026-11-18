ALTER TABLE "invites" ADD COLUMN "tenant_id" integer;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "country" varchar(2);--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "invites_waiting_idx" ON "invites" USING btree ("tenant_id","email") WHERE "invites"."used_at" is null;