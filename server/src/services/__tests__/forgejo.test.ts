import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createForgejo, deployKeyPair, orgOf } from "../forgejo.ts";

type Call = { readonly method: string; readonly path: string; readonly body: unknown };

// Answers by "METHOD path"; anything unlisted is a 404.
const fakeForgejo = (routes: Readonly<Record<string, readonly [number, unknown]>>) => {
  const calls: Call[] = [];
  const fetchFn: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    calls.push({
      method,
      path: url.pathname + url.search,
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    expect(new Headers(init.headers).get("authorization")).toBe("token secret-token");
    const [status, body] = routes[`${method} ${url.pathname}`] ?? [404, { message: "not found" }];
    return new Response(status === 204 ? null : JSON.stringify(body), { status });
  };
  const forgejo = createForgejo({
    url: "http://forgejo-http.forgejo.svc.cluster.local:3000",
    sshUrl: "ssh://git@forgejo-ssh.forgejo.svc.cluster.local",
    token: "secret-token",
    fetch: fetchFn,
  });
  return { forgejo, calls };
};

describe("forgejo", () => {
  it("names a business's organization after its id", () => {
    expect(orgOf(3)).toBe("t3");
  });

  it("creates the organization and a private repository when they are missing", async () => {
    const { forgejo, calls } = fakeForgejo({
      "POST /api/v1/orgs": [201, {}],
      "POST /api/v1/orgs/t3/repos": [201, {}],
    });

    await forgejo.ensureRepo("t3", "notes");

    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "GET /api/v1/orgs/t3",
      "POST /api/v1/orgs",
      "GET /api/v1/repos/t3/notes",
      "POST /api/v1/orgs/t3/repos",
    ]);
    expect(calls[1].body).toMatchObject({ username: "t3", visibility: "private" });
    expect(calls[3].body).toMatchObject({ name: "notes", private: true });
  });

  it("leaves an existing organization and repository alone", async () => {
    const { forgejo, calls } = fakeForgejo({
      "GET /api/v1/orgs/t3": [200, {}],
      "GET /api/v1/repos/t3/notes": [200, {}],
    });

    await forgejo.ensureRepo("t3", "notes");

    expect(calls.map((call) => call.method)).toEqual(["GET", "GET"]);
  });

  it("answers a branch's commit, or undefined when there is no such branch", async () => {
    const { forgejo } = fakeForgejo({
      "GET /api/v1/repos/t3/notes/branches/staging": [200, { commit: { id: "a".repeat(40) } }],
    });

    expect(await forgejo.branchCommit("t3", "notes", "staging")).toBe("a".repeat(40));
    expect(await forgejo.branchCommit("t3", "notes", "main")).toBeUndefined();
  });

  it("lets only the platform user push main, and no deploy key", async () => {
    const { forgejo, calls } = fakeForgejo({
      "GET /api/v1/user": [200, { login: "schmeide-platform" }],
      "POST /api/v1/repos/t3/notes/branch_protections": [201, {}],
    });

    await forgejo.protectMain("t3", "notes");

    expect(calls.at(-1)?.body).toMatchObject({
      rule_name: "main",
      enable_push: true,
      enable_push_whitelist: true,
      push_whitelist_usernames: ["schmeide-platform"],
      push_whitelist_deploy_keys: false,
    });
  });

  it("does not protect main twice", async () => {
    const { forgejo, calls } = fakeForgejo({
      "GET /api/v1/repos/t3/notes/branch_protections/main": [200, {}],
    });

    await forgejo.protectMain("t3", "notes");

    expect(calls).toHaveLength(1);
  });

  it("adds a deploy key and deletes the keys a predicate picks", async () => {
    const { forgejo, calls } = fakeForgejo({
      "POST /api/v1/repos/t3/notes/keys": [201, { id: 9 }],
      "GET /api/v1/repos/t3/notes/keys": [
        200,
        [
          { id: 9, title: "agent-12-0" },
          { id: 10, title: "agent-13-0" },
        ],
      ],
      "DELETE /api/v1/repos/t3/notes/keys/9": [204, null],
    });

    await forgejo.addDeployKey("t3", "notes", "agent-12-0", "ecdsa-sha2-nistp256 AAAA", false);
    await forgejo.deleteDeployKeys("t3", "notes", (title) => title.startsWith("agent-12-"));

    expect(calls[0].body).toEqual({
      title: "agent-12-0",
      key: "ecdsa-sha2-nistp256 AAAA",
      read_only: false,
    });
    expect(calls.map((call) => `${call.method} ${call.path}`).slice(1)).toEqual([
      "GET /api/v1/repos/t3/notes/keys?limit=50&page=1",
      "DELETE /api/v1/repos/t3/notes/keys/9",
    ]);
  });

  it("deletes a repository, and a missing one is already gone", async () => {
    const { forgejo, calls } = fakeForgejo({});

    await forgejo.deleteRepo("t3", "notes");

    expect(calls[0]).toMatchObject({ method: "DELETE", path: "/api/v1/repos/t3/notes" });
  });

  it("gives git the token for Forgejo's address only, never for another host", () => {
    const { forgejo } = fakeForgejo({});

    const remote = forgejo.remote("t3", "notes");

    expect(remote.url).toBe("http://forgejo-http.forgejo.svc.cluster.local:3000/t3/notes.git");
    expect(remote.env).toEqual({
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.http://forgejo-http.forgejo.svc.cluster.local:3000/.extraHeader",
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from("secret-token:x-oauth-basic").toString("base64")}`,
    });
    expect(forgejo.sshRemote("t3", "notes")).toBe(
      "ssh://git@forgejo-ssh.forgejo.svc.cluster.local/t3/notes.git"
    );
  });
});

describe("deployKeyPair", () => {
  it("makes a private key ssh reads and the public key that goes with it", () => {
    const { privateKey, publicKey } = deployKeyPair();
    const dir = mkdtempSync(join(tmpdir(), "schmeide-key-"));
    writeFileSync(join(dir, "id"), privateKey, { mode: 0o600 });

    const derived = execFileSync("ssh-keygen", ["-y", "-f", join(dir, "id")])
      .toString()
      .trim();

    expect(publicKey).toMatch(/^ecdsa-sha2-nistp256 [A-Za-z0-9+/=]+$/);
    expect(derived.split(" ").slice(0, 2).join(" ")).toBe(publicKey);
  });
});
