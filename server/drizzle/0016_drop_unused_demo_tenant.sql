-- 0001 seeds `demo` everywhere; it is local-only data, now made by `make db/seed`. Removed where
-- nothing refers to it (a fresh database, production); kept where it holds work.
DELETE FROM "tenants" WHERE "slug" = 'demo'
  AND NOT EXISTS (SELECT 1 FROM "projects" WHERE "tenant_id" = "tenants"."id")
  AND NOT EXISTS (SELECT 1 FROM "memberships" WHERE "tenant_id" = "tenants"."id")
  AND NOT EXISTS (SELECT 1 FROM "approved_emails" WHERE "tenant_id" = "tenants"."id")
  AND NOT EXISTS (SELECT 1 FROM "website_reads" WHERE "tenant_id" = "tenants"."id")
  AND NOT EXISTS (SELECT 1 FROM "admin_actions" WHERE "target_tenant_id" = "tenants"."id");
