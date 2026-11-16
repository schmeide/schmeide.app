# Dev-mode MVP

A minimal, local version of the Schmeide software factory: create a project, list what the app should do, review
a plain-language spec, approve it, and a Claude agent builds the app from the
[Schmeide template](https://github.com/schmeide/template), the server checks it independently, and
deploys it on this machine. People sign in, and only approved email addresses can. Each person works in a business
of their own and sees only its projects. [Sign-in and the approved list](auth.md) has the settings, the provider
setup, and how to connect the hosted site.

## Quick start

1. `make doctor`: fix anything it marks `FAIL` (each line says how), until it prints "All good".
2. `make serve`, and leave it running (Ctrl-C stops it).
3. In a second terminal, `make access/approve EMAIL=you@example.com TENANT=demo`. Open the link it prints and set a
   password. `TENANT=demo` puts you in the business that holds the projects made before sign-in existed; leave it
   out and you get an empty business of your own.
   You are now signed in; next time, sign in at <http://localhost:5173> with that email and password.
4. Type a project name and press "Create project".
5. Press "Write it myself" and type one request per box ("Add another request" or Enter adds a box), or press
   "Start the questions" and answer them. Then press "Write the spec",
   read it, and press "Approve and build".
6. When the status says Live (about 3 minutes for a small app, 10 for a medium one), press "Open your app".

## What to expect

Measured on this machine with `opus`, driven through the UI (costs are what Claude Code reports; with a
subscription they count against its usage limits rather than being billed):

| Run                                         | Features | Build time | Agent turns | Cost  |
| ------------------------------------------- | -------- | ---------- | ----------- | ----- |
| To-do list (`server/e2e/todo-features.txt`) | 2        | 2 min 56 s | 40          | $0.74 |
| Change: a delete button per to-do           | 1        | 1 min 42 s | 29          | $0.40 |
| Contact book                                | 9        | 8 min 40 s | 75          | $2.06 |
| Change: sort contacts by name               | 1        | 2 min 7 s  | 9 + restart | $0.16 |

- The spec takes under 10 seconds and costs under 2 cents.
- The log under "What is happening" grows every few seconds while the agent works (about 70 lines for
  the to-do list, 110 for the contact book). It can sit on one line for a minute while tests run.
- Of the build time, the agent takes most; the server's own checks take about 15 seconds and
  publishing about 10.
- The sample invoicing requests are about the size of the contact book: expect roughly 10 minutes
  and $2 to $3.
- The change on the contact book was interrupted by stopping and restarting `make serve` mid-run; it
  resumed and passed.

## When a build fails

1. Read "What went wrong" on the project page (under "Changes" once the app has been live); the last
   lines of the log say which step failed.
2. Describe what to fix under "Try again" (or "Request a change" once the app has been live), or just
   write "try again". The agent continues in the same project with your note.
3. "Checks still failing after 3 fix attempts" means the agent could not make `make check`,
   `make test`, and `make build` pass; the output under "What went wrong" is the last failure.
   Request a change that describes the problem.
4. "did not answer 200 within 3 minutes" means the app built but would not start: run `make doctor`
   (a port may be taken), then request a change.
5. The full output of every command and every agent message is in `~/.schmeide/logs/build-<id>.log`.
6. If the page says the server is unreachable, `make serve` stopped: start it again. A build that was
   running continues.

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

Open <http://localhost:5173> after `make serve`. The page is the whole tool; there is nothing to install. Sign in with
an approved email (step 3 of the quick start).

1. **Create a project**: type a name and press "Create project". The project page opens.

A project page has two phases. **Setup** lasts until the first build passes. It shows one step at a time, with a
stepper (Describe, Spec, Build, Live) above it, and one main button per step:

1. **What your app should do**: two ways to describe it, which can be mixed.
   - "Start the questions" asks one question at a time beside "Your plan", which fills in as you answer. Choose an
     answer, pick "Something else" to use your own words, or press "You decide" and Schmeide picks one and marks it
     in the plan. Each question takes a few seconds to arrive. "Write the spec" is there from the first answer; you
     do not have to answer everything.
   - "Write it myself" shows the request boxes: one request per box, in plain words. "Add another request" or
     Enter in a box adds a box below it, "Remove" drops one, and empty boxes are ignored. Pasting a list of
     several lines into a box puts each line in its own box (the
     [sample invoicing requests](#sample-invoicing-requests) work). "Save" keeps them; "Write the spec" saves and
     starts the spec.
2. **Spec**: the page updates by itself while it is written (under a minute). Read it, then "Approve and build", or
   "Change the requests", which goes back to step 1 and warns that saving new requests throws the spec away.
3. **Build**: the status, elapsed time, and a live log of each step (Progress, Builder, Checking, Publishing,
   Problem) with the server's own message. "Cancel the build" is below it. A failed or canceled first build stays on
   this step: it shows what went wrong and a "Try again" box, where you describe what to fix or just write "try
   again".

"Delete project" is at the bottom of every setup step except while the spec is written or a build runs. It asks
first and removes the running app, its data, the code, the spec, and the build history.

**Your app** is the project's home once it has been live, and it stays so if a later change fails or the app is
taken offline. It has three views, each with its own address:

- **Overview** (`/projects/<id>`): "Open your app" opens the preview in a new tab, "Request a change" leads to
  Changes, and below are token usage with the reported cost and the spec the app was built from.
- **Changes** (`/projects/<id>/changes`): "Request a change" starts a change build (also the way to retry a failed
  change or bring an offline app back). Below it are the latest build with its log, with "Cancel the build" while
  it runs, and the "Waiting changes": while a build runs a new change waits there, where it can be edited or removed
  until it starts.
- **Settings** (`/projects/<id>/settings`): the page title (the project name unless changed) and a PNG or ICO icon
  of at most 256 KB. Saving a live app publishes it again with them in under a minute, without the builder; while a
  build runs, the update waits its turn. "Use the default icon" goes back to the template's. Under "Manage" are
  "Take the app offline" while live and "Delete project".

Every page sits in the app shell: the logo (back to the list), the business name, the navigation (Apps, Usage,
Billing, Help; behind a "Menu" button on a narrow screen), the account menu, and the legal links in the footer. The
pages other than the project list and a project say "This page is not built yet". There are no accounts, so everyone
is the "Demo owner" of the "Demo business"; "Sign out" in the account menu shows the signed-out state until "Sign in"
or a reload.

The address is the view (`/` for the list, `/projects/<id>` and its views for a project; the full table is
`utils/routes.ts`), so
refresh and Back work. Different projects build at the same time; one project runs one build at a time, because its
builds share its workspace. If the server is not running, the page says to start it with `make serve`. The production
build (GitHub Pages) has no API and shows the "Coming soon" page instead, with no shell.

| Status shown         | Server status     | Meaning                                                  |
| -------------------- | ----------------- | -------------------------------------------------------- |
| Describing           | `draft`           | Requests being written; no spec yet                      |
| Writing the spec     | `spec_generating` | The spec is being written                                |
| Spec ready to review | `spec_ready`      | Approve it, or change the requests (discards the spec)   |
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
  real. It builds two projects at once and queues a change on one of them while it builds
  (`E2E_CONCURRENT=1`), and fails unless both were seen building together. About 75 seconds. Run
  this one while developing; it needs only `make infra/up`, which it runs.
- `make e2e`: the same flow with Claude against the server from `make serve` (`:3100`). A few
  minutes and well under a dollar with `opus` so far. Run it sparingly.
- `KEEP=1` on either leaves the app running and prints its preview URL, and the email and password
  of the account the run made, to sign in with and delete the project.
- Both sign in as an approved account they create for the run and remove afterwards.

## Sample invoicing requests

For a hand-run demo, copy the whole list and paste it into the first request box; each line lands in its own box:

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
2. `projects.setFeatures({ id, features })`: one request per line (the UI joins its boxes with newlines); clears
   any earlier spec.
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
   same workflow as a change build. On a `building` project it is queued instead (build status
   `queued`). When a build passes, its last step starts the oldest queued change of the project. A
   failed or canceled build leaves the queue waiting; the next change requested on the failed project
   is the retry and starts at once, ahead of the queue, which follows once it passes.
   `builds.editQueued({ buildId, request })` and `builds.removeQueued({ buildId })` change a queued
   one and answer `CONFLICT` once it has started.
6. `projects.setSite({ id, title, icon })`: the page title (empty means the project name) and icon
   (base64; `null` removes it, omitted keeps it). The icon must be PNG or ICO by its bytes, at most
   256 KB. On a `live` or `building` project it starts or queues a `site` build, which skips the agent
   and checks. Every build, before `deploy`, runs `applySite`: it sets `<title>` (HTML-escaped) in
   `frontend/index.html`, writes `frontend/public/site-icon.png` or `.ico` with its `<link rel="icon">`
   (or removes them), and commits if anything changed, so an agent change cannot drop them.
7. `projects.stop({ id })` cancels a running build (it ends `failed`, error `Build canceled`), or
   runs `make down` (status `stopped`, volumes kept).
8. `projects.delete({ id })` removes the deployment and its volumes, the workspace, and every row.
   Refused while a spec or build is running; returns once everything is gone.

`builds.events({ buildId, afterId })` is the live log: pass the last id seen to page forward.

## The interview

A second way to describe a project, beside `projects.setFeatures`: the server asks one question at a
time and keeps a plan up to date from the answers. The screen is "Start the questions" on the project page; the
API is:

- `interview.start({ id })` asks the first question, or the next one after a turn that failed. It
  does nothing while a question is waiting or once the interview has finished.
- `interview.answer({ id, questionId, answer })` stores the answer, changes the plan, and asks the
  next question. An answer is `{ type: "choices", values }`, `{ type: "yes_no", value }`,
  `{ type: "text", value }` (the person's own words, accepted on any question), or
  `{ type: "you_decide" }`.
- `interview.get({ id })` returns the plan items, the answered questions, the waiting question, the
  status of each plan section (`not_started`, `sketched`, `ready`), and whether it has finished.
- `interview.addItem`, `interview.updateItem`, and `interview.removeItem` edit the plan directly.

The plan has four sections: `who` uses the app, what it `does`, its `screens`, and what it `keeps`.
Each item is for `day_one` or `later`, and is marked `you` or `schmeide` by who it came from.

- Each question is one model call, made while the request waits: about 4 seconds and about 1 cent
  with `sonnet`. The interview ends after 30 questions at most.
- When the model cannot produce a turn the call answers `SERVICE_UNAVAILABLE`, the question stays
  open, and the same call can be sent again.
- A project with plan items needs no typed requests: `projects.generateSpec` writes the spec from
  the plan, adds any typed requests to it, and leaves out the `later` items.
- Changing the plan of a `spec_ready` project returns it to `draft` and clears the spec, as
  `projects.setFeatures` does. The plan cannot change once the project is being built.

## Environment

| Variable                   | Default                                    | Meaning                              |
| -------------------------- | ------------------------------------------ | ------------------------------------ |
| `PORT`                     | `3100`                                     | API port (Vite proxies to it)        |
| `DATABASE_URL`             | Postgres on `:5440`, database `schmeide`   | Customer database                    |
| `TEMPORAL_ADDRESS`         | `localhost:7233`                           | Temporal frontend                    |
| `SCHMEIDE_DATA_DIR`        | `~/.schmeide`                              | Workspaces, logs, make shim          |
| `SCHMEIDE_TEMPLATE`        | `https://github.com/schmeide/template.git` | Git URL or local path to clone       |
| `SCHMEIDE_AGENT_MODEL`     | `opus`                                     | Model for spec and build runs        |
| `SCHMEIDE_INTERVIEW_MODEL` | `sonnet`                                   | Model for interview questions        |
| `SCHMEIDE_CLAUDE_BIN`      | `claude` on `PATH`                         | Claude Code executable the SDK runs  |
| `SCHMEIDE_AGENT_CMD`       | unset                                      | Fake agent command instead of Claude |
| `SCHMEIDE_TASK_QUEUE`      | `schmeide`                                 | Temporal task queue of this server   |

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
| Sign-in limited to approved emails, set by hand   | Open sign-up, invitations, emailed codes      |
| Local git directory per project                   | Self-hosted Forgejo repository                |
| Agent runs on the host in the workspace           | Sandbox pod per job                           |
| Checks run on the host via the project Makefile   | Kubernetes Job                                |
| `make up` with Docker Compose, `localhost:<port>` | AKS namespace per tenant, object storage, CDN |
| Builds of all projects share one worker           | Task queue per tenant                         |
| Temporal dev server, in memory                    | A real Temporal cluster                       |

## Known gaps

- No auth, no rate limits, no per-tenant quotas; usage is recorded but not enforced.
- Temporal history is lost when its container restarts; project and build rows survive in Postgres.
  A build whose workflow vanished is marked failed when the server next starts.
- A step restarted after a server restart begins again: an agent run starts a new session (with a
  note to continue from the workspace), so it pays again for reading the project.
- The Bash allowlist matches command prefixes, so shell loops (`for f in ...`) and some compound
  commands are denied (logged as `Denied Bash: ...`); the agent retries another way, at the cost of a
  turn. None of the measured runs failed because of it.
- Deployments keep running until stopped. A new project takes the highest web port plus one, so
  ports below that are only reused once the projects above them are deleted.
