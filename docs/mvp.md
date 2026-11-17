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
3. Sign in at <http://localhost:5173/sign-in> with one of the two logins `make serve` prints (it runs `make db/seed`
   after the migrations), both with the password `schmeide-local-only`:
   - `owner@schmeide.localhost` owns the `demo` business, which holds the projects made before sign-in existed.
     Use it to work on projects.
   - `admin@schmeide.localhost` has the admin role and no business, and lands on `/admin`. To work on a customer's
     screens from there, open Admin, then Businesses, then "Demo business", and press "View as Local Owner" on
     `owner@schmeide.localhost`'s row, with any reason ([Viewing as a customer](auth.md#viewing-as-a-customer)). A
     banner shows while you do; its Stop button brings you back to `/admin`.

   The seed runs only when `SCHMEIDE_PUBLIC_URL` is localhost, and leaves existing logins, passwords, and sessions
   alone. To sign in as yourself instead, see [Approve a person](auth.md#approve-a-person).

4. Under "What do you need?", say what the app is for in a sentence or two (or pick a starting point) and press
   "Continue". With apps already there, "New app" leads to the same page.
5. Answer the questions, or press "Write it myself" and type one request per box ("Add another request" or Enter
   adds a box). Then press "Write the spec", read it, and press "Approve and build".
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
   `make test`, `make build`, and the phone check pass; the output under "What went wrong" is the
   last failure. Request a change that describes the problem.
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

- App (frontend): <http://localhost:5173> (Vite proxies `/api` to the server, without the `/api`)
- API: <http://localhost:3100/trpc>, health at <http://localhost:3100/healthz>
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
a seeded login or an approved email (step 3 of the quick start).

1. **Start an app**: the start page (`/new`, and the home page until there is a first app) asks "What do you
   need?". The answer is kept as the app's first answer (`projects.need`), the app is named from it (the name of a
   starting point, or the first few words), and the first interview question is asked before the project page
   opens. The page offers a second way in, "I already have something" (`/new/existing`): it asks what the person
   uses today, what must not change, and what gets in their way. Those answers become the first answer, and each
   thing they use starts the plan under "What it replaces".

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
first and removes both copies of the app, their data, the code, the spec, and the build history.

**Your app** is the project's home once it has been live, and it stays so if a later change fails or the app is
taken offline. It has three views, each with its own address:

- **Overview** (`/projects/<id>`): the frame shows the version being worked on (staging; production for an app live
  before staging existed, until its next build), says whether customers see the same version or how many changes they do
  not see yet, and offers "Put this version live" (promote) and "Throw these changes away" (discard, which asks first
  and says staging's information is emptied and the live app's is not touched). Neither is offered while a build runs;
  discard is not offered for an app whose live commit was never recorded, which says why. "Open the version being
  worked on" and "Open your live app" open each copy in a new tab. An offline app offers "Put this version live" to
  bring it back. A promote or discard shows as the latest change, with who asked. "Request a change" leads to Changes,
  and below are token usage with the reported cost and "The spec your app started from". That spec is never
  rewritten: the changes built since are listed beside it, oldest first (a thrown-away change is no longer one), and a
  change build is given the spec plus those changes, so the builder is not told something the code no longer does.
- **Changes** (`/projects/<id>/changes`): "Request a change" starts a change build (also the way to retry a failed
  change, or to build an offline app again before putting it live). Below it are the latest build with its log, with
  "Cancel the build" while it runs, and the "Waiting changes": while a build runs a new change waits there, where it
  can be edited or removed until it starts.
- **Settings** (`/projects/<id>/settings`): the page title (the project name unless changed) and a PNG or ICO icon of at
  most 256 KB. Saving a live app builds them into the version being worked on in under a minute, without the builder, to
  put live like any change; while a build runs, the update waits its turn. "Use the default icon" goes back to the
  template's. Under "Manage" are "Take the app offline" while live and "Delete project".

Every page sits in the app shell: the logo (back to the list), the business name, the navigation (Apps, Usage,
Billing, Help; behind a "Menu" button on a narrow screen), the account menu, and the legal links in the footer. The
pages other than the project list and a project say "This page is not built yet". People sign in with an approved email
address ([docs/auth.md](auth.md)); the shell shows their business, and "Sign out" in the account menu ends the
session.

The address is the view (`/` for the list, `/projects/<id>` and its views for a project; the full table is
`utils/routes.ts`), so
refresh and Back work. Different projects build at the same time; one project runs one build at a time, because its
builds share its workspace. If the server is not running, the page says to start it with `make serve`. The production
build (GitHub Pages) has no API and shows the "Coming soon" page instead, with no shell.

| Status shown         | Server status     | Meaning                                                 |
| -------------------- | ----------------- | ------------------------------------------------------- |
| Describing           | `draft`           | Requests being written; no spec yet                     |
| Writing the spec     | `spec_generating` | The spec is being written                               |
| Spec ready to review | `spec_ready`      | Approve it, or change the requests (discards the spec)  |
| Building             | `building`        | A build, a change build, a promote, or a discard runs   |
| Live                 | `live`            | The app is running at its links                         |
| Build failed         | `failed`          | The last build failed or was canceled; request a change |
| Offline              | `stopped`         | Taken offline; putting a version live brings it back    |

## End-to-end runs

The standing fixture is a tiny to-do app whose features live in `server/e2e/todo-features.txt`.
Each run creates a uniquely named project, drives it to `live`, checks `/` and `/api/healthz`,
prints the events, elapsed time, and token usage, and then deletes the project (deployment,
volumes, workspace, and rows) whether it passed or failed. It exits non-zero on failure.

- `make e2e/fake`: no Claude usage. Starts its own server on `:3199` (task queue `schmeide-fake`) with
  `SCHMEIDE_AGENT_CMD=server/e2e/fake-agent.sh`, which prints a fixed spec and makes one small real commit (it retitles
  the page and adds a stylesheet, which the phone check requires). Clone, the independent checks, deploy, and preview
  all run for real. The project without the queued change also saves a page title and icon, checks they reach staging
  and not production, promotes, and checks production has them. It builds two projects at once and queues a change on
  one of them while it builds (`E2E_CONCURRENT=1`), and fails unless both were seen building together. About 75 seconds.
  Run this one while developing; it needs only `make infra/up`, which it runs.
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
   3. `runChecks`: the server runs the three targets itself, then checks the built app for phones
      (below). On failure the output goes back to the same agent session, up to 3 fix rounds, then
      the build fails with the last output.
   4. `deploy`: commits anything the builder left uncommitted, so what ships is one commit, and
      records it (`builds.commit`). Then `make up` in the workspace for **staging** (Compose project
      `schmeide-<slug>_staging`, web port + 10000) and a wait for `/` and `/api/healthz` to answer
      200: status `live`, with `stagingUrl` and `stagingCommit`. Production is left alone, except for an
      app's first passed build: with nothing live to protect, it is promoted at once (below), so a new
      app is live as soon as it is built.

   Every app runs as two copies, named in one place (`copyOf` in `server/src/services/resources.ts`):

   | Copy       | Who uses it             | Compose project           | Runs from                       | Web port  |
   | ---------- | ----------------------- | ------------------------- | ------------------------------- | --------- |
   | production | the app's own customers | `schmeide-<slug>`         | `~/.schmeide/production/<slug>` | n         |
   | staging    | the person changing it  | `schmeide-<slug>_staging` | `~/.schmeide/projects/<slug>`   | n + 10000 |

   Each has its own database volume (`<Compose project>_db-data`). A slug never holds `_`, so no staging
   name is ever a production one. The builder's environment and its checks carry staging's Compose
   name and port only. The `git`, `make up`, `make down`, and `docker compose` that run either copy get
   that environment without the model's credentials (`ANTHROPIC_*`, `CLAUDE_*`).

   **Promote** moves production's own checkout to a commit (`git fetch` from the workspace,
   `git checkout --detach`, `git clean -ffdx`), runs `make up` there under production's name and port,
   which runs the app's migrations forward against production's database, and waits for it to answer.
   It records `productionCommit` and `previewUrl`, and marks every passed build staging held
   `release = promoted`. Staging's database is never copied to production.

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
7. `projects.promote({ id })` starts a `promote` build: production runs `stagingCommit`, without the
   builder, recorded with who asked (`builds.byUserId`). `projects.discard({ id })` starts a `discard`
   build: the workspace is reset to `productionCommit` (`git checkout --force -B main`,
   `git clean -ffdx`), staging's containers and database volume are removed
   (`docker compose -p schmeide-<slug>_staging down --volumes`), and `make up` starts staging again
   with an empty database its migrations build up; its passed builds are marked
   `release = discarded` and no longer count as built. Both answer `CONFLICT` while a build runs, when
   there is nothing to do, and (discard) when production's commit was never recorded; a suspended
   business can do neither. Each counts toward building time like any build. No model runs for
   either: its summary is one fixed sentence, written when it ends (`RELEASE_SUMMARIES`).
8. `projects.stop({ id })` cancels a running build (it ends `failed`, error `Build canceled`), or
   runs `make down` for both copies (status `stopped`, volumes kept).
9. `projects.delete({ id })` removes both copies and their volumes, the workspace, the app's checkout, and every
   row.
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

## Reading a website

`website.read({ id, address, whose })` reads a website a person names and returns proposals for the
plan. It writes nothing into the plan; the screen (#70) shows the proposals and adds what the person
keeps ticked.

- `whose` is `mine` or `someone_else`. Left out, the call answers `{ status: "ask_whose" }` without
  fetching anything, unless the address is on the domain of the caller's sign-in email (public
  mailbox domains such as `gmail.com` never count), in which case it is read as theirs.
- A read answers `{ status: "read", address, ownedBy, proposals }`. `ownedBy` is `domain`, `claim`
  (the person said so), or `null` for someone else's site. For `mine` the proposals are the business
  name, a logo address, colors, what the business offers, and features by plan section. For
  `someone_else` they are features only: nothing else is asked of the model, and no page text is
  stored.
- A read that does not work answers `{ status: "failed", reason }`, as data: `unreachable`,
  `needs_sign_in`, `blocks_readers`, `nothing_found`, or `refused_address`.
- Only `http` and `https` on ports 80 and 443, with no name and password in the address. Private,
  loopback, link-local, carrier NAT, multicast, reserved, and cloud metadata addresses are refused
  (`services/webAddress.ts`). The check runs on the address each connection is made to, and again on
  every redirect.
- One read takes at most 20 seconds, 1 MB per page, 5 redirects per page, and 4 pages: the page given
  and up to three it links to on the same site. Only `text/html` is read, as plain HTML; no scripts
  run.
- `robots.txt` is fetched under the same rules and followed for `SchmeideBot` and `*`. The reader's
  `User-Agent` is `SchmeideBot/1.0 (+https://schmeide.app)`.
- An account may start 20 reads an hour and a business 60 (`website_reads`); over that the call
  answers `CONFLICT`. A read that failed counts.
- The pages are cut down to text and given to one model call with no tools and a fixed answer shape,
  checked before anything is returned. When the answer cannot be used the call answers
  `SERVICE_UNAVAILABLE`.
- The fetch runs in the server process. `createSiteFetcher` in `services/siteFetcher.ts` is the one
  function to move when it gets a network of its own.

## Files

Pictures, PDFs, and spreadsheets a person sends to show what they mean. There is no screen for them yet (#70); the API
is:

- `POST /projects/<id>/files?owner=mine|someone_else&purpose=reference|in_app&name=<file name>` with the file as
  the request body and its type in `Content-Type` (`application/octet-stream` when unknown). It is not a tRPC call. It
  needs the session cookie, and takes the business header as tRPC does. It answers `201 { file }`, or
  `{ error: { code, message } }` with a message written for the person: `401 unauthorized`, `404 not_found` (also for
  a project in another business), `400 bad_request` or `empty`, `413 too_large`, `415 unsupported_type` or
  `type_mismatch`, `422 damaged` or `not_yours`, `409 too_many_files` or `business_full`.
- `files.list({ id })`, `files.rename({ id, fileId, displayName })`, and `files.delete({ id, fileId })`.
- `files.read({ id, fileId })` returns `{ status: "read", proposals, table }` or
  `{ status: "failed", reason, message }`. Proposals are plan items by section. Nothing is added to the plan.
- `projects.requestChange({ id, request, fileIds })` attaches files of the project to the change.

What the server does with a file:

- Accepts PNG, JPEG, WebP, PDF, CSV, and XLSX, decided by the content. A declared type that does not match is refused.
  HEIC is not accepted. Pictures may be 5 MB, other files 10 MB; a project holds 50 files and a business 500 MB.
- Removes camera, location, author, and comment details from a picture before storing it, and keeps only which way up
  it is. A picture it cannot take apart is refused. PDFs and spreadsheets are stored as sent.
- Stores the bytes under `files/<business id>/<project id>/<file id>` in the data dir. The file name is kept as text
  only. Files stay until they or their project are deleted.
- Reads a spreadsheet without the model: the first sheet's column names become proposals for what the app keeps, with
  up to five sample rows returned beside them. Nothing from a spreadsheet goes to the model.
- Reads a picture or PDF with one model call that has no tools and a fixed answer shape (`SCHMEIDE_INTERVIEW_MODEL`;
  usage rows have the run kind `read`). What the picture says is treated as content, never as instructions.
- Gives a change's attached files to the builder in `attachments/build-<id>/` in the data dir, outside the app and
  read only, until the build ends. Only a file that is `mine` and `in_app` may be copied into the app; after each
  builder run, an exact copy of any other attached file found in the app is removed and the removal committed.
  Something that is `someone_else` cannot be uploaded as `in_app`.

## Environment

| Variable                   | Default                                    | Meaning                              |
| -------------------------- | ------------------------------------------ | ------------------------------------ |
| `PORT`                     | `3100`                                     | API port (Vite proxies to it)        |
| `DATABASE_URL`             | Postgres on `:5440`, database `schmeide`   | Customer database                    |
| `TEMPORAL_ADDRESS`         | `localhost:7233`                           | Temporal frontend                    |
| `SCHMEIDE_DATA_DIR`        | `~/.schmeide`                              | Workspaces, files, logs, make shim   |
| `SCHMEIDE_TEMPLATE`        | `https://github.com/schmeide/template.git` | Git URL or local path to clone       |
| `SCHMEIDE_AGENT_MODEL`     | `opus`                                     | Fallback model for every agent run   |
| `SCHMEIDE_INTERVIEW_MODEL` | `sonnet`                                   | Model for questions and for reading  |
| `SCHMEIDE_WEBSITE_MODEL`   | `sonnet`                                   | Model for reading a website          |
| `SCHMEIDE_SUMMARY_MODEL`   | `haiku`                                    | Model for a build's running summary  |
| `SCHMEIDE_CLAUDE_BIN`      | `claude` on `PATH`                         | Claude Code executable the SDK runs  |
| `ANTHROPIC_API_KEY`        | unset (uses the CLI login)                 | Model credential in a container      |
| `SCHMEIDE_AGENT_CMD`       | unset                                      | Fake agent command instead of Claude |
| `SCHMEIDE_TASK_QUEUE`      | `schmeide`                                 | Temporal task queue of this server   |
| `SCHMEIDE_BUILDS`          | `on`                                       | `off`: none; `admins`: admins only   |
| `SCHMEIDE_ROLE`            | `all`                                      | `api` or `worker`: one half only     |

### Building on the cluster

`SCHMEIDE_RUNNER=kubernetes` (default `host`) makes the worker keep each project in a Forgejo repository and run the
agent and the checks as Jobs in `schmeide-builds` (`docs/stage2.md`, slice 1 step 2). Only the worker reads these; it
checks at startup that it can use Forgejo, the Kubernetes API, Azure and the provisioner database, and refuses to
start with what to fix. It deploys as [Production](#production) says. Files attached to a change are refused until
slice 2.

- `SCHMEIDE_BUILD_IMAGE` (required): the server's own image, which build pods run.
- `SCHMEIDE_FORGEJO_TOKEN` (required): an API token of the `schmeide-platform` Forgejo user.
- `SCHMEIDE_FORGEJO_URL`: Forgejo's API and the worker's git. Default
  `http://forgejo-http.forgejo.svc.cluster.local:3000`.
- `SCHMEIDE_FORGEJO_SSH`: Forgejo as build pods reach it. Default `ssh://git@forgejo-ssh.forgejo.svc.cluster.local`.
- `SCHMEIDE_FORGEJO_KNOWN_HOSTS`: Forgejo's SSH host key as a `known_hosts` line. Unset, pods trust the first key.
- `SCHMEIDE_BUILD_POSTGRES_IMAGE`: each pod's test database. Default `schmeide.azurecr.io/mirror/postgres:18-alpine`.
- `NODE_EXTRA_CA_CERTS=/var/run/secrets/kubernetes.io/serviceaccount/ca.crt`, so the worker trusts the API server.

### Model per run kind

Each agent run gets its model from what the run is. `pickModel` in `server/src/agentModel.ts` is the one place that
decides, and the run kind is its only input.

| Run kind  | What it is                                           | Variable                       |
| --------- | ---------------------------------------------------- | ------------------------------ |
| `spec`    | Writing the plain-language spec                      | `SCHMEIDE_AGENT_MODEL_SPEC`    |
| `initial` | The first build from the spec, and its fix-up runs   | `SCHMEIDE_AGENT_MODEL_INITIAL` |
| `change`  | A change request on a built app, and its fix-up runs | `SCHMEIDE_AGENT_MODEL_CHANGE`  |

- A kind whose variable is unset or empty uses `SCHMEIDE_AGENT_MODEL`. With none of the three set, every run uses that
  one model, as before.
- The server prints the resolved table at startup. Each build run adds an event with the model and the reason, for
  example `Model sonnet for this change run (SCHMEIDE_AGENT_MODEL_CHANGE routes change runs)`, just before
  `Agent started (...)`, which shows the model the SDK resolved it to.
- Every `usage` row carries `run_kind`, so cost per kind is one query:
  `select run_kind, model, sum(cost_usd) from usage group by 1, 2`. An interview question is a fourth kind there,
  `interview`; its model is `SCHMEIDE_INTERVIEW_MODEL`, not this table. Reading a website is a fifth, `website`, on
  `SCHMEIDE_WEBSITE_MODEL`. Reading an uploaded file is a sixth, `read`, on `SCHMEIDE_INTERVIEW_MODEL`. A build's
  running summary is a seventh, `summary`, on `SCHMEIDE_SUMMARY_MODEL`; it is Schmeide's cost, left out of what a
  project or business is shown or counted against, and shown in the admin area's usage by kind of run.
- Every run that reaches the model also gets one `agent_runs` row with how long it ran (`duration_ms` from the SDK's
  result), and its `usage` rows name it in `run_id`. The time is kept once per run, not per model, so summing it never
  counts a run twice. Rows from before runs were recorded have no `run_id`, and their time is not known.
- The request size, the tenant's plan, and the remaining allowance do not change the model.
- Nothing escalates. A fix-up run after failed checks resumes the same session on the same model, and a build that
  still fails after its fix-up rounds fails as before.
- Names are passed to the Claude Agent SDK unchanged, and the table is the same for every tenant. Whatever serves the
  models (one Foundry resource per tenant in production) must serve every name in the table.

## Where things live

- `~/.schmeide/projects/<slug>/`: one git working directory per project, where the builder works and staging
  runs from.
- `~/.schmeide/production/<slug>/`: production's own checkout of that repository, at the commit it runs. An
  app deployed before this existed runs from images built in the workspace until its first promote.
- `~/.schmeide/files/<business id>/<project id>/<file id>`: uploaded files, removed with the file or the project.
- `~/.schmeide/logs/build-<id>.log`: full command output and every raw agent message for a build.
  Kept after a project is deleted. `e2e-fake-server.log` is the `make e2e/fake` server's output.
- `~/.schmeide/bin/make`: a link to GNU make, first on `PATH` for project runs and the agent.
- `~/.schmeide/gitconfig`: neutral git identity used instead of your global git config.
- Each deployed project is two Compose projects: `schmeide-<slug>` on `http://localhost:<web port>` and
  `schmeide-<slug>_staging` on `http://localhost:<web port + 10000>`; its `make test` database uses port
  `5600 + n` for web port `8100 + n`. Web ports stay below 18100 (a database check), so the ranges never meet.

To bring a stopped app back by hand, production:
`cd ~/.schmeide/production/<slug> && gmake up COMPOSE_PROJECT_NAME=schmeide-<slug> WEB_PORT=<port>` (from
`~/.schmeide/projects/<slug>` for an app not promoted since its checkout existed); staging:
`cd ~/.schmeide/projects/<slug> && gmake up COMPOSE_PROJECT_NAME=schmeide-<slug>_staging WEB_PORT=<port + 10000>`.
Both take their names on make's command line, so the app's own `.env` cannot change them.

## How the agent runs

The Claude Agent SDK runs the `claude` binary. Locally that is the logged-in CLI (your subscription); in a container it
authenticates with `ANTHROPIC_API_KEY` (or `CLAUDE_CODE_USE_FOUNDRY=1` and the `ANTHROPIC_FOUNDRY_*` settings) from the
environment. The server refuses to start when `claude auth status` reports neither. Every run gets:

- `settingSources: ["project"]`: the project's `CLAUDE.md`/`AGENTS.md` load; your user settings,
  hooks, and plugins do not.
- `settings.claudeMdExcludes: ["~/.claude/**"]`: your personal `CLAUDE.md` loads regardless of
  setting sources, so it is excluded explicitly. `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` as well.
  `--bare` is not used: it drops the subscription login.
- `permissionMode: "dontAsk"` with an allowlist: `Read`, `Glob`, `Grep`, `TodoWrite`, `Edit`/`Write`
  inside the workspace, `Skill` for the builder plugin's skills (below), and
  Bash limited to `make`, `npm`, `npx`, `node`, `git`, and basic file commands. Anything else is
  denied without a prompt and logged as a `Denied ...` event.
- An allow-listed environment (`server/src/services/claudeEnv.ts`): `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`,
  `TMPDIR`, `TERM`, `TZ`, locale (`LANG`, `LC_*`), proxies and `NODE_EXTRA_CA_CERTS`, `ANTHROPIC_*`, `CLAUDE_CODE_*`,
  `CLAUDE_CONFIG_DIR`, and `DOCKER_HOST`/`DOCKER_CONTEXT`/`DOCKER_CONFIG`. Nothing else of the server's, so
  `DATABASE_URL`, `SCHMEIDE_*` and the OAuth secrets never reach it. The interview, the file and website readers, and
  a build's running summary get the same list. macOS keeps the CLI login in the keychain, found by `USER`.
- The project environment on top: `COMPOSE_PROJECT_NAME`, `WEB_PORT`, `TEST_DB_PORT`, GNU make first on `PATH`.

## Production

With `SCHMEIDE_RUNNER=kubernetes` the worker deploys what dev mode starts with `make up` to AKS instead
(`docs/stage2.md`, "Deploy and hosting"); the flow, statuses and copies are the same.

- **Images**: a deploy clones staging's head, resets `frontend/Dockerfile`, `backend/Dockerfile`,
  `frontend/nginx.conf` and `.dockerignore` to the template's (in that clone only, never committed), uploads it to
  ACR, and runs one ACR quick run that builds the frontend and pushes `apps/t<tenant>/<slug>/web` and `.../api`
  tagged with the commit. A failed run's event carries the end of its log and a link to all of it.
- **Namespace**: `tenant-<tenant id>`, applied on every deploy (server-side apply, so it is idempotent) with the
  worker's RoleBinding to `schmeide-tenant-deployer`, a ResourceQuota, a LimitRange, and a NetworkPolicy that lets
  in only Traefik on 8080 and out only DNS and Postgres on 5432.
- **Each copy** (`app-<id>` for production, `app-<id>-staging`): a Deployment (nginx `web` on 8080 and Node `api` on
  3000, a `migrate` init container, restricted pod security with a read-only root and an `emptyDir` `/tmp`), a
  Service, an Ingress for its host, and a Secret with `DATABASE_URL` for its own database and role (`app_<id>`,
  `app_<id>_staging`), made through `SCHMEIDE_PROVISIONER_URL`.
- **Addresses**: `https://<slug>-<6 random>.apps.schmeide.com` for production and `...--staging` for staging; the
  first label is `projects.host`, chosen on the first deploy. The wildcard certificate serves both.
- **Deploy** waits for the rollout and for `/` and `/api/healthz` to answer 200 over https (five minutes). A promote
  runs staging's images on production and then fast-forwards `main`; a discard force-pushes `staging` back,
  scales staging to zero, drops and recreates its database, and starts it again.
- **Stop** scales both copies to zero. **Delete** removes both copies' objects, databases and roles, the Forgejo
  repository, and both ACR repositories; the namespace stays for the business's other apps.

What the worker needs, besides the Forgejo settings above:

| Variable                         | Meaning                                                                   |
| -------------------------------- | ------------------------------------------------------------------------- |
| `AZURE_CLIENT_ID`                | The worker's workload identity (injected by Azure Workload Identity)      |
| `AZURE_TENANT_ID`                | Injected with it                                                          |
| `AZURE_FEDERATED_TOKEN_FILE`     | Injected with it                                                          |
| `AZURE_AUTHORITY_HOST`           | Injected with it                                                          |
| `SCHMEIDE_AZURE_SUBSCRIPTION_ID` | The registry's subscription                                               |
| `SCHMEIDE_ACR_RESOURCE_GROUP`    | The registry's resource group                                             |
| `SCHMEIDE_ACR_NAME`              | The registry, such as `schmeide`                                          |
| `SCHMEIDE_ACR_LOGIN_SERVER`      | Its login server, such as `schmeide.azurecr.io`                           |
| `SCHMEIDE_APPS_DOMAIN`           | `apps.schmeide.com`                                                       |
| `SCHMEIDE_PROVISIONER_URL`       | `postgres://` URL of a role with `CREATEDB` and `CREATEROLE` only         |
| `SCHMEIDE_APP_DATABASE_HOST`     | The shared Postgres server's host name, as app pods reach it (TLS needed) |

The worker's identity needs, on the registry, `listBuildSourceUploadUrl/action`, `scheduleRun/action`,
`runs/read` and `runs/listLogSasUrl/action`, plus Container Registry Repository Contributor limited to `apps/`: a
quick run in ABAC mode pushes as its caller, and a delete removes the repositories. The cluster's kubelet identity
needs Container Registry Repository Reader on `apps/` to pull.

## How built apps are made to work on a phone

Three things, all in this repo, so they reach every build whatever the workspace was copied from:

- **The builder plugin** (`server/builder-plugin/`, plugin name `schmeide`) is passed to every build
  run through the SDK's `plugins` option. It is never copied into the customer's code. It holds:
  - `schmeide:mobile-first`, written here for the template's stack: a starter stylesheet
    (`base.css`: tokens, light and dark, forms, buttons, lists, tables, a menu bar), exact sizes
    (360px design width, 16px text in form controls, 44px tap targets), a pattern per kind of
    screen, and a checklist.
  - The design skills from [jakubkrehel/skills](https://github.com/jakubkrehel/skills), as
    `schmeide:better-layout`, `schmeide:better-typography` and so on. Update them with
    `make skills/update REF=<commit> DEST=<this repo>/server/builder-plugin/skills` in
    home-schmeide; the commit is in `server/builder-plugin/skills/UPSTREAM_COMMIT`. Prettier and
    markdownlint skip them so they stay identical to upstream.
- **The build prompt** (`INTERFACE_RULES` in `server/src/temporal/activities.ts`) tells the builder
  to design for a phone first, run `schmeide:mobile-first` before touching a screen, and treat an
  app with no stylesheet as unfinished. A change build on an older, unstyled app adds the
  stylesheet and brings the screens it touches up to the rules.
- **The phone check** (`server/src/services/mobileCheck.ts`) runs in `runChecks` after `make build`
  and reads `frontend/dist`. It fails the build when the page has no viewport tag with
  `width=device-width`, the viewport tag blocks zoom, the build has no stylesheet, or a rule sets
  a fixed `width` or `min-width` over 320px outside a `min-width` media or container query (a
  `width` with a `max-width` in the same rule is fine). It reads files only; nothing opens the app
  in a browser yet.

## Dev-mode substitutions

Each is marked in code with a `ponytail:` comment.

| Dev mode                                          | Production target                            |
| ------------------------------------------------- | -------------------------------------------- |
| Sign-in limited to approved emails, set by hand   | Open sign-up, invitations, emailed codes     |
| Local git directory per project                   | Self-hosted Forgejo repository               |
| Agent runs on the host in the workspace           | Sandbox pod per job                          |
| Checks run on the host via the project Makefile   | Kubernetes Job                               |
| `make up` with Docker Compose, `localhost:<port>` | AKS namespace per tenant (`SCHMEIDE_RUNNER`) |
| Builds of all projects share one worker           | Task queue per tenant                        |
| Temporal dev server, in memory                    | A real Temporal cluster                      |

## Known gaps

- Sign-in is limited to an approved list set by hand, and only sign-in attempts are rate limited; there are no
  per-tenant quotas or spending limits (#83), so usage is recorded but not enforced.
- Temporal history is lost when its container restarts; project and build rows survive in Postgres.
  A build whose workflow vanished is marked failed when the server next starts.
- A step restarted after a server restart begins again: an agent run starts a new session (with a
  note to continue from the workspace), so it pays again for reading the project.
- The Bash allowlist matches command prefixes, so shell loops (`for f in ...`) and some compound
  commands are denied (logged as `Denied Bash: ...`); the agent retries another way, at the cost of a
  turn. None of the measured runs failed because of it.
- Deployments keep running until stopped. A new project takes the highest web port plus one, so
  ports below that are only reused once the projects above them are deleted.
