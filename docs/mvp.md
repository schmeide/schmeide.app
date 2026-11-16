# Dev-mode MVP

A minimal, local version of the Schmeide software factory: create a project, type features, review
a plain-language spec, approve it, and a Claude agent builds the app from the
[Schmeide template](https://github.com/schmeide/template), the server checks it independently, and
deploys it on this machine. There is no auth; everything belongs to the seeded `demo` tenant.

## Run it

```sh
make doctor   # Docker, GNU make 4+, claude (logged in), git, node, template, free ports, leftover apps
make serve    # Postgres + Temporal, migrations, the server on :3100, and Vite on :5173
```

`make` must be GNU make 4 or newer (`brew install make`, then use `gmake` or alias it). Apple's
`/usr/bin/make` 3.81 ignores `.SHELLFLAGS` and fails every target here and in the template.

- App (frontend): <http://localhost:5173> (Vite proxies `/api` to the server)
- API: <http://localhost:3100/api/trpc>, health at <http://localhost:3100/api/healthz>
- Temporal UI: <http://localhost:8233>

`make serve/server` runs only the server. `make infra/down` stops Postgres and Temporal; the
Postgres volume is kept.

`make serve` does not reload the server on code changes; restart it to pick them up.
`make serve/watch` is the same with reload, for working on the server itself.

A server restart in the middle of a build (Ctrl-C and `make serve` again, or a reload) does not
fail it: the step that was running starts again once the server is back, and the agent continues
from the work already in the project. Each step gets one such retry. If Temporal itself restarted,
the build cannot resume; the server marks it failed at startup, and "Request a change" retries it.

## Using the UI

Open <http://localhost:5173> after `make serve`. The page is the whole tool; there is nothing to install or log in to.

1. **Create a project**: type a name and press "Create project". The project page opens.
2. **Features**: one feature per line, in plain words (the [sample invoicing features](#sample-invoicing-features)
   work). "Save" keeps them; "Write the spec" saves and starts the spec.
3. **Spec**: the page updates by itself while it is written (under a minute). Read it, then "Approve and build", or
   "Change the features", which warns first that saving new features throws the spec away.
4. **Build**: the status, elapsed time, and a live log of each step (Progress, Builder, Checking, Publishing,
   Problem) with the server's own message. A failed build shows what went wrong.
5. **Your app**: "Open your app" at the top of the page opens the preview in a new tab. "Request a change"
   starts a change build (also the way to retry a failed build or bring an offline app back). Token usage and
   the reported cost are listed below it.
6. **Manage**: "Cancel the build" while building, "Take the app offline" while live, and "Delete project", which
   asks first and removes the running app, its data, the code, the spec, and the build history.

The URL hash is the view (`#/` for the list, `#/projects/<id>` for a project), so refresh and Back work. Only one
build runs at a time across all projects; approving while another runs says so. If the server is not running, the
page says to start it with `make serve`. The production build (GitHub Pages) has no API and shows the
"Coming soon" page instead.

| Status shown         | Server status     | Meaning                                                  |
| -------------------- | ----------------- | -------------------------------------------------------- |
| Describing           | `draft`           | Features being written; no spec yet                      |
| Writing the spec     | `spec_generating` | The spec is being written                                |
| Spec ready to review | `spec_ready`      | Approve it, or change the features (discards the spec)   |
| Building             | `building`        | A build or change build is running                       |
| Live                 | `live`            | The app is running at its preview link                   |
| Build failed         | `failed`          | The last build failed or was canceled; request a change  |
| Offline              | `stopped`         | The app was taken offline; a change build brings it back |

## End-to-end runs

The standing fixture is a tiny to-do app whose features live in `server/e2e/todo-features.txt`.
Each run creates a uniquely named project, drives it to `live`, checks `/` and `/api/healthz`,
prints the events, elapsed time, and token usage, and then deletes the project (deployment,
volumes, workspace, and rows) whether it passed or failed. It exits non-zero on failure.

- `make e2e/fake`: no Claude usage. Starts its own server on `:3199` (task queue `schmeide-fake`)
  with `SCHMEIDE_AGENT_CMD=server/e2e/fake-agent.sh`, which prints a fixed spec and makes one small
  real commit (it retitles the page). Clone, the independent checks, deploy, and preview all run for
  real. About 35 seconds. Run this one while developing; it needs only `make infra/up`, which it runs.
- `make e2e`: the same flow with Claude against the server from `make serve` (`:3100`). A few
  minutes and well under a dollar with `opus` so far. Run it sparingly.
- `KEEP=1` on either leaves the app running and prints its preview URL and the `projects.delete`
  command that removes it (that needs `make serve` running).

## Sample invoicing features

Paste into the features box for a hand-run demo:

```text
Keep a list of my clients with their name, email, and address
Create an invoice for a client with one or more line items
Each line item has a description, a quantity, and a price
Show the invoice total, with tax at a rate I choose
Give each invoice a number automatically, in order
Mark an invoice as draft, sent, or paid
See all invoices in a list, newest first, with their status and total
Filter the invoice list to show only unpaid invoices
Show how much money is still owed across all unpaid invoices
Print an invoice as a clean page I can save as a PDF
```

## The flow

1. `projects.create({ name })`: status `draft`; a slug and web port (8100, 8101, ...) are assigned.
2. `projects.setFeatures({ id, features })`: one feature per line; clears any earlier spec.
3. `projects.generateSpec({ id })`: status `spec_generating`, then `spec_ready` with a markdown spec
   (Features, Screens, Data it stores). Failure returns to `draft`.
4. `projects.approveSpec({ id })`: status `building`; starts `buildWorkflow`:
   1. `prepareWorkspace`: first build clones the template into the project workspace and starts a
      fresh git history with one commit; later builds reuse it.
   2. `runAgent`: Claude builds the spec in the workspace, test-first, until `make check`,
      `make test`, and `make build` pass, then commits.
   3. `runChecks`: the server runs the three targets itself. On failure the output goes back to the
      same agent session, up to 3 fix rounds, then the build fails with the last output.
   4. `deploy`: `make up`, then waits for `/` and `/api/healthz` on the web port to answer 200.
      Status `live` with `previewUrl`.
5. `projects.requestChange({ id, request })` on a `live`, `failed`, or `stopped` project runs the
   same workflow as a change build.
6. `projects.stop({ id })` cancels a running build (it ends `failed`, error `Build canceled`), or
   runs `make down` (status `stopped`, volumes kept).
7. `projects.delete({ id })` removes the deployment and its volumes, the workspace, and every row.
   Refused while a spec or build is running; returns once everything is gone.

`builds.events({ buildId, afterId })` is the live log: pass the last id seen to page forward.

## Environment

| Variable               | Default                                    | Meaning                              |
| ---------------------- | ------------------------------------------ | ------------------------------------ |
| `PORT`                 | `3100`                                     | API port (Vite proxies to it)        |
| `DATABASE_URL`         | Postgres on `:5440`, database `schmeide`   | Customer database                    |
| `TEMPORAL_ADDRESS`     | `localhost:7233`                           | Temporal frontend                    |
| `SCHMEIDE_DATA_DIR`    | `~/.schmeide`                              | Workspaces, logs, make shim          |
| `SCHMEIDE_TEMPLATE`    | `https://github.com/schmeide/template.git` | Git URL or local path to clone       |
| `SCHMEIDE_AGENT_MODEL` | `opus`                                     | Model for spec and build runs        |
| `SCHMEIDE_CLAUDE_BIN`  | `claude` on `PATH`                         | Claude Code executable the SDK runs  |
| `SCHMEIDE_AGENT_CMD`   | unset                                      | Fake agent command instead of Claude |
| `SCHMEIDE_TASK_QUEUE`  | `schmeide`                                 | Temporal task queue of this server   |

## Where things live

- `~/.schmeide/projects/<slug>/`: one git working directory per project.
- `~/.schmeide/logs/build-<id>.log`: full command output and every raw agent message for a build.
  Kept after a project is deleted. `e2e-fake-server.log` is the `make e2e/fake` server's output.
- `~/.schmeide/bin/make`: a link to GNU make, first on `PATH` for project runs and the agent.
- `~/.schmeide/gitconfig`: neutral git identity used instead of your global git config.
- Each deployed project is a Compose project named `schmeide-<slug>` on `http://localhost:<web port>`;
  its `make test` database uses port `5600 + n` for web port `8100 + n`.

To bring a stopped app back by hand: `cd ~/.schmeide/projects/<slug> && COMPOSE_PROJECT_NAME=schmeide-<slug>
WEB_PORT=<port> gmake up`.

## How the agent runs

The Claude Agent SDK runs the locally installed, logged-in `claude` binary (your subscription), with:

- `settingSources: ["project"]`: the project's `CLAUDE.md`/`AGENTS.md` load; your user settings,
  hooks, and plugins do not.
- `settings.claudeMdExcludes: ["~/.claude/**"]`: your personal `CLAUDE.md` loads regardless of
  setting sources, so it is excluded explicitly. `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` as well.
  `--bare` is not used: it drops the subscription login.
- `permissionMode: "dontAsk"` with an allowlist: `Read`, `Glob`, `Grep`, `TodoWrite`, `Edit`/`Write`
  inside the workspace, and Bash limited to `make`, `npm`, `npx`, `node`, `git`, and basic file
  commands. Anything else is denied without a prompt and logged as a `Denied ...` event.
- The project environment: `COMPOSE_PROJECT_NAME`, `WEB_PORT`, `TEST_DB_PORT`, GNU make first on
  `PATH`, and the server's own variables (`DATABASE_URL`, `MAKEFLAGS`, ...) removed.

## Dev-mode substitutions

Each is marked in code with a `ponytail:` comment.

| Dev mode                                          | Production target                             |
| ------------------------------------------------- | --------------------------------------------- |
| No auth, one seeded `demo` tenant                 | Accounts and tenant-scoped sessions           |
| Local git directory per project                   | Self-hosted Forgejo repository                |
| Agent runs on the host in the workspace           | Sandbox pod per job                           |
| Checks run on the host via the project Makefile   | Kubernetes Job                                |
| `make up` with Docker Compose, `localhost:<port>` | AKS namespace per tenant, object storage, CDN |
| One build at a time across all tenants            | Task queue per tenant                         |
| Temporal dev server, in memory                    | A real Temporal cluster                       |

## Known gaps

- No auth, no rate limits, no per-tenant quotas; usage is recorded but not enforced.
- Temporal history is lost when its container restarts; project and build rows survive in Postgres.
  A build whose workflow vanished is marked failed when the server next starts.
- A step restarted after a server restart begins again: an agent run starts a new session (with a
  note to continue from the workspace), so it pays again for reading the project.
- Deployments keep running until stopped. A new project takes the highest web port plus one, so
  ports below that are only reused once the projects above them are deleted.
