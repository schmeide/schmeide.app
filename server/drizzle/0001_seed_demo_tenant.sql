-- ponytail: the single dev-mode tenant; tenants come from sign-up in production
INSERT INTO "tenants" ("slug") VALUES ('demo') ON CONFLICT ("slug") DO NOTHING;
