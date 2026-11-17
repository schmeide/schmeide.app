// `make db/migrate`, and the production image's PreSync Job: applies server/drizzle to DATABASE_URL
// with drizzle-orm alone (drizzle-kit is a devDependency). Same table as `drizzle-kit migrate`, so
// it carries on from a database that tool migrated. Exits non-zero on failure, failing the deploy.
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb } from "./db/client.ts";

const db = createDb(
  process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5440/schmeide"
);

try {
  await migrate(db, { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });
} catch (error) {
  // drizzle wraps the database's own message, which says what is wrong, in `cause`.
  const { message, cause } = error as Error;
  console.error(`Error: ${message}${cause instanceof Error ? `\n${cause.message}` : ""}`);
  process.exitCode = 1;
} finally {
  await db.$client.end();
}
