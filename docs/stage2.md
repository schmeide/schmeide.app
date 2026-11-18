# Stage 2: building and hosting customer apps on AKS

Design for [#165](https://github.com/schmeide/schmeide.app/issues/165). Stage 1 is live: <https://schmeide.app>
(GitHub Pages) talks to the API at `api.schmeide.app` on AKS, deployed by Argo CD from
`schmeide/iac/gitops/schmeide/schmeide-app/`, with `SCHMEIDE_BUILDS=off`. People can plan an app and get a spec;
approving it is refused. This document says how a build runs, and how its app is hosted, on that cluster. It serves
[#5](https://github.com/schmeide/schmeide.app/issues/5), whose list of production targets it turns into slices.

Everything here is a recommendation for the owner to accept or change. Rejected alternatives get one line each.
[Open decisions](#open-decisions) collects the calls only the owner can make.

## In short

1. Each project's code lives in a repository on the in-cluster Forgejo, one organization per business, with a
   `staging` branch the builder works on and a protected `main` that only moves forward on a promote. Nothing
   persistent sits on a disk next to the server any more.
2. Each agent run is a Kubernetes Job in one `schmeide-builds` namespace: the server's own image, restricted pod
   security, no service account token, a per-run deploy key for its one repository, and a model key that only
   build pods get.
3. The server's checks are a second Job that clones the agent's commit fresh and runs `make check`, `make test` and
   `make build` against a Postgres sidecar. `make test` in the template learns to use a database it is given.
4. Images are built by ACR Tasks from Dockerfiles the platform owns, so agent-written code never runs with Docker
   or privileges inside the cluster.
5. Each business gets a `tenant-<id>` namespace with a quota and default-deny network policy; each app has two
   copies, production and staging (#155), each one Deployment (nginx and Node in one pod), one Service, one Ingress,
   and one database on the shared Postgres.
6. Apps are served under `apps.schmeide.com` for now, never under `schmeide.app`, at an unguessable host name (staging
   at the same name plus `--staging`), with a wildcard certificate from DNS-01 on an Azure DNS zone. A dedicated
   domain on the Public Suffix List replaces it before customers build.
7. The API and the Temporal worker become two Deployments of the same image. Only the worker gets Kubernetes
   rights, scoped by RBAC and a ValidatingAdmissionPolicy.
8. Per-tenant task queues are dropped in favor of a per-business concurrency limit; the builds namespace quota caps
   the cluster-wide total.
9. Slice 1 lets an admin approve one spec end to end on plain restricted pods on the existing user pool. Customers
   build only after the egress allow-list, spend limits, and a dedicated tainted pool with Kata isolation are in.

## Goals and non-goals

### Goals

- An approved spec becomes a running app at an `https://` address on the apps domain, with the same flow,
  statuses, events, fix-up rounds, and staging copy with promote and discard as `docs/mvp.md` describes for dev
  mode.
- Agent-written code never runs where it can reach the platform's secrets, database, Kubernetes API, or another
  business's code or app.
- A build cannot starve sign-in, and a canceled or orphaned build leaves nothing running.
- Each step ships on its own and keeps dev mode (`make serve`, `make e2e/fake`) working unchanged.

### Non-goals for Stage 2

- Sign-in for built apps ([#84](https://github.com/schmeide/schmeide.app/issues/84)); custom domains (#87);
  redeploying old builds (#86); database import and export (#85), including copying production's data to staging.
- Frontends in Blob Storage behind a CDN (see [Static frontends](#static-frontends)).
- High availability for Forgejo or Temporal, and a second cluster.

**Done, for a customer**: they press "Approve and build", watch the log, and within the times in `docs/mvp.md`
plus about two minutes (image build, first certificate) the project says Live. "Open the version being worked on",
"Open your live app" and the Designer frame (staging) show it over https; a change request rebuilds staging and
leaves production alone; "Put this version live" and "Throw these changes away" promote and discard; "Take the app
offline" stops both copies and keeps their data; "Delete project" removes its code, images, databases, and
everything it ran.

## The shape

```mermaid
flowchart LR
  subgraph app[schmeide-app namespace]
    API[API Deployment]
    W[Worker Deployment]
  end
  subgraph builds[schmeide-builds namespace]
    AJ[agent Job]
    CJ[checks Job]
  end
  subgraph tenant[tenant-ID namespace]
    APP[app pods: production, staging]
  end
  T[(Temporal)] --> W
  W -- creates, follows logs --> AJ
  W -- creates, follows logs --> CJ
  AJ -- clone, push --> F[(Forgejo)]
  CJ -- clone --> F
  AJ -- model calls --> A[Anthropic API]
  W -- context upload, run --> ACR[ACR Tasks]
  ACR -- push images --> R[(ACR apps/*)]
  W -- apply manifests --> APP
  APP --> PG[(Postgres: one database per copy)]
  TR[Traefik *.apps.schmeide.com] --> APP
```

The worker is the only component that talks to the Kubernetes API, Forgejo's admin API, ACR, and Postgres as a
provisioner. It runs no agent-written code. Build pods and app pods hold one narrow credential each, or none.

## Code: Forgejo repositories

**Recommendation: every project is a repository on the in-cluster Forgejo, and the worker never keeps a
workspace.** Forgejo is already running (`gitops/schmeide/forgejo/values.yaml`, chart 17.3.2) with
`DISABLE_REGISTRATION` and "one organization per tenant" written into its values.

- Layout: organization `t<tenant id>`, repository `<project slug>`, branches `staging` and `main`. Slugs are already
  unique across all projects (`uniqueSlug` in `server/src/services/projects.ts`).
- `prepareWorkspace` becomes: if the repository is missing, create it with the Forgejo API, clone the template
  into a scratch directory under the worker's `/tmp`, make the one commit it makes today, and push. The local
  `.git` check becomes "does the repository exist".
- `applySite` and `removeReferenceCopies` stay in the worker and work on a scratch clone, then push. They only
  read and write files; they never run the project's code.
- The agent Job clones `staging`, commits, and pushes `staging`. The checks Job clones the exact commit the agent
  pushed. Deploy builds the commit that passed the checks and puts it on staging only, recording it as dev mode
  does: `builds.commit` and `projects.stagingCommit`. No build changes what is live, passed or failed, except an
  app's first.
- **Branches, not a local checkout, hold the two copies.** Dev mode keeps production in its own checkout
  (`$SCHMEIDE_DATA_DIR/production/<slug>`) and discards with `git checkout -B main <commit>` in the workspace; on
  Forgejo that would be a force-push to `main`. Instead `main` is production's history: a branch protection rule
  lets only the `schmeide-platform` user push it (deploy keys may not) and forbids force-pushes. A promote
  fast-forwards `main` to `projects.stagingCommit`, which always descends from `projects.productionCommit` because
  builds only add commits to `staging`; a discard force-pushes `staging` back to `projects.productionCommit`, the
  one branch a rewrite is allowed on. `projects.productionCommit` stays what production runs; `main` is its record
  in the repository, so "download your code" (#89) gives what customers see. Rejected: tags per release (they
  would still need a moving branch for the agent, and add nothing `builds.commit` does not record).
- Credentials: the worker uses a token for a `schmeide-platform` Forgejo user that may create organizations
  (created once by hand, kept in Key Vault, projected by External Secrets). Build pods get a fresh SSH **deploy
  key** per run, added to that one repository and deleted in `finishBuild`, so a pod can reach exactly one repo
  and push only `staging`.
- Forgejo stays without a public ingress in Stage 2. Pods reach it on its cluster Service. A public hostname comes
  with "download your code" (#89), not before.
- The template is cloned from `SCHMEIDE_TEMPLATE` (GitHub) as today. A Forgejo pull mirror of it is a later
  nicety.

Rejected: workspaces on a PVC (a ReadWriteOnce disk cannot be shared by the worker and build pods, and Azure Files
is slow for `node_modules`). GitHub repositories per project (customer code at a third party, egress from every
pod, and per-org limits; see [Open decisions](#open-decisions)).

## Agent runs: a Job per run

`runAgent` stops calling the SDK in the worker. It creates a Job, follows its log, and does with each message what
it does today (events, `recordUsage`, permission denials).

**Image and command.** The server's own image (`Dockerfile`, pushed as `schmeide-app`) with the command
`node src/sandbox/agent.ts`. That small entry point runs `query()` with the options `activities.ts` already builds
(`agentOptions`, `AGENT_TOOLS`, `AGENT_ALLOWED_TOOLS`, `permissionMode: "dontAsk"`) and prints every SDK message as
one JSON line. One image means one thing to patch and pin; the image carries no secrets. The Dockerfile gains
`openssh-client` for the deploy key. Rejected: a separate sandbox image (a second pipeline before it buys
anything); running the `claude` CLI directly (the options would be written twice).

**The Job**, named `agent-<build>-<round>`, labeled `schmeide.app/tenant`, `schmeide.app/project`,
`schmeide.app/build`:

```yaml
spec:
  backoffLimit: 0
  activeDeadlineSeconds: 5400 # runAgent's startToCloseTimeout, 90 minutes
  ttlSecondsAfterFinished: 3600
  template:
    spec:
      restartPolicy: Never
      automountServiceAccountToken: false
      enableServiceLinks: false
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        fsGroup: 1000
        seccompProfile: { type: RuntimeDefault }
      initContainers:
        - name: postgres # native sidecar: stops when the agent exits
          image: schmeide.azurecr.io/mirror/postgres:18-alpine
          restartPolicy: Always
          resources:
            requests: { cpu: 100m, memory: 256Mi }
            limits: { memory: 512Mi }
      containers:
        - name: agent
          image: schmeide.azurecr.io/schmeide-app:<server sha>
          command: [node, src/sandbox/agent.ts]
          # Built from an allow list, as claudeEnv does; nothing of the worker's.
          env:
            - name: ANTHROPIC_API_KEY
              valueFrom:
                secretKeyRef: { name: anthropic-builds, key: key }
            - name: TEST_DATABASE_URL
              value: postgres://postgres:postgres@localhost:5432/app
          resources:
            requests: { cpu: "1", memory: 2Gi, ephemeral-storage: 4Gi }
            limits: { cpu: "2", memory: 4Gi, ephemeral-storage: 10Gi }
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities: { drop: [ALL] }
```

The prompt and the deploy key go in a Secret `agent-<build>-<round>` the worker creates with the Job and deletes
with it. `HOME`, the clone, and `/tmp` are `emptyDir` volumes, and Postgres keeps its data on a memory-backed one. The
Postgres image is imported into ACR once (`az acr import`) so nodes never hit Docker Hub's anonymous pull limit;
check in slice 1 that its entrypoint starts as uid 1000 under the restricted level.

**Isolation.**

- Namespace `schmeide-builds`, Pod Security Admission `enforce: restricted`. No Role grants anything to its
  default service account, and every pod sets `automountServiceAccountToken: false`.
- NetworkPolicy, default deny both ways. Egress allowed to kube-dns, to the Forgejo SSH Service, and in slice 1 to
  `0.0.0.0/0` on 443 **except** `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16` and
  `168.63.129.16/32` (pods, nodes, the private Postgres subnet, instance metadata, the Azure wire server). Slice 3
  narrows 443 to an FQDN allow-list: `api.anthropic.com`, `registry.npmjs.org`, and the platform storage account
  (see [Security](#security)).
- `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, so the CLI calls nothing but the model.
- The Bash allow-list stays. The pod is now the boundary; the list keeps logs readable and mistakes small.

**Model credential.** One Anthropic API key used only by build pods, in its own Anthropic Console workspace with a
monthly spend limit, stored in Key Vault and projected as `anthropic-builds` into `schmeide-builds` only. The API's
interview and reader calls use a different key, and so do build summaries (`summary` runs on
`SCHMEIDE_SUMMARY_MODEL`, default `haiku`), which the worker writes beside the build from its events alone and
which Schmeide pays for, not the business. A prompt-injected agent can read its own key; the egress
allow-list means it can only spend it, and the workspace limit caps that. Per-tenant Foundry is an
[open decision](#open-decisions). Each run also gets the SDK's `maxBudgetUsd` from the build's remaining
allowance once #83 lands, which stops a runaway run cleanly.

**How the activity drives it.**

1. Create the Secret and Job, or **adopt** them if a Job of that name exists. A worker restart then reattaches to a
   running agent instead of paying for a new one, which is better than dev mode's restart.
2. Stream `pods/log` with `follow`, heartbeating as `withHeartbeat` does now. On reattach, skip lines already
   recorded (by the build's last event time).
3. On the pod's exit, fail with the last output if it was non-zero; otherwise return as today.
4. On Temporal cancellation, delete the Job with `propagationPolicy: Foreground` and wait, matching
   `WAIT_CANCELLATION_COMPLETED` in `server/src/temporal/workflows.ts`.

**Cleanup has three layers**: the activity deletes its Job on cancel; `finishBuild` deletes every Job, Secret and
deploy key labeled with the build, whatever happened; and `activeDeadlineSeconds` plus `ttlSecondsAfterFinished`
remove what a dead worker left. At startup the worker also deletes Jobs whose build is not running, next to
`failOrphanedBuilds`.

**Fix-up rounds.** A pod's session transcript dies with the pod, so in slice 1 a fix-up round starts a new session
with the checks' output, as a restarted run does today (`INTERRUPTED_NOTE`). It pays to reread the project, a few
cents. Slice 2 saves `~/.claude/projects/**/<session>.jsonl` to Blob Storage and restores it, so `resume` works
again. The entry point traps `SIGTERM` and pushes a work-in-progress commit, so a deleted pod loses at most the
current turn.

**Kubernetes access from the worker.** The API pod keeps `automountServiceAccountToken: false`. The worker
Deployment gets the `schmeide-worker` service account and, in `schmeide-builds`, a Role for `jobs` (create, get,
list, watch, delete), `pods` and `pods/log` (get, list, watch), and `secrets` (create, get, delete). It calls the
API server with `fetch`, its projected token and the cluster CA. The handful of calls (create, server-side apply,
watch, logs, delete) does not justify `@kubernetes/client-node`.

## Checks: a Job per round

`runChecks` creates `checks-<build>-<round>`: the same pod shape, the same Postgres sidecar, **no model key**, a
read-only deploy key, `activeDeadlineSeconds: 1800`. Its script clones the commit, runs `npm ci`, then
`make check`, `make test`, `make build`, printing a marker line before each so the worker can emit the same
"Running make test" / "make test failed" events and return the same `{ ok, output }`. The fix-up loop in
`buildAndCheck` does not change. A clean clone in a fresh pod is what makes the checks independent of anything
the agent left behind.

**Test database: a Postgres sidecar per Job**, on a memory-backed `emptyDir`, gone with the pod. It is what
`make test` does today with Compose and `tmpfs`, minus Docker. Rejected: a throwaway database on the shared server
(build pods would need a route and a credential to the server that holds every customer's data, and leftover
databases need sweeping).

**The template contract** ([schmeide/template](https://github.com/schmeide/template) `Makefile`, `compose.yaml`):

| Target       | Locally (unchanged)                 | In a build Job                                |
| ------------ | ----------------------------------- | --------------------------------------------- |
| `make check` | lint, tsc, prettier                 | the same                                      |
| `make test`  | Compose `test-db` on `TEST_DB_PORT` | uses `TEST_DATABASE_URL` from the environment |
| `make build` | typecheck, `frontend/dist`          | the same                                      |
| `make up`    | Compose stack on `WEB_PORT`         | never run; the platform deploys               |
| `make down`  | stops the stack                     | never run                                     |

The one Makefile change: when `TEST_DATABASE_URL` comes from the environment (`$(origin TEST_DATABASE_URL)` is
`environment`), `make test` skips `docker/check` and Compose and runs `test/run`. The agent and the checks then
behave the same in a pod and on a laptop. `WEB_PORT`, `TEST_DB_PORT` and `COMPOSE_PROJECT_NAME` stop being set in
Kubernetes mode.

## Deploy and hosting

**Images: ACR Tasks, from platform-owned Dockerfiles.** Before every deploy the worker resets the files the
platform owns (`frontend/Dockerfile`, `backend/Dockerfile`, `frontend/nginx.conf`, `.dockerignore`) to the
template's versions in a scratch clone of the commit, without committing them, uploads that tree as the build
context, and schedules one ACR run that builds and pushes two images:
`apps/t<tenant>/<slug>/web` and `.../api`, tagged with the commit. A promote builds nothing: production runs the
images staging was built with. The rest of the template reaches existing projects through a template upgrade change
([#206](https://github.com/schmeide/schmeide.app/issues/206)); until then the platform keeps compatibility shims,
such as `make test/run` in the checks, for projects made from older templates. The frontend's `vite build` and
`npm ci` run on Azure's build hosts, not in the cluster, inside `frontend/Dockerfile`'s build stage. The run has
**no `cmd` step**: a `cmd` container gets the run's registry sign-in (`/acb/home/.docker/config.json`) and the
host's Docker socket, and a test run showed it can push to and delete from any `apps/` repository. A `docker build`
step sees neither, nor the metadata endpoint, so the project's code (install scripts included) only runs there
([#214](https://github.com/schmeide/schmeide.app/issues/214)). The run allows 25 minutes. The deploy activity
allows 60, so the clone, both rollouts, and both health checks still fit after the build. Canceling the deploy
cancels the run; a retry follows the run id from the activity's heartbeat, or skips the build when both commit
tags are already in the registry
([#215](https://github.com/schmeide/schmeide.app/issues/215)). The worker's workload identity gets a custom role
with `scheduleRun`, `listBuildSourceUploadUrl`, `runs/read`, `runs/cancel` and `runs/listLogSasUrl` on the
registry. In ABAC repository
mode a quick run cannot carry an identity of its own; it pushes as its caller (`[caller]`), so the worker's identity
also holds Container Registry Repository Contributor limited to `apps/` (push, and delete on `removeProject`).

Rejected: rootless BuildKit in the cluster (needs unconfined seccomp and AppArmor, so a privileged-level namespace
on a dedicated pool; it is the fallback if ACR Tasks is unavailable). Kaniko (archived upstream). The node's Docker
socket or Docker-in-Docker (root on the node, as #165 says).

**Verify first**: some subscription types have ACR Tasks paused. One manual `az acr build` against `schmeide`
settles it before slice 1 starts.

**Per business**: namespace `tenant-<tenant id>`, created by the worker on the first deploy, with

- labels `schmeide.app/tenant=<id>` and `pod-security.kubernetes.io/enforce=restricted`;
- a ResourceQuota (to start: `requests.cpu: 1100m`, `requests.memory: 3Gi`, `limits.memory: 9Gi`, `pods: 20`, no
  LoadBalancer or NodePort Services), which fits about eight apps at two copies each plus a rolling update's surge
  pod (a pod asks for 60m and 160Mi and may use 512Mi), and a LimitRange with defaults;
- NetworkPolicy: deny all; allow ingress from the `traefik` namespace on port 8080; allow egress to kube-dns and to
  the Postgres subnet on 5432. **No internet egress for apps** in Stage 2 (#74 decides integrations).

Rejected: a namespace per project (more objects, quotas that cannot be shared across a business's apps). A cluster
per business (a control plane and nodes each).

**Per copy**, two per app (production and staging), all labeled `schmeide.app/project=<id>` and
`schmeide.app/copy=production|staging`, named `app-<id>` and `app-<id>-staging`:

- One Deployment, one replica, `automountServiceAccountToken: false`. Containers `web` (nginx, port 8080) and
  `api` (`node src/server.ts`, port 3000); nginx proxies `/api/` to `127.0.0.1:3000`. An init container runs
  `node src/migrate.ts` from the api image, which is the Compose `migrate` service. Readiness probes on `/` and
  `/api/healthz`. Requests `60m` CPU and `160Mi` in total, limits `500m` and `512Mi`.
- A Service and an Ingress (`ingressClassName: traefik`) for the copy's host.
- A Secret with the copy's own `DATABASE_URL`.

**The flow follows dev mode** (`deploy` and `release` in `server/src/temporal/activities.ts`):

- `deploy` applies the staging Deployment at the build's commit, waits for the rollout, then fetches
  staging's `/` and `/api/healthz` over https as it does today, with five minutes instead of three on a first
  deploy (certificate). It records `builds.commit`, `projects.stagingCommit` and `projects.stagingUrl`. Only an
  app's first build, with nothing live to protect, then promotes at once.
- A `promote` build applies the production Deployment at `projects.stagingCommit` (its init container migrates
  production's database forward), waits and fetches the same way, fast-forwards `main`, and records
  `projects.productionCommit` and `projects.previewUrl`.
- A `discard` build force-pushes `staging` to `projects.productionCommit` and records it as `stagingCommit`, scales
  staging to zero, drops and recreates staging's database, and applies staging at that commit, whose migrations
  build the empty database up.

`stopDeployment` scales both copies to zero. `removeProject` deletes the labeled objects, both databases and their
roles, the Forgejo repository, and the two ACR repositories.

Rejected: Argo CD applying tenant apps from a Forgejo repository (a deploy becomes a commit plus a sync to wait on;
revisit when drift or an audit trail matters).

**Databases: one per copy on the shared server**, `app_<project id>` for production and `app_<project id>_staging`
for staging, each with a role of the same name, so staging can never read or write production's data (as in dev
mode, where each copy has its own volume). The worker connects as a `schmeide_provisioner` role (`CREATEDB`,
`CREATEROLE`, nothing else), creates each role with a random password and a database it owns, grants the role to
itself so it can drop that database on a discard (`DROP DATABASE ... WITH (FORCE)`), and revokes `CONNECT` from
`PUBLIC`. The URL carries `sslmode=require`. The provisioner password is the worker's alone.
Turn on the flexible server's built-in PgBouncer and keep app pools small (5): `B_Standard_B2s` allows a few hundred
connections, Temporal and Forgejo already use some, and every app now holds two pools.

### Static frontends

**Recommendation: serve frontends from the app pod in Stage 2.** nginx costs about 32 MiB per app and keeps `/api`
same-origin with no extra routing. Blob Storage plus a CDN (`stschmeidefrontends`, `bundles`) needs the CDN choice
that `modules/frontends/README.md` leaves open, a route from the CDN back to Traefik for `/api`, and a base fee. It
pays off with real traffic; leave the account as is until then.

## Previews and domains

**Never a subdomain of `schmeide.app`.** Built apps have no sign-in yet (#84) and run code the platform did not
write; a subdomain would share the site with `schmeide.app`, receive any cookie scoped to it, and count as
same-site. Apps on another registrable domain never see the platform's cookies, and "Open your live app" cannot be
used to attack the API's session.

**Decided: `apps.schmeide.com` for now.** The owner already holds `schmeide.com`; its DNS stays at Porkbun, where
the apex points at GitHub Pages (the marketing site, schmeide/schmeide.com) and MX and SPF forward mail for
`admin@schmeide.com`. Only the `apps` subdomain is delegated to Azure; the rest of `schmeide.com` is untouched.

- **The tradeoff**: built apps share a registrable domain with the company's marketing site and email. They count
  as same-site with `schmeide.com`, can set and read cookies scoped to `.schmeide.com`, and one app can set cookies
  that another reads, because `apps.schmeide.com` is not on the Public Suffix List. A phishing app on it borrows
  the company's name, and a blocklisting or takedown of it can hit the marketing site and mail. Acceptable while
  only admins build; a dedicated domain, submitted to the Public Suffix List as `github.io` is, must replace it
  before customers build ([slice 6](#slice-6-customers-build)). That move is its own issue.
- **DNS in Azure DNS**: a zone `apps.schmeide.com` in Terraform, `*.apps.schmeide.com` A record to Traefik's
  `74.249.191.146`, and its name servers as an output. The owner adds `NS` records for `apps` at Porkbun by hand.
  Rejected: a Porkbun webhook for cert-manager (third-party code holding registrar credentials).
- **Certificates**: a DNS-01 `azureDNS` ClusterIssuer with workload identity on that zone, one wildcard Certificate
  `*.apps.schmeide.com` in the `traefik` namespace, and a Traefik default `TLSStore`, so apps need no certificate
  of their own. With the zone chosen and created in slice 1 anyway, this lands in slice 1 rather than slice 4:
  per-app HTTP-01 certificates would publish every host name in Certificate Transparency logs, which defeats the
  random host names below, and would spend Let's Encrypt's per-domain limit that `schmeide.com` shares with the
  marketing site.
- **Host names**: production at `<slug>-<6 random characters>.apps.schmeide.com`, chosen once per project, its first
  label stored in a new `projects.host` column; staging at `<same>--staging.apps.schmeide.com`. `--staging` is part
  of the same label, never a subdomain, because the wildcard certificate covers one label only. A label is at most 63
  characters, so the slug part is cut to 47. Until #84 the address is the only lock, so it must not be guessable,
  and staging's is no more guessable than production's. `X-Robots-Tag: noindex` on every response.
- **Framing (#91)**: the platform-owned `nginx.conf` sends a `Content-Security-Policy` of
  `frame-ancestors https://schmeide.app` (and `http://localhost:5173` in dev). `components/AppFrame.tsx` keeps
  `sandbox="allow-scripts allow-same-origin allow-forms"`; `allow-same-origin` is safe because the app's origin is
  another site. A Pages site cannot send headers, so "schmeide.app refuses to be framed" needs the site behind a
  host that can, or a script that refuses to run in a frame meanwhile. When #84 adds sign-in, the app's cookie is a
  third-party cookie inside the frame; mark it `Partitioned` and test, per #91.
- `projects.webPort`, `FIRST_WEB_PORT`, `FIRST_TEST_DB_PORT`, `STAGING_PORT_OFFSET` and `testDbPort` stay for host
  mode only. `previewUrl` becomes `https://<host>.apps.schmeide.com` and `stagingUrl`
  `https://<host>--staging.apps.schmeide.com`.

## The API, the worker, and queues

**Split** `server/src/main.ts` by `SCHMEIDE_ROLE`: `api` (Fastify and tRPC, no worker), `worker` (Temporal worker
and `failOrphanedBuilds`, plus a `/healthz` for probes), `all` (today's single process; the default, so `make serve`
does not change). Same image, two Deployments in `schmeide-app`:

| Deployment | Replicas                   | Service account                | Notes                               |
| ---------- | -------------------------- | ------------------------------ | ----------------------------------- |
| api        | 1, then 2 once files moved | metrics read only (slice 6)    | interview and reader calls; uploads |
| worker     | 1                          | `schmeide-worker`, workload ID | specs, builds, provisioning         |

The API's PVC goes away once `FileStore` (`server/src/services/fileStore.ts`) has a Blob implementation (slice 2);
build logs (`logs/build-<id>.log`) and session transcripts go to the same account. Until then the worker mounts the
API's ReadWriteOnce disk at `/data` and is required on the API pod's node: a delete runs in the worker and removes
uploads the API wrote, and both roles need a writable `/data` for claude (#201, schmeide/iac#39).

**Task queues: keep one queue; drop "a task queue per tenant" from #5.** Builds now spend their time in pods, so
the worker only waits; per-tenant queues would need a worker polling each one, which Temporal does not make
dynamic. Fairness comes from a per-business limit on running builds (default 1, checked in `startBuild` next to the
per-project queue, with the build waiting as `queued`), and the cluster-wide total from the `schmeide-builds`
ResourceQuota: a Job whose pod would exceed it simply waits, heartbeating. Revisit queues when one worker cannot
keep up, not before.

**Mode switch.** `SCHMEIDE_RUNNER=host` (default) keeps today's code; `kubernetes` uses the Jobs, Forgejo, ACR and
tenant namespaces above. Each activity calls one of the two. Dev mode and `make e2e/fake` stay on `host`. The
worker in `kubernetes` mode checks at startup that it can reach Forgejo, create a Job in `schmeide-builds`
(`SelfSubjectAccessReview`), and schedule an ACR run, and refuses to start with what to fix, as `make doctor` does.
`SCHMEIDE_BUILDS` gains `admins`: only accounts with the admin role (`docs/auth.md`) may approve, request changes,
or set the site.

**Admin resources page.** `createResourceReader` (`server/src/services/resources.ts`) gets a Kubernetes twin
behind the existing `ResourceReader` seam: `runtime` reads `metrics.k8s.io` pod metrics by
`schmeide.app/project` label (containers, memory, CPU in the same units), and `workspaceBytes` reads the Forgejo
repository's `size`. The API gets a service account with only `get`/`list` on `pods.metrics.k8s.io`.

## Security

### Who holds what

| Component  | Holds                                                                | Never holds                 |
| ---------- | -------------------------------------------------------------------- | --------------------------- |
| API        | platform DB login, OAuth secrets, its model key                      | Kubernetes token, build key |
| Worker     | RBAC, Forgejo token, ACR run role, DB provisioner, summary model key | runs no agent-written code  |
| Agent pod  | builds model key, one repo's deploy key                              | anything of the server's    |
| Checks pod | one repo's read-only deploy key                                      | a model key                 |
| App pod    | its own `DATABASE_URL`                                               | internet egress, a token    |

### Worker RBAC without cluster-wide power

Creating namespaces is cluster-scoped, and a ClusterRoleBinding over Deployments and Secrets would let the worker
read Argo CD's and Temporal's secrets. Instead:

- A ClusterRole lets the worker create, label and delete namespaces, create RoleBindings, and `bind` only the
  ClusterRole `schmeide-tenant-deployer` (Deployments, Services, Ingresses, Secrets, ResourceQuotas, LimitRanges,
  NetworkPolicies).
- In each new `tenant-*` namespace it binds that role to itself, so its rights stop at tenant namespaces.
- A ValidatingAdmissionPolicy (native since Kubernetes 1.30, no Kyverno) refuses the worker's requests unless the
  namespace is named `tenant-*`, carries the tenant label, and enforces the `restricted` pod security level, and
  refuses RoleBindings that bind anything else.

### Multi-tenant isolation

Separate namespaces, restricted pod security, default-deny NetworkPolicy, no tokens, one database role per app, one
deploy key per run. Slice 1 runs build pods on the shared user pool next to the platform: acceptable while only
admins build. **Before customers build**, build pods and app pods move to a
dedicated `untrusted` node pool, tainted, with AKS Pod Sandboxing (Kata VM isolation, Azure Linux nodes), because
both run code an agent wrote, and a container escape on the user pool reaches the platform. Rejected: gVisor
(not offered as an AKS runtime). Plain pods for customers (one kernel bug from the platform).

### Egress

Slice 3 replaces the 443-except-private rule with Cilium FQDN policies (AKS Advanced Container Networking Services,
which the cluster's Cilium dataplane supports): build pods reach `api.anthropic.com`,
`registry.npmjs.org`, the platform storage account, and nothing else on the internet. ACNS is billed per node;
the fallback is an in-cluster forward proxy (`HTTPS_PROXY` is already in `claudeEnv`'s allow-list) with
NetworkPolicy allowing only the proxy.

### Spend (#83)

Three stops, cheapest first: the Anthropic workspace limit (a hard ceiling for the whole platform);
`maxBudgetUsd` per agent run from the business's remaining allowance; the check in `startBuild` against
the estimate (#81). A suspended business already stops at the next step (`refuseIfSuspended`).

### Abuse

- Mining or busy-looping in a build: CPU limit, `activeDeadlineSeconds`, and the per-business build limit.
- Phishing or malware on the apps domain: no open sign-up yet; random host names; admin "take offline" and the
  report form (#68); a takedown never touches `schmeide.app`. While apps live under `schmeide.com` it can touch the
  marketing site and mail, which is why the dedicated domain, with its PSL listing, comes before customers build.
- Apps attacking the cluster or the internet: no egress, no token, restricted pod security, quota.
- Prompt injection through attachments or websites: the agent can only reach its repository, the model, and npm.

## Capacity and cost

Measured on 2026-11-17 (`kubectl describe nodes`): the user node (D4as_v6) has `3860m` CPU and about 11.5 GiB
allocatable, of which the platform requests `680m` and 1.2 GiB today, the API included. The worker adds about `250m` and
512 MiB.

| Workload                    | Requests          | Per user node, after the platform |
| --------------------------- | ----------------- | --------------------------------- |
| One build (agent or checks) | 1.1 CPU, 2.25 GiB | 2 on the first node, 3 on another |
| One idle app, both copies   | 120m CPU, 320 MiB | about 30 on a node                |

- The agent and checks of one build run one after the other, so a build holds one pod's worth at a time.
- Set the `schmeide-builds` quota to `requests.cpu: 3.5` (three builds). With two user nodes that leaves room for
  the platform and a few dozen apps.
- Quota ([schmeide/iac#5](https://github.com/schmeide/iac/issues/5)): 12 Dav6 vCPUs cover two user nodes plus an
  upgrade surge node. A dedicated pool needs more quota: ask for 24 Dav6 (or use another family) when the
  `untrusted` pool is added.
- **Add the dedicated pool** when customers may build (isolation, above), or earlier if builds wait more than five
  minutes for the quota, or the autoscaler sits at two nodes. Taint it `schmeide.app/untrusted=true:NoSchedule`;
  build Jobs and tenant Deployments tolerate and select it. Minimum one node, because live apps run there.
- Size the builds quota and the pool from measured time, not guesses: `agent_runs.duration_ms` per run kind
  (`initial`, `change`) is how long each agent pod holds its requests, and the build's own start and finish give
  the checks' share. The same rows, with `usage`, give #83 its model cost per build.
- Rough list prices (check the Azure calculator): a D4as_v6 node is about $140 a month; an ACR Task run is billed
  per second, about a cent for a two-minute image build; the Postgres server is shared. An idle small app costs a
  few dollars a month of node share, which is #83's "hosting cost per app".

## Rollout

Each slice ships on its own, keeps dev mode unchanged, and is tested with unit tests on the pure parts (manifest
builders, naming, the Makefile marker parser) plus a real run on the cluster. Slice 1 is large because "end to end"
needs code, agent, checks and deploy at once; it lands as the PRs listed, all behind `SCHMEIDE_BUILDS=off` until
the last flips it to `admins`.

```mermaid
flowchart LR
  S1[1 admin builds end to end] --> S2[2 blob storage, API x2]
  S1 --> S3[3 egress allow-list]
  S1 --> S4[4 framing]
  S3 --> S5[5 untrusted pool, Kata]
  S2 --> S6[6 customers build]
  S4 --> S6
  S5 --> S6
```

### Slice 1: one admin builds one app end to end

- **Before it**: add the `NS` records for `apps.schmeide.com` at Porkbun; confirm ACR Tasks with one manual run;
  create the Forgejo `schmeide-platform` user and token; create the builds Anthropic workspace and key. Put both in
  Key Vault.
- **schmeide.app**, in this order:
  1. Split API and worker (`SCHMEIDE_ROLE`) and add `SCHMEIDE_BUILDS=admins`. Issue: "run the api and the temporal
     worker as separate deployments".
  2. `server/src/kube/` (API calls, Job and app manifests), `server/src/sandbox/agent.ts`, `SCHMEIDE_RUNNER`;
     Forgejo workspaces in `prepareWorkspace`, `applySite`, and the agent Job; checks Job. Issue: "run the agent
     and the checks as kubernetes jobs on forgejo repositories".
  3. ACR run, tenant namespace, database provisioning for both copies, production and staging Deployments and
     Ingresses, promote and discard on the `main` and `staging` branches, the `projects.host` migration (the
     commits are already recorded: `builds.commit`, `projects.productionCommit`, `projects.stagingCommit`),
     `openssh-client` in `Dockerfile`, production section in `docs/mvp.md`. Issue: #194, "deploy built apps to a
     tenant namespace on the apps domain".
  4. Attachments are refused in Kubernetes mode with a clear message until slice 2 (there is no screen for them
     yet, #70).
- **schmeide/iac**: worker Deployment, service account, RBAC, ValidatingAdmissionPolicy; `schmeide-builds`
  namespace with pod security label, quota, NetworkPolicy, ExternalSecrets (`anthropic-builds`, Forgejo token,
  provisioner password); worker identity with federated credential and the ACR run role; ACR Task identity with
  Repository Writer on `apps/*`; the `apps.schmeide.com` zone, wildcard record, DNS-01 ClusterIssuer and wildcard
  Certificate; `az acr import` of `postgres:18-alpine`; the
  `schmeide_provisioner` role, created once by hand from inside the cluster (Terraform cannot reach the private
  server). Issue: "give the worker the
  rights and namespaces to build apps".
- **schmeide/template**: `make test` uses an external `TEST_DATABASE_URL`; `frontend/Dockerfile` becomes
  multi-stage on `nginx-unprivileged` (port 8080, runs as non-root); `nginx.conf` takes the backend address and
  frame ancestors from the environment; `AGENTS.md` lists the platform-owned files. Issue: "run make test without
  docker and serve the frontend as non-root".
- **Done when** an admin approves a spec in production and opens both copies over https, requests a change and
  sees it on staging only, then promotes it and discards another; cancel leaves no Job behind; delete leaves no
  namespace object, database, repository or image.

### Slice 2: files, logs and sessions in Blob Storage

Blob `FileStore`; build logs and session transcripts in a private platform storage account (not
`stschmeidefrontends`, whose name and role differ); attachments reach the agent pod through short-lived read-only
SAS URLs; fix-up rounds `resume` again; the API runs two replicas with `RollingUpdate` and no PVC. iac: the
account, containers, and Storage Blob Data Contributor for the API and worker identities. Issue: "store files,
build logs, and agent sessions in blob storage".

### Slice 3: build egress allow-list

Enable ACNS; CiliumNetworkPolicy with `toFQDNs` for build pods; `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`;
`maxBudgetUsd` per run. Mostly iac; the server only sets the variable and option. Issue: "limit build egress to
anthropic, npm, forgejo, and blob storage".

### Slice 4: framing

The wildcard certificate moved to slice 1 (see [Previews and domains](#previews-and-domains)), and the PSL
submission to the dedicated domain. What remains: `frame-ancestors` and `noindex` checked by the server's
post-deploy fetch. Issue: #91.

### Slice 5: the untrusted node pool

iac: quota request, an Azure Linux pool with `workloadRuntime: KataVmIsolation`, autoscaled 1 to 3, tainted. Server:
`runtimeClassName` set to the Kata class AKS installs, toleration and node selector on build Jobs and tenant
Deployments. Issue: "run builds and built apps on an isolated, tainted node pool".

### Slice 6: customers build

The dedicated apps domain is in place; `SCHMEIDE_BUILDS=on`; per-business build limit; #83's allowance and limits
enforced; the Kubernetes resource reader; ACR retention (keep the last five tags per app) as a scheduled `acr purge`
task; alerts on Job failures and quota waits. Issue: "open building to customers on aks".

Later, each when it is needed: per-tenant Foundry resources; frontends behind a CDN; Argo CD for tenant apps; a
Forgejo ingress for code downloads.

## Open decisions

Each with the recommendation.

1. **The apps domain name.** Decided: `apps.schmeide.com` for now, zone in Azure DNS; a dedicated domain on the
   Public Suffix List before slice 6 (see [Previews and domains](#previews-and-domains)).
2. **Forgejo or GitHub for app code.** Forgejo: already running, on the private network, no per-repository cost,
   customer code stays with Schmeide.
3. **One API key or a Foundry resource per tenant.** One key in its own Anthropic workspace with a spend limit for
   Stage 2. Foundry per tenant once tenants pay and #5's Commercial Terms point is confirmed.
4. **Sandbox runtime.** Plain restricted pods while only admins build; Kata on a tainted pool before customers do.
5. **Shared cluster or a cluster for apps.** Shared, a namespace per business; revisit for compliance or scale.
6. **Image builds.** ACR Tasks; rootless BuildKit on the tainted pool only if Tasks is unavailable here.
7. **Egress control.** ACNS FQDN policies; a forward proxy if their cost or limits bite.
8. **A task queue per tenant (#5).** Drop it for a per-business build limit plus the namespace quota.
9. **Internet egress for built apps.** None in Stage 2; #74 decides integrations.
10. **Frontends in Blob Storage behind a CDN.** Not in Stage 2; nginx in the app pod.
11. **App addresses before #84.** A random suffix and `noindex`, so nothing is guessable while apps have no sign-in.
12. **Who builds during the rollout.** `SCHMEIDE_BUILDS=admins` until slice 6.
13. **How the repository holds staging and production.** A `staging` branch the builder pushes and a discard
    rewrites, and a protected `main` that a promote fast-forwards; never a force-push to `main`.
