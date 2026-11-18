import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  APP_DATABASE_TEMPLATE,
  appDatabaseUrl,
  copyPassword,
  createAppDatabases,
  scramVerifier,
} from "../appDatabases.ts";

// As the test Postgres's superuser, in its `postgres` database.
const adminUrl = new URL(process.env.DATABASE_URL ?? "");
adminUrl.pathname = "/postgres";
const suffix = randomBytes(4).toString("hex");
const provisioner = `provisioner_${suffix}`;
const provisionerPassword = randomBytes(12).toString("hex");
const provisionerUrl = new URL(adminUrl);
provisionerUrl.username = provisioner;
provisionerUrl.password = provisionerPassword;

const asAdmin = async <T>(work: (client: pg.Client) => Promise<T>): Promise<T> => {
  const client = new pg.Client({ connectionString: adminUrl.href });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
};

// Whether `name` can sign in to its own database with `password`.
const signsIn = async (name: string, password: string): Promise<boolean> => {
  const url = new URL(adminUrl);
  url.username = name;
  url.password = password;
  url.pathname = `/${name}`;
  const client = new pg.Client({ connectionString: url.href });
  try {
    await client.connect();
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
};

const publicMayConnect = (name: string) =>
  asAdmin(
    async (client) =>
      (
        await client.query<{ open: boolean }>(
          "SELECT has_database_privilege('public', oid, 'CONNECT') AS open FROM pg_database WHERE datname = $1",
          [name]
        )
      ).rows[0]?.open
  );

describe("scramVerifier", () => {
  it("derives the stored and server keys of RFC 7677", () => {
    // The salt and password of RFC 7677 section 3; the keys as Python's hashlib computes them.
    expect(scramVerifier("pencil", Buffer.from("W22ZaJ0SNY7soEsUEjb6gQ==", "base64"))).toBe(
      "SCRAM-SHA-256$4096:W22ZaJ0SNY7soEsUEjb6gQ==$WG5d8oPm3OtcPnkdi4Uo7BkeZkBFzpcXkuLmtbsT4qY=:wfPLwcE6nTWhTAmQ7tl2KeoiWGPlZqQxSrmfPwDl2dU="
    );
  });
});

describe("copyPassword", () => {
  it("settles two racing attempts on the one password in the Secret", async () => {
    const stored = new Map<string, object>();
    const cluster = {
      create: async (path: string, object: object) => {
        await new Promise((resolve) => setTimeout(resolve, Math.random() * 5));
        if (stored.has(path)) return false;
        stored.set(path, object);
        return true;
      },
      get: async <T>(path: string) => {
        const secret = stored.get(path) as { stringData: { DATABASE_URL: string } } | undefined;
        return (secret && {
          data: { DATABASE_URL: Buffer.from(secret.stringData.DATABASE_URL).toString("base64") },
        }) as T | undefined;
      },
    };
    const secretWith = (password: string) => ({
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name: "app-1-production", namespace: "tenant-1" },
      stringData: { DATABASE_URL: appDatabaseUrl("db.example", "app_1_production", password) },
    });

    const [first, second] = await Promise.all([
      copyPassword(cluster, secretWith),
      copyPassword(cluster, secretWith),
    ]);

    expect(first).toMatch(/^[0-9a-f]{48}$/);
    expect(second).toBe(first);
  });
});

describe("createAppDatabases", () => {
  const databases = createAppDatabases(provisionerUrl.href);
  const name = `app_${suffix}`;

  beforeAll(() =>
    asAdmin(async (client) => {
      await client.query(
        `CREATE ROLE ${provisioner} LOGIN CREATEDB CREATEROLE PASSWORD '${provisionerPassword}'`
      );
      await client.query(`DROP DATABASE IF EXISTS ${APP_DATABASE_TEMPLATE}`);
      await client.query(`CREATE DATABASE ${APP_DATABASE_TEMPLATE} OWNER ${provisioner}`);
    })
  );

  afterAll(() =>
    asAdmin(async (client) => {
      await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await client.query(`DROP DATABASE IF EXISTS ${APP_DATABASE_TEMPLATE}`);
      await client.query(`DROP ROLE IF EXISTS ${name}`);
      await client.query(`DROP ROLE IF EXISTS ${provisioner}`);
    })
  );

  it("sets the role's password from a verifier, never sending the password itself", async () => {
    const query = vi.spyOn(pg.Client.prototype, "query");
    try {
      await databases.ensure(name, "first-password");
      await databases.ensure(name, "second-password");

      const sent = JSON.stringify(query.mock.calls);
      expect(sent).not.toContain("first-password");
      expect(sent).not.toContain("second-password");
      expect(sent).toContain("SCRAM-SHA-256$4096:");
    } finally {
      query.mockRestore();
    }
    expect(await signsIn(name, "first-password")).toBe(false);
    expect(await signsIn(name, "second-password")).toBe(true);
    expect(await publicMayConnect(name)).toBe(false);
  });

  it("closes its own databases to PUBLIC again and names the platform's that are open", async () => {
    await databases.ensure(name, "a-password");
    await asAdmin((client) => client.query(`GRANT CONNECT ON DATABASE ${name} TO PUBLIC`));

    const rights = await databases.rights();

    expect(rights).toMatchObject({ createDb: true, createRole: true, template: true });
    expect(await publicMayConnect(name)).toBe(false);
    // The test server's platform databases keep Postgres's default, open to PUBLIC.
    expect(rights.open).toEqual(["postgres", "schmeide"]);
  });
});
