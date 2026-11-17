// SCHMEIDE_RUNNER (docs/stage2.md, "Mode switch"): `host`, the default, builds on this machine as
// dev mode always has; `kubernetes` keeps each project on Forgejo and runs the agent and the checks
// as Jobs in the builds namespace. Read here, from the environment, and checked once at startup.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createKube, inClusterConfig, KubeError, SERVICE_ACCOUNT_DIR } from "./kube/client.ts";
import { ANTHROPIC_SECRET, BUILDS_NAMESPACE, POSTGRES_IMAGE } from "./kube/jobs.ts";
import { createForgejo } from "./services/forgejo.ts";
import type { KubeRunner } from "./temporal/activities.ts";

type Env = Readonly<Record<string, string | undefined>>;

export const parseRunner = (value: string | undefined): "host" | "kubernetes" => {
  const runner = value ?? "host";
  if (runner !== "host" && runner !== "kubernetes")
    throw new Error(`SCHMEIDE_RUNNER is "${runner}"; set it to host (the default) or kubernetes.`);
  return runner;
};

// Everything Kubernetes mode needs from the environment, or one error naming all that is missing.
export const runnerFromEnv = (env: Env): KubeRunner => {
  const cluster = inClusterConfig(env, BUILDS_NAMESPACE);
  const missing = [
    !cluster &&
      "KUBERNETES_SERVICE_HOST and KUBERNETES_SERVICE_PORT (run the worker in the cluster)",
    !env.SCHMEIDE_BUILD_IMAGE &&
      "SCHMEIDE_BUILD_IMAGE (the server's own image, such as schmeide.azurecr.io/schmeide-app:<sha>)",
    !env.SCHMEIDE_FORGEJO_TOKEN &&
      "SCHMEIDE_FORGEJO_TOKEN (an API token of the schmeide-platform Forgejo user)",
  ].filter((text): text is string => typeof text === "string");
  if (!cluster || !env.SCHMEIDE_BUILD_IMAGE || !env.SCHMEIDE_FORGEJO_TOKEN)
    throw new Error(`SCHMEIDE_RUNNER=kubernetes needs ${missing.join("; ")}.`);
  return {
    kube: createKube(cluster),
    forgejo: createForgejo({
      url: env.SCHMEIDE_FORGEJO_URL ?? "http://forgejo-http.forgejo.svc.cluster.local:3000",
      sshUrl: env.SCHMEIDE_FORGEJO_SSH ?? "ssh://git@forgejo-ssh.forgejo.svc.cluster.local",
      token: env.SCHMEIDE_FORGEJO_TOKEN,
    }),
    image: env.SCHMEIDE_BUILD_IMAGE,
    postgresImage: env.SCHMEIDE_BUILD_POSTGRES_IMAGE ?? POSTGRES_IMAGE,
    knownHosts: env.SCHMEIDE_FORGEJO_KNOWN_HOSTS,
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
