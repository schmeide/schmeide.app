// App images on ACR Tasks (docs/stage2.md, "Deploy and hosting"): the worker uploads a project's
// tree as the build context, schedules one quick run that builds and pushes its web and api
// images, and follows it; a delete removes both repositories. The worker signs in to Azure as its
// workload identity by exchanging its federated token, with fetch: three ARM calls and two token
// exchanges do not justify @azure/identity and the ARM SDK.
import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { imageRepos } from "../kube/apps.ts";

// The registry tasks API version that knows `[caller]` (source registry identity).
export const TASKS_API_VERSION = "2025-03-01-preview";
const ARM = "https://management.azure.com";

export type AzureIdentity = {
  // What the Azure Workload Identity webhook injects into the worker's pod.
  readonly clientId: string;
  readonly tenantId: string;
  readonly federatedTokenFile: string;
  readonly authorityHost: string;
};

export type AcrConfig = {
  readonly identity: AzureIdentity;
  readonly subscriptionId: string;
  readonly resourceGroup: string;
  readonly name: string;
  readonly loginServer: string;
  readonly fetch?: typeof fetch;
  readonly pollMs?: number;
};

export class AcrError extends Error {}

// The token request for one scope, from the federated token on disk.
export const tokenRequest = (
  identity: AzureIdentity,
  assertion: string,
  scope: string
): { readonly url: string; readonly body: URLSearchParams } => ({
  url: `${identity.authorityHost.replace(/\/*$/, "/")}${identity.tenantId}/oauth2/v2.0/token`,
  body: new URLSearchParams({
    grant_type: "client_credentials",
    client_id: identity.clientId,
    client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    client_assertion: assertion,
    scope,
  }),
});

// tar's flags for a build context ACR can read: no pax or extended-attribute headers, which fail
// with "failed to download context". `version` is what `tar --version` printed: GNU tar in the
// worker's image, bsdtar on a Mac.
export const contextTarFlags = (version: string): readonly string[] => [
  ...(version.includes("GNU tar")
    ? ["--format=gnu", "--no-xattrs", "--no-acls", "--no-selinux"]
    : ["--no-xattrs", "--no-mac-metadata"]),
  "--exclude=.git",
];

// One run that builds both images from the platform-owned Dockerfiles and pushes them tagged with
// the commit. The registry is the run's own ({{.Run.Registry}}), signed in to as the caller: in ABAC
// mode a quick run has no other way to push. That sign-in sits in every `cmd` step's home and Docker
// socket, so the project's code runs only inside `build` steps, which see neither (#214): the web
// image bundles the frontend in its own build stage.
export const taskYaml = (tenantId: number, slug: string, commit: string): string => {
  const repos = imageRepos(tenantId, slug);
  const web = `{{.Run.Registry}}/${repos.web}:${commit}`;
  const api = `{{.Run.Registry}}/${repos.api}:${commit}`;
  return [
    "version: v1.1.0",
    "steps:",
    `  - build: -t ${web} -f frontend/Dockerfile .`,
    `  - build: -t ${api} -f backend/Dockerfile .`,
    "  - push:",
    `    - ${web}`,
    `    - ${api}`,
    "",
  ].join("\n");
};

export const runRequest = (sourceLocation: string, yaml: string) => ({
  type: "EncodedTaskRunRequest",
  encodedTaskContent: Buffer.from(yaml).toString("base64"),
  sourceLocation,
  timeout: 1800,
  platform: { os: "Linux", architecture: "amd64" },
  credentials: { sourceRegistry: { identity: "[caller]" } },
});

const DONE = new Set(["Succeeded", "Failed", "Canceled", "Error", "Timeout"]);

export const createAcr = (config: AcrConfig) => {
  const call = config.fetch ?? fetch;
  const tokens = new Map<string, { readonly token: string; readonly until: number }>();
  const token = async (scope: string): Promise<string> => {
    const cached = tokens.get(scope);
    if (cached && cached.until > Date.now()) return cached.token;
    // Read every time: the kubelet rotates it.
    const assertion = (await readFile(config.identity.federatedTokenFile, "utf8")).trim();
    const { url, body } = tokenRequest(config.identity, assertion, scope);
    const response = await call(url, { method: "POST", body });
    if (!response.ok)
      throw new AcrError(
        `Azure sign-in as ${config.identity.clientId} answered ${response.status}: ${(await response.text()).slice(0, 500)}`
      );
    const { access_token, expires_in } = (await response.json()) as {
      access_token: string;
      expires_in: number;
    };
    tokens.set(scope, { token: access_token, until: Date.now() + (expires_in - 300) * 1000 });
    return access_token;
  };
  const armToken = () => token(`${ARM}/.default`);
  const registry = `${ARM}/subscriptions/${config.subscriptionId}/resourceGroups/${config.resourceGroup}/providers/Microsoft.ContainerRegistry/registries/${config.name}`;
  const arm = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const response = await call(`${registry}${path}?api-version=${TASKS_API_VERSION}`, {
      method,
      headers: {
        authorization: `Bearer ${await armToken()}`,
        ...(body !== undefined && { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok)
      throw new AcrError(
        `ACR ${method} ${path} answered ${response.status}: ${(await response.text()).slice(0, 500)}`
      );
    return (await response.json()) as T;
  };
  // The tail of a failed run's log, with where to read all of it.
  const failure = async (runId: string, status: string): Promise<string> => {
    const { logLink } = await arm<{ logLink?: string }>("POST", `/runs/${runId}/listLogSasUrl`);
    const log = logLink
      ? await call(logLink)
          .then((response) => response.text())
          .catch(() => "")
      : "";
    return `The image build (ACR run ${runId}) ended ${status}.${log ? `\n${log.slice(-3000)}` : ""}${logLink ? `\nFull log: ${logLink}` : ""}`;
  };

  return {
    armToken,

    // Uploads the tar.gz at `archive` and runs `yaml` on it; resolves when the run succeeded.
    build: async (
      archive: string,
      yaml: string,
      options: { readonly signal?: AbortSignal; readonly onQueued?: (runId: string) => void } = {}
    ): Promise<void> => {
      const { uploadUrl, relativePath } = await arm<{ uploadUrl: string; relativePath: string }>(
        "POST",
        "/listBuildSourceUploadUrl"
      );
      const upload = await call(uploadUrl, {
        method: "PUT",
        headers: { "x-ms-blob-type": "BlockBlob" },
        body: await readFile(archive),
      });
      if (!upload.ok) throw new AcrError(`Uploading the build context answered ${upload.status}`);
      const run = await arm<{ properties: { runId: string } }>(
        "POST",
        "/scheduleRun",
        runRequest(relativePath, yaml)
      );
      const { runId } = run.properties;
      options.onQueued?.(runId);
      for (;;) {
        await sleep(config.pollMs ?? 5000, undefined, { signal: options.signal });
        const { status } = (await arm<{ properties: { status: string } }>("GET", `/runs/${runId}`))
          .properties;
        if (status === "Succeeded") return;
        if (DONE.has(status)) throw new AcrError(await failure(runId, status));
      }
    },

    // Deletes the app's web and api repositories with the registry's own API, which takes a
    // registry token from the ARM one. Gone already is done.
    deleteImages: async (tenantId: number, slug: string): Promise<void> => {
      const service = config.loginServer;
      const exchange = await call(`https://${service}/oauth2/exchange`, {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "access_token",
          service,
          tenant: config.identity.tenantId,
          access_token: await armToken(),
        }),
      });
      if (!exchange.ok)
        throw new AcrError(`The registry's token exchange answered ${exchange.status}`);
      const { refresh_token } = (await exchange.json()) as { refresh_token: string };
      for (const repo of Object.values(imageRepos(tenantId, slug))) {
        const granted = await call(`https://${service}/oauth2/token`, {
          method: "POST",
          body: new URLSearchParams({
            grant_type: "refresh_token",
            service,
            scope: `repository:${repo}:delete`,
            refresh_token,
          }),
        });
        if (!granted.ok) throw new AcrError(`The registry's token answered ${granted.status}`);
        const { access_token } = (await granted.json()) as { access_token: string };
        const deleted = await call(`https://${service}/acr/v1/${repo}`, {
          method: "DELETE",
          headers: { authorization: `Bearer ${access_token}` },
        });
        if (!deleted.ok && deleted.status !== 404)
          throw new AcrError(`Deleting ${repo} answered ${deleted.status}`);
      }
    },
  };
};

export type Acr = ReturnType<typeof createAcr>;
