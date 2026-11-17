ALTER TABLE "projects" ADD COLUMN "host" varchar(63);--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_host_unique" UNIQUE("host");