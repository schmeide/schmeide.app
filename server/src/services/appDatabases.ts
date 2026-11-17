// One database and role per copy of an app on the shared Postgres (docs/stage2.md, "Databases:
// one per copy on the shared server"), made by the worker as a provisioner role with CREATEDB and
// CREATEROLE only. Every step is idempotent, so a deploy that is retried does no harm.
import { randomBytes } from "node:crypto";
import pg from "pg";

// What every app database is copied from. On Azure the public schema of a new database, even one
// copied from template0, belongs to azure_pg_admin, so its owner may not create tables there. This
// one was made once by an admin with `ALTER SCHEMA public OWNER TO pg_database_owner` (schmeide/iac
// gitops/README.md), and the provisioner owns it, so it may copy it.
export const APP_DATABASE_TEMPLATE = "schmeide_app_template";

export const newPassword = (): string => randomBytes(24).toString("hex");

// The copy's own URL, as its pods get it in their DATABASE_URL Secret.
export const appDatabaseUrl = (host: string, name: string, password: string): string =>
  `postgres://${name}:${password}@${host}:5432/${name}?sslmode=require`;

// The password in a URL appDatabaseUrl made.
export const passwordOf = (url: string): string | undefined => {
  try {
    return decodeURIComponent(new URL(url).password) || undefined;
  } catch {
    return undefined;
  }
};

export const createAppDatabases = (provisionerUrl: string) => {
  const session = async <T>(work: (client: pg.Client) => Promise<T>): Promise<T> => {
    const client = new pg.Client({ connectionString: provisionerUrl });
    await client.connect();
    try {
      return await work(client);
    } finally {
      await client.end();
    }
  };
  const exists = async (client: pg.Client, table: string, column: string, name: string) =>
    (await client.query(`SELECT 1 FROM ${table} WHERE ${column} = $1`, [name])).rowCount === 1;

  return {
    // The role `name` with `password` and a database it owns, nobody else may connect to. The
    // provisioner is a member of the role, so it may drop the database later.
    ensure: (name: string, password: string): Promise<void> =>
      session(async (client) => {
        const role = client.escapeIdentifier(name);
        await client.query(
          `${(await exists(client, "pg_roles", "rolname", name)) ? "ALTER" : "CREATE"} ROLE ${role} LOGIN PASSWORD ${client.escapeLiteral(password)}`
        );
        await client.query(`GRANT ${role} TO CURRENT_USER`);
        if (!(await exists(client, "pg_database", "datname", name)))
          await client.query(
            `CREATE DATABASE ${role} OWNER ${role} TEMPLATE ${client.escapeIdentifier(APP_DATABASE_TEMPLATE)}`
          );
        await client.query(`REVOKE CONNECT ON DATABASE ${role} FROM PUBLIC`);
      }),

    // The database, cutting off whoever is connected, and with `role` its role too.
    drop: (name: string, options: { readonly role: boolean }): Promise<void> =>
      session(async (client) => {
        const role = client.escapeIdentifier(name);
        await client.query(`DROP DATABASE IF EXISTS ${role} WITH (FORCE)`);
        if (options.role) await client.query(`DROP ROLE IF EXISTS ${role}`);
      }),

    // For the startup check: the provisioner can sign in, may create both, and has the template.
    rights: (): Promise<{
      readonly createDb: boolean;
      readonly createRole: boolean;
      readonly template: boolean;
    }> =>
      session(async (client) => {
        const { rows } = await client.query<{ rolcreatedb: boolean; rolcreaterole: boolean }>(
          "SELECT rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = CURRENT_USER"
        );
        return {
          createDb: rows[0]?.rolcreatedb === true,
          createRole: rows[0]?.rolcreaterole === true,
          template: await exists(client, "pg_database", "datname", APP_DATABASE_TEMPLATE),
        };
      }),
  };
};

export type AppDatabases = ReturnType<typeof createAppDatabases>;
