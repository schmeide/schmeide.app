// One business may not reach another's app, database, code, or cookies (#274). The API walk over
// every procedure lives in businesses.test.ts; this tries the doors under the API: what the worker
// applies to the cluster, the roles it makes on the shared Postgres, the repositories and deploy
// keys on Forgejo, the images it pushes, and the session cookie the browser holds. The cluster
// itself is tried by `make e2e/isolation`.
import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.ts";
import { createDb } from "../db/client.ts";
import type { AppContext } from "../router.ts";
import { taskYaml } from "../services/acr.ts";
import {
  APP_DATABASE_TEMPLATE,
  appDatabaseUrl,
  createAppDatabases,
  newPassword,
  PLATFORM_DATABASES,
} from "../services/appDatabases.ts";
import { createForgejo, orgOf } from "../services/forgejo.ts";
import {
  appObjects,
  copyUrl,
  databaseName,
  imageRepos,
  POSTGRES_CIDR,
  tenantNamespace,
  tenantObjects,
  type AppCopy,
} from "../kube/apps.ts";
import { aSignedInPerson, PASSWORD, signIn, testAuth } from "./testAuth.ts";

type Kinded = {
  readonly kind: string;
  readonly metadata: { readonly name: string; readonly namespace?: string };
  readonly spec?: Record<string, unknown>;
};
type Peer = {
  readonly namespaceSelector?: { readonly matchLabels: Record<string, string> };
  readonly podSelector?: unknown;
  readonly ipBlock?: { readonly cidr: string };
};
type Rule = { readonly from?: readonly Peer[]; readonly to?: readonly Peer[] };

const A = 1_900_000_001;
const B = 1_900_000_002;
const copyOf = (tenantId: number, projectId: number): AppCopy => ({
  tenantId,
  projectId,
  slug: "bakery",
  copy: "production",
  host: `bakery-${tenantId}`,
  domain: "apps.schmeide.com",
  registry: "schmeide.azurecr.io",
  commit: "abc123",
});
const appA = copyOf(A, 101);
const appB = copyOf(B, 202);

// Whether an IPv4 address is inside a CIDR block.
const inCidr = (address: string, cidr: string): boolean => {
  const toInt = (ip: string) => ip.split(".").reduce((sum, part) => sum * 256 + Number(part), 0);
  const [base, bits] = cidr.split("/");
  const size = 2 ** (32 - Number(bits));
  return Math.floor(toInt(address) / size) === Math.floor(toInt(base) / size);
};

describe("an app", () => {
  const objects = [...tenantObjects(A), ...appObjects(appA)] as readonly Kinded[];
  const policies = objects.filter(({ kind }) => kind === "NetworkPolicy");
  const rules = (type: "ingress" | "egress") =>
    policies.flatMap(({ spec }) => (spec?.[type] ?? []) as readonly Rule[]);
  const peers = (type: "ingress" | "egress") =>
    rules(type).flatMap((rule) => (type === "ingress" ? rule.from : rule.to) ?? []);

  it("lives only in its own business's namespace", () => {
    const namespaced = objects.filter(({ kind }) => kind !== "Namespace");
    expect(namespaced.length).toBeGreaterThan(5);
    for (const object of namespaced)
      expect([object.kind, object.metadata.namespace]).toEqual([object.kind, tenantNamespace(A)]);
    expect(tenantNamespace(A)).not.toBe(tenantNamespace(B));
  });

  it("is behind a policy that denies all traffic in and out by default", () => {
    const deny = policies.find(({ metadata }) => metadata.name === "default-deny");
    expect(deny?.spec).toEqual({ podSelector: {}, policyTypes: ["Ingress", "Egress"] });
  });

  it("lets in only Traefik, never another business's namespace", () => {
    const from = peers("ingress");
    expect(from.length).toBeGreaterThan(0);
    for (const peer of from) {
      expect(peer.ipBlock).toBeUndefined();
      expect(peer.namespaceSelector?.matchLabels).toEqual({
        "kubernetes.io/metadata.name": "traefik",
      });
    }
  });

  it("may call out only to DNS and the Postgres subnet: no other business, metadata, or internet", () => {
    const to = peers("egress");
    const namespaces = to.flatMap((peer) =>
      peer.namespaceSelector ? [peer.namespaceSelector.matchLabels] : []
    );
    expect(namespaces).toEqual([{ "kubernetes.io/metadata.name": "kube-system" }]);
    expect(to.flatMap((peer) => (peer.ipBlock ? [peer.ipBlock.cidr] : []))).toEqual([
      POSTGRES_CIDR,
    ]);
    // Every egress rule names who it is to; a rule with no `to` would let the pod reach anywhere.
    for (const rule of rules("egress")) expect(rule.to?.length).toBeGreaterThan(0);
    // Instance metadata, the Azure wire server, and an internet address.
    for (const address of ["169.254.169.254", "168.63.129.16", "1.1.1.1"])
      expect([address, inCidr(address, POSTGRES_CIDR)]).toEqual([address, false]);
  });

  it("gets no Kubernetes API token and no other Service's address", () => {
    const deployment = objects.find(({ kind }) => kind === "Deployment");
    expect(deployment?.spec?.template).toMatchObject({
      spec: {
        automountServiceAccountToken: false,
        enableServiceLinks: false,
      },
    });
  });

  it("serves only its own pods, at an address no other app shares", () => {
    const service = objects.find(({ kind }) => kind === "Service");
    expect(service?.spec?.selector).toMatchObject({ "schmeide.app/tenant": String(A) });
    expect(copyUrl(appA)).not.toBe(copyUrl(appB));
  });

  it("runs images only from its own business's repositories, and builds push only there", () => {
    const deployment = JSON.stringify(objects.find(({ kind }) => kind === "Deployment"));
    const images = [...deployment.matchAll(/"image":"([^"]+)"/g)].map((match) => match[1]);
    expect(images.length).toBeGreaterThan(0);
    for (const image of images) expect(image).toContain(`/apps/t${A}/`);
    const pushes = taskYaml(A, "bakery", "abc123");
    expect(pushes).toContain(imageRepos(A, "bakery").web);
    expect(pushes).not.toContain(`t${B}`);
    expect(imageRepos(A, "bakery").web).not.toBe(imageRepos(B, "bakery").web);
  });
});

describe("an app's database", () => {
  // As the test Postgres's superuser, in its `postgres` database.
  const adminUrl = new URL(process.env.DATABASE_URL ?? "");
  const platformDatabase = adminUrl.pathname.slice(1);
  adminUrl.pathname = "/postgres";
  const suffix = randomBytes(4).toString("hex");
  const provisioner = `provisioner_${suffix}`;
  const provisionerUrl = new URL(adminUrl);
  provisionerUrl.username = provisioner;
  provisionerUrl.password = newPassword();
  const databases = createAppDatabases(provisionerUrl.href);
  // Two copies, one in each business, each with its own role and password.
  const nameA = `${databaseName(appA.projectId, "production")}_${suffix}`;
  const nameB = `${databaseName(appB.projectId, "production")}_${suffix}`;
  const passwordA = newPassword();
  const passwordB = newPassword();

  const asAdmin = async <T>(work: (client: pg.Client) => Promise<T>): Promise<T> => {
    const client = new pg.Client({ connectionString: adminUrl.href });
    await client.connect();
    try {
      return await work(client);
    } finally {
      await client.end();
    }
  };
  // Signs in as `user` to `database` and runs `sql`: what Postgres answered, or why it refused.
  const tryAs = async (user: string, password: string, database: string, sql = "SELECT 1") => {
    const url = new URL(adminUrl);
    url.username = user;
    url.password = password;
    url.pathname = `/${database}`;
    const client = new pg.Client({ connectionString: url.href });
    try {
      await client.connect();
      await client.query(sql);
      return "allowed";
    } catch (error) {
      return (error as { code?: string }).code ?? String(error);
    } finally {
      await client.end().catch(() => undefined);
    }
  };

  beforeAll(async () => {
    await asAdmin(async (client) => {
      await client.query(
        `CREATE ROLE ${provisioner} LOGIN CREATEDB CREATEROLE PASSWORD '${provisionerUrl.password}'`
      );
      await client.query(`DROP DATABASE IF EXISTS ${APP_DATABASE_TEMPLATE}`);
      await client.query(`CREATE DATABASE ${APP_DATABASE_TEMPLATE} OWNER ${provisioner}`);
    });
    await databases.ensure(nameA, passwordA);
    await databases.ensure(nameB, passwordB);
    // B keeps something in its database for A to try to read.
    const made = await tryAs(nameB, passwordB, nameB, "CREATE TABLE secrets AS SELECT 1 AS note");
    if (made !== "allowed") throw new Error(`B could not use its own database: ${made}`);
  });
  afterAll(() =>
    asAdmin(async (client) => {
      for (const name of [nameA, nameB]) {
        await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
        await client.query(`DROP ROLE IF EXISTS ${name}`);
      }
      await client.query(`DROP DATABASE IF EXISTS ${APP_DATABASE_TEMPLATE}`);
      await client.query(`DROP ROLE IF EXISTS ${provisioner}`);
    })
  );

  it("lets its own role in", async () => {
    expect(await tryAs(nameA, passwordA, nameA)).toBe("allowed");
    expect(appDatabaseUrl("db", nameA, passwordA)).toContain(`/${nameA}?`);
  });

  it("refuses another business's role, with its own password or B's", async () => {
    // 42501: insufficient privilege (no CONNECT). 28P01: wrong password.
    expect(await tryAs(nameA, passwordA, nameB)).toBe("42501");
    expect(await tryAs(nameA, passwordB, nameB)).toBe("28P01");
  });

  it("refuses anyone with no password or a guessed one", async () => {
    expect(await tryAs(nameB, "", nameB)).not.toBe("allowed");
    expect(await tryAs(nameB, newPassword(), nameB)).toBe("28P01");
  });

  it("gives its role no way into another's: no membership, no superuser, no role or database making", async () => {
    const role = await asAdmin(
      async (client) =>
        (
          await client.query(
            `SELECT rolsuper, rolcreaterole, rolcreatedb, rolbypassrls,
                    pg_has_role($1, $2, 'MEMBER') AS "inB"
               FROM pg_roles WHERE rolname = $1`,
            [nameA, nameB]
          )
        ).rows[0]
    );
    expect(role).toEqual({
      rolsuper: false,
      rolcreaterole: false,
      rolcreatedb: false,
      rolbypassrls: false,
      inB: false,
    });
    expect(await tryAs(nameA, passwordA, nameA, `SET ROLE ${nameB}`)).toBe("42501");
  });

  it("cannot read the platform's data, and the startup check names the platform databases left open", async () => {
    // An admin revokes CONNECT on the platform's databases in production (appDatabases.ts); the
    // test Postgres leaves it open, so its role can at most connect, never read.
    expect(await tryAs(nameA, passwordA, platformDatabase, "SELECT email FROM users")).not.toBe(
      "allowed"
    );
    const { open } = await databases.rights();
    expect(open).not.toContain(nameA);
    expect(open).not.toContain(nameB);
    for (const name of open) expect(PLATFORM_DATABASES).toContain(name);
  });
});

describe("an app's code", () => {
  const calls: { readonly method: string; readonly path: string; readonly body: unknown }[] = [];
  const forgejo = createForgejo({
    url: "http://forgejo.test",
    sshUrl: "ssh://git@forgejo.test:2222",
    token: "platform-token",
    fetch: async (url, init) => {
      const path = String(url).replace("http://forgejo.test/api/v1", "");
      calls.push({
        method: init?.method ?? "GET",
        path,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (path === "/user") return Response.json({ login: "schmeide-platform" });
      return new Response(null, { status: init?.method === "GET" ? 404 : 201 });
    },
  });

  it("lives in an organization of its own business, private", async () => {
    expect(orgOf(A)).not.toBe(orgOf(B));
    await forgejo.ensureRepo(orgOf(A), "bakery");
    expect(calls.filter(({ method }) => method === "POST")).toEqual([
      { method: "POST", path: "/orgs", body: { username: orgOf(A), visibility: "private" } },
      {
        method: "POST",
        path: `/orgs/${orgOf(A)}/repos`,
        body: { name: "bakery", private: true },
      },
    ]);
    expect(forgejo.sshRemote(orgOf(A), "bakery")).not.toBe(forgejo.sshRemote(orgOf(B), "bakery"));
  });

  it("gives a run's deploy key to one repository only", async () => {
    calls.length = 0;
    await forgejo.addDeployKey(orgOf(A), "bakery", "run-1", "ecdsa-sha2-nistp256 AAAA", false);
    expect(calls.map(({ path }) => path)).toEqual([`/repos/${orgOf(A)}/bakery/keys`]);
  });

  it("lets no deploy key, its own business's included, push main", async () => {
    calls.length = 0;
    await forgejo.protectMain(orgOf(A), "bakery");
    expect(calls.find(({ method }) => method === "POST")?.body).toMatchObject({
      rule_name: "main",
      enable_push_whitelist: true,
      push_whitelist_usernames: ["schmeide-platform"],
      push_whitelist_deploy_keys: false,
    });
  });
});

describe("the session cookie", () => {
  const db = createDb(process.env.DATABASE_URL ?? "");
  afterAll(() => db.$client.end());
  const depsAt = (publicUrl: string): AppContext => ({
    db,
    workflows: { start: vi.fn(), getHandle: vi.fn() } as never,
    taskQueue: "test",
    interviewer: vi.fn(),
    siteFetcher: vi.fn(),
    websiteReader: vi.fn(),
    files: { put: vi.fn(), get: vi.fn(), remove: vi.fn(), removeProject: vi.fn() },
    resources: {} as never,
    reader: vi.fn(),
    auth: testAuth(db, { publicUrl, apiUrl: `${publicUrl}/api` }),
    providers: [],
  });
  const local = depsAt("http://localhost:5173");
  const app = buildApp(local);
  afterAll(() => app.close());

  it("is kept to the platform's own host, out of every app's reach", async () => {
    const { email } = await aSignedInPerson(app, local);
    const { cookies } = await signIn(app, email);
    expect(cookies.length).toBeGreaterThan(0);
    for (const cookie of cookies)
      expect([cookie.name, cookie.domain, cookie.httpOnly, cookie.sameSite?.toLowerCase()]).toEqual(
        [cookie.name, undefined, true, "lax"]
      );
  });

  it("is sent only over https, under a prefix a plain-http app cannot set, on the real site", async () => {
    const site = "https://schmeide.com";
    const deps = depsAt(site);
    const secure = buildApp(deps);
    try {
      // Made through the local app; the same person signs in on the real site.
      const { email } = await aSignedInPerson(app, local);
      const response = await secure.inject({
        method: "POST",
        url: "/auth/sign-in/email",
        headers: { origin: site },
        payload: { email, password: PASSWORD },
      });
      expect(response.statusCode).toBe(200);
      for (const cookie of response.cookies)
        expect([cookie.name.startsWith("__Secure-"), cookie.secure, cookie.domain]).toEqual([
          true,
          true,
          undefined,
        ]);
    } finally {
      await secure.close();
    }
  });

  it("lives on a host no app is served from", () => {
    for (const app of [appA, appB])
      expect(new URL(copyUrl(app)).hostname.endsWith(`.${app.domain}`)).toBe(true);
    expect(new URL(copyUrl(appA)).hostname).not.toBe("schmeide.com");
  });
});
