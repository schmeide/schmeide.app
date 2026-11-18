// The Kubernetes API calls the worker makes, with fetch (docs/stage2.md, "Kubernetes access from
// the worker"): create, get, list and delete Jobs, create and delete Secrets, list pods, follow a
// container's log, and ask what the worker may do. That handful does not justify
// @kubernetes/client-node and its dependency tree. In the cluster the token is the projected
// service account token, read for every call because the kubelet rotates it, and the cluster CA
// reaches fetch through NODE_EXTRA_CA_CERTS.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const SERVICE_ACCOUNT_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";

export type KubeConfig = {
  // The API server, as https://host:port.
  readonly server: string;
  // Every call is in this one namespace.
  readonly namespace: string;
  readonly token: () => Promise<string>;
  readonly fetch?: typeof fetch;
};

// What a pod in the cluster is given: the API server's address in its environment and a token
// on disk. Undefined outside a cluster.
export const inClusterConfig = (
  env: Readonly<Record<string, string | undefined>>,
  namespace: string
): KubeConfig | undefined =>
  env.KUBERNETES_SERVICE_HOST && env.KUBERNETES_SERVICE_PORT
    ? {
        server: `https://${env.KUBERNETES_SERVICE_HOST}:${env.KUBERNETES_SERVICE_PORT}`,
        namespace,
        token: async () => (await readFile(join(SERVICE_ACCOUNT_DIR, "token"), "utf8")).trim(),
      }
    : undefined;

export class KubeError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// Only the fields the worker reads.
export type ObjectMeta = {
  readonly name: string;
  readonly uid?: string;
  readonly labels?: Readonly<Record<string, string>>;
};
export type JobCondition = {
  readonly type: string;
  readonly status: string;
  readonly reason?: string;
  readonly message?: string;
};
export type Job = {
  readonly metadata: ObjectMeta;
  readonly status?: { readonly conditions?: readonly JobCondition[] };
};
export type ContainerState = {
  readonly waiting?: { readonly reason?: string; readonly message?: string };
  readonly running?: object;
  readonly terminated?: { readonly exitCode: number; readonly reason?: string };
};
export type Pod = {
  readonly metadata: ObjectMeta;
  readonly status?: {
    readonly phase?: string;
    readonly containerStatuses?: readonly {
      readonly name: string;
      readonly state?: ContainerState;
    }[];
  };
};
export type LogLine = { readonly time: string; readonly text: string };

// Lines of a stream of text, the last one without its newline too.
async function* linesOf(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let rest = "";
  for await (const chunk of body) {
    const lines = (rest + decoder.decode(chunk, { stream: true })).split("\n");
    rest = lines.pop() ?? "";
    yield* lines;
  }
  if (rest) yield rest;
}

type Options = {
  readonly body?: unknown;
  readonly contentType?: string;
  readonly query?: Readonly<Record<string, string | undefined>>;
  readonly signal?: AbortSignal;
};

const requester = (config: Omit<KubeConfig, "namespace">) => {
  const request = async (method: string, path: string, options: Options = {}) => {
    const url = new URL(path, config.server);
    for (const [key, value] of Object.entries(options.query ?? {}))
      if (value !== undefined) url.searchParams.set(key, value);
    const response = await (config.fetch ?? fetch)(url, {
      method,
      headers: {
        authorization: `Bearer ${await config.token()}`,
        accept: "application/json",
        ...(options.body !== undefined && {
          "content-type": options.contentType ?? "application/json",
        }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    });
    if (!response.ok)
      throw new KubeError(
        response.status,
        `${method} ${path} answered ${response.status}: ${(await response.text()).slice(0, 500)}`
      );
    return response;
  };
  const json = async <T>(method: string, path: string, options?: Options): Promise<T> =>
    (await (await request(method, path, options)).json()) as T;
  return { request, json };
};

// A 404 on a get or delete: there is nothing of that name.
const missing = (error: unknown): undefined => {
  if (error instanceof KubeError && error.status === 404) return undefined;
  throw error;
};

export const createKube = (config: KubeConfig) => {
  const name = encodeURIComponent;
  const { request, json } = requester(config);
  const core = `/api/v1/namespaces/${name(config.namespace)}`;
  const batch = `/apis/batch/v1/namespaces/${name(config.namespace)}`;

  return {
    namespace: config.namespace,
    createJob: (job: object) => json<Job>("POST", `${batch}/jobs`, { body: job }),
    getJob: (job: string) => json<Job>("GET", `${batch}/jobs/${name(job)}`).catch(missing),
    listJobs: async (labelSelector: string): Promise<readonly Job[]> =>
      (await json<{ items: readonly Job[] }>("GET", `${batch}/jobs`, { query: { labelSelector } }))
        .items,
    // Foreground waits for the Job's pods to go before the Job does; Background does not.
    deleteJob: async (job: string, propagationPolicy: "Foreground" | "Background") => {
      await request("DELETE", `${batch}/jobs/${name(job)}`, {
        body: { apiVersion: "v1", kind: "DeleteOptions", propagationPolicy },
      }).catch(missing);
    },
    createSecret: async (secret: object) => {
      await request("POST", `${core}/secrets`, { body: secret });
    },
    secretExists: async (secret: string): Promise<boolean> =>
      Boolean(await request("GET", `${core}/secrets/${name(secret)}`).catch(missing)),
    deleteSecret: async (secret: string) => {
      await request("DELETE", `${core}/secrets/${name(secret)}`).catch(missing);
    },
    listPods: async (labelSelector: string): Promise<readonly Pod[]> =>
      (await json<{ items: readonly Pod[] }>("GET", `${core}/pods`, { query: { labelSelector } }))
        .items,
    // Follows the container's log until it exits or the connection drops, each line with the time
    // the kubelet stamped on it, so a reader can start again after the last line it saw.
    async *logLines(
      pod: string,
      container: string,
      options: { readonly sinceTime?: string; readonly signal?: AbortSignal } = {}
    ): AsyncGenerator<LogLine> {
      const response = await request("GET", `${core}/pods/${name(pod)}/log`, {
        query: { container, follow: "true", timestamps: "true", sinceTime: options.sinceTime },
        signal: options.signal,
      });
      if (!response.body) return;
      for await (const line of linesOf(response.body)) {
        const space = line.indexOf(" ");
        yield space < 0
          ? { time: line, text: "" }
          : { time: line.slice(0, space), text: line.slice(space + 1) };
      }
    },
    canI: async (verb: string, group: string, resource: string): Promise<boolean> =>
      (
        await json<{ status?: { allowed?: boolean } }>(
          "POST",
          "/apis/authorization.k8s.io/v1/selfsubjectaccessreviews",
          {
            body: {
              apiVersion: "authorization.k8s.io/v1",
              kind: "SelfSubjectAccessReview",
              spec: { resourceAttributes: { namespace: config.namespace, verb, group, resource } },
            },
          }
        )
      ).status?.allowed === true,
  };
};

export type Kube = ReturnType<typeof createKube>;

export type DeploymentStatus = {
  readonly metadata: ObjectMeta & { readonly generation?: number };
  readonly spec?: { readonly replicas?: number };
  readonly status?: {
    readonly observedGeneration?: number;
    readonly replicas?: number;
    readonly updatedReplicas?: number;
    readonly availableReplicas?: number;
    readonly conditions?: readonly JobCondition[];
  };
};

// The calls that put apps in tenant namespaces (kube/apps.ts), by each object's own path rather
// than one namespace: server-side apply, read, scale, and delete.
export const createCluster = (config: Omit<KubeConfig, "namespace">) => {
  const { request, json } = requester(config);
  return {
    // Creates or updates `object` to exactly what is given, taking over fields another manager set.
    apply: async (path: string, object: object) => {
      await request("PATCH", path, {
        body: object,
        contentType: "application/apply-patch+yaml",
        query: { fieldManager: "schmeide-worker", force: "true" },
      });
    },
    // Creates `object` at its `path`; false when something of that name is already there.
    create: async (path: string, object: object): Promise<boolean> =>
      request("POST", path.slice(0, path.lastIndexOf("/")), {
        body: object,
        query: { fieldManager: "schmeide-worker" },
      }).then(
        () => true,
        (error: unknown) => {
          if (error instanceof KubeError && error.status === 409) return false;
          throw error;
        }
      ),
    get: <T>(path: string): Promise<T | undefined> => json<T>("GET", path).catch(missing),
    scale: async (deploymentPath: string, replicas: number) => {
      await request("PATCH", deploymentPath, {
        body: { spec: { replicas } },
        contentType: "application/merge-patch+json",
      }).catch(missing);
    },
    remove: async (path: string) => {
      await request("DELETE", path).catch(missing);
    },
  };
};

export type Cluster = ReturnType<typeof createCluster>;
