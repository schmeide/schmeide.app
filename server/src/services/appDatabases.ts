// One database and role per copy of an app on the shared Postgres (docs/stage2.md, "Databases:
// one per copy on the shared server"), made by the worker as a provisioner role with CREATEDB and
// CREATEROLE only. Every step is idempotent, so a deploy that is retried does no harm.
import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import pg from "pg";
import type { Cluster } from "../kube/client.ts";
import { objectPath } from "../kube/apps.ts";

// What every app database is copied from. On Azure the public schema of a new database, even one
// copied from template0, belongs to azure_pg_admin, so its owner may not create tables there. This
// one was made once by an admin with `ALTER SCHEMA public OWNER TO pg_database_owner` (schmeide/iac
// gitops/README.md), and the provisioner owns it, so it may copy it.
export const APP_DATABASE_TEMPLATE = "schmeide_app_template";

// The databases the platform itself uses, which no app's role may connect to.
export const PLATFORM_DATABASES: readonly string[] = ["schmeide", "postgres"];

export const newPassword = (): string => randomBytes(24).toString("hex");

// What Postgres stores for `password` (RFC 7677, as libpq's PQencryptPassword makes it). Sent in
// place of the password, so a failed statement that reaches the server log shows no password.
export const scramVerifier = (password: string, salt = randomBytes(16)): string => {
  const iterations = 4096;
  const salted = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  const hmac = (key: string) => createHmac("sha256", salted).update(key).digest();
  const storedKey = createHash("sha256").update(hmac("Client Key")).digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey.toString("base64")}:${hmac("Server Key").toString("base64")}`;
};

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

// The password of a copy's database: the one in its Secret, which is made first with a new one when
// there is none. Two attempts of one deploy that race both end up with the Secret's password.
export const copyPassword = async (
  cluster: Pick<Cluster, "create" | "get">,
  secretWith: (password: string) => object
): Promise<string> => {
  const fresh = newPassword();
  const secret = secretWith(fresh);
  const path = objectPath(secret);
  if (await cluster.create(path, secret)) return fresh;
  const stored = (await cluster.get<{ data?: { DATABASE_URL?: string } }>(path))?.data
    ?.DATABASE_URL;
  const password = stored && passwordOf(Buffer.from(stored, "base64").toString());
  if (!password) throw new Error(`The Secret at ${path} has no DATABASE_URL with a password`);
  return password;
};

export const createAppDatabases = (provisionerUrl: string) => {
  const session = async <T>(work: (client: pg.Client) => Promise<T>): Promise<T> => {
    const client = new pg.Client({
      connectionString: provisionerUrl,
      connectionTimeoutMillis: 10_000,
      statement_timeout: 30_000,
    });
    await client.connect();
    try {
      return await work(client);
    } finally {
      await client.end();
    }
  };
  const exists = async (client: pg.Client, table: string, column: string, name: string) =>
    (await client.query(`SELECT 1 FROM ${table} WHERE ${column} = $1`, [name])).rowCount === 1;

  // Databases PUBLIC may connect to that match `where`, with $1 the platform's databases.
  const openTo = async (client: pg.Client, where: string) =>
    (
      await client.query<{ datname: string }>(
        `SELECT datname FROM pg_database WHERE datallowconn AND NOT datistemplate
           AND has_database_privilege('public', oid, 'CONNECT') AND (${where}) ORDER BY datname`,
        [PLATFORM_DATABASES]
      )
    ).rows.map((row) => row.datname);
  const own = "pg_has_role(CURRENT_USER, datdba, 'MEMBER')";
  // Platform databases are left to an admin, who grants their roles CONNECT before revoking it.
  const open = async (client: pg.Client) => {
    for (const name of await openTo(client, `${own} AND NOT datname = ANY($1)`))
      await client.query(`REVOKE CONNECT ON DATABASE ${client.escapeIdentifier(name)} FROM PUBLIC`);
    return openTo(client, `${own} OR datname = ANY($1)`);
  };

  return {
    // The role `name` with `password` and a database it owns, nobody else may connect to. The
    // provisioner is a member of the role, so it may drop the database later.
    ensure: (name: string, password: string): Promise<void> =>
      session(async (client) => {
        const role = client.escapeIdentifier(name);
        await client.query(
          `${(await exists(client, "pg_roles", "rolname", name)) ? "ALTER" : "CREATE"} ROLE ${role} LOGIN PASSWORD ${client.escapeLiteral(scramVerifier(password))}`
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
    // It closes its own databases to PUBLIC again, in case a CREATE DATABASE ended before its
    // REVOKE, and `open` names the platform and app databases PUBLIC may still connect to.
    rights: (): Promise<{
      readonly createDb: boolean;
      readonly createRole: boolean;
      readonly template: boolean;
      readonly open: readonly string[];
    }> =>
      session(async (client) => {
        const { rows } = await client.query<{ rolcreatedb: boolean; rolcreaterole: boolean }>(
          "SELECT rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = CURRENT_USER"
        );
        return {
          createDb: rows[0]?.rolcreatedb === true,
          createRole: rows[0]?.rolcreaterole === true,
          template: await exists(client, "pg_database", "datname", APP_DATABASE_TEMPLATE),
          open: await open(client),
        };
      }),
  };
};

export type AppDatabases = ReturnType<typeof createAppDatabases>;
