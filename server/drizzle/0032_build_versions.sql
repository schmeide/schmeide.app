ALTER TABLE "builds" ADD COLUMN "version" integer;--> statement-breakpoint
ALTER TABLE "builds" ADD COLUMN "base_commit" varchar(40);--> statement-breakpoint
CREATE UNIQUE INDEX "builds_project_version_idx" ON "builds" USING btree ("project_id","version");--> statement-breakpoint
-- Number each project's passed builds that have a commit of their own, in id order.
-- base_commit is the previous numbered build's commit. promote and discard move a copy and get no number.
WITH numbered AS (
  SELECT
    id,
    (row_number() OVER (PARTITION BY project_id ORDER BY id))::integer AS version,
    lag(commit) OVER (PARTITION BY project_id ORDER BY id) AS base_commit
  FROM "builds"
  WHERE "status" = 'passed'
    AND "commit" IS NOT NULL
    AND "kind" IN ('initial', 'change', 'site')
)
UPDATE "builds" AS b
SET "version" = numbered.version, "base_commit" = numbered.base_commit
FROM numbered
WHERE b.id = numbered.id AND b.version IS NULL;