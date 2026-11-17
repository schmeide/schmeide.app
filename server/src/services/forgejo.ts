// Project repositories on the in-cluster Forgejo (docs/stage2.md, "Code: Forgejo repositories"):
// organization t<tenant id>, repository <project slug>, branches `staging` (the builder's, which a
// discard may rewrite) and `main` (production's, which only moves forward). The worker calls it
// with the schmeide-platform user's token; a build pod gets one deploy key for one repository.
import { generateKeyPairSync } from "node:crypto";

export type ForgejoConfig = {
  // Forgejo's HTTP address, for the API and for the worker's git.
  readonly url: string;
  // Forgejo's SSH address as build pods reach it, such as ssh://git@forgejo-ssh.forgejo.svc.cluster.local.
  readonly sshUrl: string;
  readonly token: string;
  readonly fetch?: typeof fetch;
};

export const orgOf = (tenantId: number): string => `t${tenantId}`;

export class ForgejoError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// An SSH key pair for one run: an ECDSA P-256 key, because Node writes it in a PEM form ssh
// reads, and builds its OpenSSH public key from the curve point.
export const deployKeyPair = (): { readonly privateKey: string; readonly publicKey: string } => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const point = Buffer.concat([
    Buffer.from([4]),
    Buffer.from(jwk.x ?? "", "base64url"),
    Buffer.from(jwk.y ?? "", "base64url"),
  ]);
  const field = (bytes: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    return Buffer.concat([length, bytes]);
  };
  const type = "ecdsa-sha2-nistp256";
  const blob = Buffer.concat([
    field(Buffer.from(type)),
    field(Buffer.from("nistp256")),
    field(point),
  ]);
  return {
    privateKey: privateKey.export({ format: "pem", type: "sec1" }).toString(),
    publicKey: `${type} ${blob.toString("base64")}`,
  };
};

export const createForgejo = (config: ForgejoConfig) => {
  const base = config.url.replace(/\/+$/, "");
  const name = encodeURIComponent;
  const call = async (method: string, path: string, body?: unknown): Promise<Response> => {
    const response = await (config.fetch ?? fetch)(`${base}/api/v1${path}`, {
      method,
      headers: {
        authorization: `token ${config.token}`,
        accept: "application/json",
        ...(body !== undefined && { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok && response.status !== 404)
      throw new ForgejoError(
        response.status,
        `Forgejo ${method} ${path} answered ${response.status}: ${(await response.text()).slice(0, 500)}`
      );
    return response;
  };
  const exists = async (path: string) => (await call("GET", path)).status !== 404;
  const repoPath = (org: string, repo: string) => `/repos/${name(org)}/${name(repo)}`;
  // The token's user, which is the one user allowed to push main.
  const whoami = async (): Promise<string> => {
    const response = await call("GET", "/user");
    if (response.status === 404) throw new ForgejoError(404, "Forgejo has no /api/v1/user");
    return ((await response.json()) as { login: string }).login;
  };

  return {
    whoami,
    ensureRepo: async (org: string, repo: string): Promise<void> => {
      if (!(await exists(`/orgs/${name(org)}`)))
        await call("POST", "/orgs", { username: org, visibility: "private" });
      if (!(await exists(repoPath(org, repo))))
        await call("POST", `/orgs/${name(org)}/repos`, { name: repo, private: true });
    },

    branchCommit: async (org: string, repo: string, branch: string) => {
      const response = await call("GET", `${repoPath(org, repo)}/branches/${name(branch)}`);
      return response.status === 404
        ? undefined
        : ((await response.json()) as { commit: { id: string } }).commit.id;
    },

    // Only the platform user may push main, and nobody may force-push it (decision 13); deploy
    // keys, which build pods hold, may not push it at all.
    protectMain: async (org: string, repo: string): Promise<void> => {
      if (await exists(`${repoPath(org, repo)}/branch_protections/main`)) return;
      await call("POST", `${repoPath(org, repo)}/branch_protections`, {
        rule_name: "main",
        enable_push: true,
        enable_push_whitelist: true,
        push_whitelist_usernames: [await whoami()],
        push_whitelist_deploy_keys: false,
      });
    },

    addDeployKey: async (
      org: string,
      repo: string,
      title: string,
      key: string,
      readOnly: boolean
    ): Promise<void> => {
      await call("POST", `${repoPath(org, repo)}/keys`, { title, key, read_only: readOnly });
    },

    deleteDeployKeys: async (
      org: string,
      repo: string,
      pick: (title: string) => boolean
    ): Promise<void> => {
      for (let page = 1; ; page++) {
        const response = await call("GET", `${repoPath(org, repo)}/keys?limit=50&page=${page}`);
        if (response.status === 404) return;
        const keys = (await response.json()) as readonly { id: number; title: string }[];
        for (const key of keys.filter(({ title }) => pick(title)))
          await call("DELETE", `${repoPath(org, repo)}/keys/${key.id}`);
        if (keys.length < 50) return;
      }
    },

    deleteRepo: async (org: string, repo: string): Promise<void> => {
      await call("DELETE", repoPath(org, repo));
    },

    // Where the worker's git reaches the repository, and the environment that lets it in. The
    // header is scoped to Forgejo's address, so git never sends the token to any other host, the
    // template's included.
    remote: (
      org: string,
      repo: string
    ): { readonly url: string; readonly env: Readonly<Record<string, string>> } => ({
      url: `${base}/${org}/${repo}.git`,
      env: {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: `http.${base}/.extraHeader`,
        GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`${config.token}:x-oauth-basic`).toString("base64")}`,
      },
    }),

    // Where a build pod reaches it, with its deploy key.
    sshRemote: (org: string, repo: string) =>
      `${config.sshUrl.replace(/\/+$/, "")}/${org}/${repo}.git`,
  };
};

export type Forgejo = ReturnType<typeof createForgejo>;
