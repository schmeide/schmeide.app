import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { KubeError, type Kube } from "../kube/client.ts";
import type { Forgejo } from "../services/forgejo.ts";
import { checkRunner, parseRunner, refuseDesignTeam, runnerFromEnv } from "../runner.ts";

const cluster = {
  KUBERNETES_SERVICE_HOST: "10.0.0.1",
  KUBERNETES_SERVICE_PORT: "443",
  SCHMEIDE_BUILD_IMAGE: "schmeide.azurecr.io/schmeide-app:abc",
  SCHMEIDE_FORGEJO_TOKEN: "token",
  AZURE_CLIENT_ID: "client",
  AZURE_TENANT_ID: "tenant",
  AZURE_FEDERATED_TOKEN_FILE: "/var/run/secrets/azure/tokens/azure-identity-token",
  AZURE_AUTHORITY_HOST: "https://login.microsoftonline.com/",
  SCHMEIDE_AZURE_SUBSCRIPTION_ID: "sub",
  SCHMEIDE_ACR_RESOURCE_GROUP: "rg",
  SCHMEIDE_ACR_NAME: "schmeide",
  SCHMEIDE_ACR_LOGIN_SERVER: "schmeide.azurecr.io",
  SCHMEIDE_APPS_DOMAIN: "apps.schmeide.com",
  SCHMEIDE_PROVISIONER_URL: "postgres://schmeide_provisioner:pw@db.example:5432/postgres",
  SCHMEIDE_APP_DATABASE_HOST: "db.example",
};

describe("parseRunner", () => {
  it("runs on the host unless told otherwise, and refuses anything else", () => {
    expect(parseRunner(undefined)).toBe("host");
    expect(parseRunner("kubernetes")).toBe("kubernetes");
    expect(() => parseRunner("docker")).toThrow(/set it to host \(the default\) or kubernetes/);
  });
});

describe("refuseDesignTeam", () => {
  it("refuses the design team on the kubernetes runner, which cannot run it yet (#219)", () => {
    expect(() =>
      refuseDesignTeam({ SCHMEIDE_RUNNER: "kubernetes", SCHMEIDE_DESIGN_TEAM: "1" })
    ).toThrow(/SCHMEIDE_DESIGN_TEAM=1 does not work with SCHMEIDE_RUNNER=kubernetes yet/);
    expect(() => refuseDesignTeam({ SCHMEIDE_RUNNER: "kubernetes" })).not.toThrow();
    expect(() => refuseDesignTeam({ SCHMEIDE_DESIGN_TEAM: "1" })).not.toThrow();
  });
});

describe("runnerFromEnv", () => {
  it("names everything Kubernetes mode is missing at once", () => {
    expect(() => runnerFromEnv({})).toThrow(
      /KUBERNETES_SERVICE_HOST.*SCHMEIDE_BUILD_IMAGE.*SCHMEIDE_FORGEJO_TOKEN.*AZURE_CLIENT_ID.*SCHMEIDE_PROVISIONER_URL.*SCHMEIDE_APP_DATABASE_HOST/
    );
    expect(() => runnerFromEnv({ ...cluster, SCHMEIDE_APPS_DOMAIN: undefined })).toThrow(
      "SCHMEIDE_RUNNER=kubernetes needs SCHMEIDE_APPS_DOMAIN (the domain apps are served under, such as apps.schmeide.com)."
    );
  });

  it("reaches Forgejo on its cluster Services by default", () => {
    const runner = runnerFromEnv(cluster);

    expect(runner.image).toBe(cluster.SCHMEIDE_BUILD_IMAGE);
    expect(runner.forgejo.remote("t1", "notes").url).toBe(
      "http://forgejo-http.forgejo.svc.cluster.local:3000/t1/notes.git"
    );
    expect(runner.forgejo.sshRemote("t1", "notes")).toBe(
      "ssh://git@forgejo-ssh.forgejo.svc.cluster.local/t1/notes.git"
    );
    expect(runner.kube.namespace).toBe("schmeide-builds");
  });
});

describe("checkRunner", () => {
  const tokenFile = () => {
    const file = join(mkdtempSync(join(tmpdir(), "schmeide-sa-")), "token");
    writeFileSync(file, "token");
    return file;
  };
  const runner = (
    kube: Partial<Kube>,
    forgejo: Partial<Forgejo>,
    hosting: {
      readonly armToken?: () => Promise<string>;
      readonly rights?: () => Promise<{
        createDb: boolean;
        createRole: boolean;
        template: boolean;
      }>;
    } = {}
  ) => {
    const real = runnerFromEnv(cluster);
    return {
      ...real,
      kube: { ...real.kube, ...kube },
      forgejo: { ...real.forgejo, ...forgejo },
      hosting: {
        ...real.hosting,
        acr: { ...real.hosting.acr, armToken: hosting.armToken ?? (async () => "arm") },
        databases: {
          ...real.hosting.databases,
          rights:
            hosting.rights ?? (async () => ({ createDb: true, createRole: true, template: true })),
        },
      },
    };
  };

  it("finds nothing wrong when Forgejo answers and the worker has its rights", async () => {
    expect(
      await checkRunner(
        runner(
          { canI: async () => true, secretExists: async () => true },
          { whoami: async () => "schmeide-platform" }
        ),
        tokenFile()
      )
    ).toEqual([]);
  });

  it("names each fix: the Forgejo token, a missing right, the model key", async () => {
    const problems = await checkRunner(
      runner(
        {
          canI: async (verb, _group, resource) => !(verb === "create" && resource === "jobs"),
          secretExists: async () => false,
        },
        {
          whoami: async () => {
            throw new Error("401");
          },
        }
      ),
      tokenFile()
    );

    expect(problems).toEqual([
      expect.stringMatching(/Cannot use Forgejo.*SCHMEIDE_FORGEJO_TOKEN/),
      expect.stringMatching(/may not create jobs in schmeide-builds/),
      expect.stringMatching(/no Secret anthropic-builds/),
    ]);
  });

  it("names the fix when Azure refuses the worker or the provisioner lacks its rights", async () => {
    const problems = await checkRunner(
      runner(
        { canI: async () => true, secretExists: async () => true },
        { whoami: async () => "schmeide-platform" },
        {
          armToken: async () => {
            throw new Error("AADSTS70021");
          },
          rights: async () => ({ createDb: true, createRole: false, template: false }),
        }
      ),
      tokenFile()
    );

    expect(problems).toEqual([
      expect.stringMatching(/Cannot sign in to Azure \(Error: AADSTS70021\).*federated credential/),
      expect.stringMatching(/ALTER ROLE schmeide_provisioner CREATEDB CREATEROLE/),
      expect.stringMatching(
        /no schmeide_app_template database.*ALTER SCHEMA public OWNER TO pg_database_owner/
      ),
    ]);
  });

  it("says to check the provisioner URL when Postgres refuses it", async () => {
    const problems = await checkRunner(
      runner(
        { canI: async () => true, secretExists: async () => true },
        { whoami: async () => "schmeide-platform" },
        {
          rights: async () => {
            throw new Error("password authentication failed");
          },
        }
      ),
      tokenFile()
    );

    expect(problems).toEqual([expect.stringMatching(/SCHMEIDE_PROVISIONER_URL/)]);
  });

  it("says how to mount the service account token when there is none", async () => {
    const problems = await checkRunner(
      runner({}, { whoami: async () => "schmeide-platform" }),
      "/nowhere/token"
    );

    expect(problems).toEqual([expect.stringMatching(/automountServiceAccountToken: true/)]);
  });

  it("asks for every right the worker uses", async () => {
    const asked: string[] = [];
    await checkRunner(
      runner(
        {
          canI: async (verb, _group, resource) => {
            asked.push(`${verb} ${resource}`);
            return true;
          },
          secretExists: async () => true,
        },
        { whoami: async () => "schmeide-platform" }
      ),
      tokenFile()
    );

    expect(asked).toEqual(
      expect.arrayContaining(["get jobs", "list pods", "get pods/log", "get secrets"])
    );
  });

  it("calls a refused read of the model key a missing right, not an unreachable API", async () => {
    const problems = await checkRunner(
      runner(
        {
          canI: async () => true,
          secretExists: async () => {
            throw new KubeError(403, "forbidden");
          },
        },
        { whoami: async () => "schmeide-platform" }
      ),
      tokenFile()
    );

    expect(problems).toEqual([
      expect.stringMatching(/may not get secrets.*Bind the schmeide-worker Role/),
    ]);
  });

  it("says how to trust the cluster's CA when the API cannot be reached", async () => {
    const problems = await checkRunner(
      runner(
        {
          canI: async () => {
            throw new TypeError("fetch failed: self-signed certificate in certificate chain");
          },
        },
        { whoami: async () => "schmeide-platform" }
      ),
      tokenFile()
    );

    expect(problems).toEqual([expect.stringMatching(/NODE_EXTRA_CA_CERTS=/)]);
  });
});
