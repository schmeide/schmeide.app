// SCHMEIDE_RUNNER (docs/stage2.md, "Mode switch"): `host`, the default, builds on this machine as
// dev mode always has; `kubernetes` keeps each project on Forgejo and runs the agent and the checks
// as Jobs in the builds namespace. Read here, from the environment, and checked once at startup.
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  createCluster,
  createKube,
  inClusterConfig,
  KubeError,
  SERVICE_ACCOUNT_DIR,
} from "./kube/client.ts";
import { ANTHROPIC_SECRET, BUILDS_NAMESPACE, POSTGRES_IMAGE } from "./kube/jobs.ts";
import { createAcr } from "./services/acr.ts";
import { APP_DATABASE_TEMPLATE, createAppDatabases } from "./services/appDatabases.ts";
import { createForgejo } from "./services/forgejo.ts";
import type { KubeRunner } from "./temporal/activities.ts";

type Env = Readonly<Record<string, string | undefined>>;

export const parseRunner = (value: string | undefined): "host" | "kubernetes" => {
  const runner = value ?? "host";
  if (runner !== "host" && runner !== "kubernetes")
    throw new Error(`SCHMEIDE_RUNNER is "${runner}"; set it to host (the default) or kubernetes.`);
  return runner;
};

// What Kubernetes mode reads, each with what to set it to.
const NEEDED = {
  SCHMEIDE_BUILD_IMAGE: "the server's own image, such as schmeide.azurecr.io/schmeide-app:<sha>",
  SCHMEIDE_FORGEJO_TOKEN: "an API token of the schmeide-platform Forgejo user",
  // The Azure Workload Identity webhook injects these four.
  AZURE_CLIENT_ID:
    'the worker\'s workload identity; label its pod azure.workload.identity/use: "true"',
  AZURE_TENANT_ID: "injected with AZURE_CLIENT_ID",
  AZURE_FEDERATED_TOKEN_FILE: "injected with AZURE_CLIENT_ID",
  AZURE_AUTHORITY_HOST: "injected with AZURE_CLIENT_ID",
  SCHMEIDE_AZURE_SUBSCRIPTION_ID: "the subscription of the registry",
  SCHMEIDE_ACR_RESOURCE_GROUP: "the registry's resource group",
  SCHMEIDE_ACR_NAME: "the registry's name, such as schmeide",
  SCHMEIDE_ACR_LOGIN_SERVER: "the registry's login server, such as schmeide.azurecr.io",
  SCHMEIDE_APPS_DOMAIN: "the domain apps are served under, such as apps.schmeide.com",
  SCHMEIDE_PROVISIONER_URL:
    "a postgres:// URL of the schmeide_provisioner role (CREATEDB, CREATEROLE) on the shared server",
  SCHMEIDE_APP_DATABASE_HOST: "the shared server's host name as app pods reach it",
} as const;

// Everything Kubernetes mode needs from the environment, or one error naming all that is missing.
export const runnerFromEnv = (env: Env): KubeRunner => {
  const cluster = inClusterConfig(env, BUILDS_NAMESPACE);
  const value = (name: keyof typeof NEEDED): string => env[name] ?? "";
  const missing = [
    ...(cluster
      ? []
      : ["KUBERNETES_SERVICE_HOST and KUBERNETES_SERVICE_PORT (run the worker in the cluster)"]),
    ...Object.entries(NEEDED)
      .filter(([name]) => !env[name])
      .map(([name, hint]) => `${name} (${hint})`),
  ];
  if (!cluster || missing.length > 0)
    throw new Error(`SCHMEIDE_RUNNER=kubernetes needs ${missing.join("; ")}.`);
  return {
    kube: createKube(cluster),
    forgejo: createForgejo({
      url: env.SCHMEIDE_FORGEJO_URL ?? "http://forgejo-http.forgejo.svc.cluster.local:3000",
      sshUrl: env.SCHMEIDE_FORGEJO_SSH ?? "ssh://git@forgejo-ssh.forgejo.svc.cluster.local",
      token: value("SCHMEIDE_FORGEJO_TOKEN"),
    }),
    image: value("SCHMEIDE_BUILD_IMAGE"),
    postgresImage: env.SCHMEIDE_BUILD_POSTGRES_IMAGE ?? POSTGRES_IMAGE,
    knownHosts: env.SCHMEIDE_FORGEJO_KNOWN_HOSTS,
    hosting: {
      cluster: createCluster(cluster),
      acr: createAcr({
        identity: {
          clientId: value("AZURE_CLIENT_ID"),
          tenantId: value("AZURE_TENANT_ID"),
          federatedTokenFile: value("AZURE_FEDERATED_TOKEN_FILE"),
          authorityHost: value("AZURE_AUTHORITY_HOST"),
        },
        subscriptionId: value("SCHMEIDE_AZURE_SUBSCRIPTION_ID"),
        resourceGroup: value("SCHMEIDE_ACR_RESOURCE_GROUP"),
        name: value("SCHMEIDE_ACR_NAME"),
        loginServer: value("SCHMEIDE_ACR_LOGIN_SERVER"),
      }),
      databases: createAppDatabases(value("SCHMEIDE_PROVISIONER_URL")),
      domain: value("SCHMEIDE_APPS_DOMAIN"),
      registry: value("SCHMEIDE_ACR_LOGIN_SERVER"),
      databaseHost: value("SCHMEIDE_APP_DATABASE_HOST"),
    },
  };
};

// Every call the worker makes in the builds namespace (kube/client.ts).
const RIGHTS = [
  ["create", "batch", "jobs"],
  ["get", "batch", "jobs"],
  ["list", "batch", "jobs"],
  ["delete", "batch", "jobs"],
  ["list", "", "pods"],
  ["get", "", "pods/log"],
  ["create", "", "secrets"],
  ["get", "", "secrets"],
  ["delete", "", "secrets"],
] as const;

const missingRight = (verb: string, resource: string) =>
  `The worker may not ${verb} ${resource} in ${BUILDS_NAMESPACE}. Bind the schmeide-worker Role there to its service account.`;

// What stops the worker building on the cluster, each with its fix; empty when nothing does. As
// `make doctor` does for dev mode.
export const checkRunner = async (
  runner: KubeRunner,
  tokenFile: string = join(SERVICE_ACCOUNT_DIR, "token")
): Promise<readonly string[]> => {
  const problems: string[] = [];
  await runner.forgejo.whoami().catch((error: unknown) => {
    problems.push(
      `Cannot use Forgejo (${String(error)}). Check SCHMEIDE_FORGEJO_URL and that SCHMEIDE_FORGEJO_TOKEN is a token of the schmeide-platform user.`
    );
  });
  await runner.hosting.acr.armToken().catch((error: unknown) => {
    problems.push(
      `Cannot sign in to Azure (${String(error)}). Give the worker's managed identity a federated credential for system:serviceaccount:schmeide-app:schmeide-worker, and annotate that service account with its azure.workload.identity/client-id.`
    );
  });
  await runner.hosting.databases.rights().then(
    (rights) => {
      if (!rights.createDb || !rights.createRole)
        problems.push(
          "The role in SCHMEIDE_PROVISIONER_URL may not create databases and roles. ALTER ROLE schmeide_provisioner CREATEDB CREATEROLE."
        );
      if (!rights.template)
        problems.push(
          `The provisioner has no ${APP_DATABASE_TEMPLATE} database to copy app databases from. Make it as described in schmeide/iac gitops/README.md (the provisioner creates it, an admin runs ALTER SCHEMA public OWNER TO pg_database_owner in it).`
        );
    },
    (error: unknown) => {
      problems.push(
        `Cannot sign in to Postgres as the provisioner (${String(error)}). Check SCHMEIDE_PROVISIONER_URL and that the provisioner password in it is current.`
      );
    }
  );
  if (!existsSync(tokenFile)) {
    problems.push(
      `No service account token at ${tokenFile}. Give the worker Deployment serviceAccountName: schmeide-worker and automountServiceAccountToken: true.`
    );
    return problems;
  }
  try {
    for (const [verb, group, resource] of RIGHTS)
      if (!(await runner.kube.canI(verb, group, resource)))
        problems.push(missingRight(verb, resource));
    if (!(await runner.kube.secretExists(ANTHROPIC_SECRET.name)))
      problems.push(
        `There is no Secret ${ANTHROPIC_SECRET.name} in ${BUILDS_NAMESPACE}. Project the builds model key into it, under the key "${ANTHROPIC_SECRET.key}".`
      );
  } catch (error) {
    if (error instanceof KubeError && error.status === 403) {
      // The one call above that is not a review: reading the model key's Secret.
      if (!problems.includes(missingRight("get", "secrets")))
        problems.push(missingRight("get", "secrets"));
      return problems;
    }
    problems.push(
      `Cannot reach the Kubernetes API (${String(error)}). Set NODE_EXTRA_CA_CERTS=${join(SERVICE_ACCOUNT_DIR, "ca.crt")} on the worker so it trusts the cluster's CA.`
    );
  }
  return problems;
};
