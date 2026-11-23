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
   Problem) with the server's own message. "Cancel the build" is below it. A failed first build stays on
   this step: it shows what went wrong and a "Try again" box, where you describe what to fix or just write "try
   again". A canceled first build stays on this step too, but there is no app to go back to and nothing went
   wrong: it says "Canceled", with no "What went wrong" box, and "You canceled this build. Request a change to
   build again."

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

Once a person has a business, every page sits in the app shell: the logo (back to the list), the business name, the
navigation (Apps, Usage, Billing, Help; behind a "Menu" button on a narrow screen), the account menu, and the legal
links in the footer. Usage, Billing, Business, Help, and the legal pages say "This page is not built yet".

Before that, the entry pages (`/sign-in`, `/sign-up`, `/set-password` and `/welcome`) sit in a plainer frame, the next
step after schmeide.com: no app navigation, the logo leads back to schmeide.com, and the account menu shows once someone
is signed in. `/sign-up` is where schmeide.com links to; while Schmeide is invite-only it says so and links to the
early-access form. People sign in with an approved email address ([docs/auth.md](auth.md)). A `?plan=<id>` on
`/sign-up`, `/sign-in` or `/set-password` travels on in the address (inside `next` through a provider sign-in) to
checkout (#61) if the id is a known plan, and is dropped otherwise; nothing is stored, and no plan is known until #119.
"Sign out" in the account menu leads to sign-in on any page but a public one, and sign-in says the sign-out worked.

**Account** (`/account`, from the account menu): change your name; see how you sign in, connect a provider the server
offers, and disconnect one while another way in remains; see where you are signed in and "Sign out everywhere else";
"Download my details" as a JSON file; and "Delete my account". Deleting asks you to type your email address, removes
your account, sign-in methods and approval at once, and removes a business that was only yours and has no apps. It is
refused while a business you alone own still has apps (delete them first) or has other people in it (handing it over
comes with business settings, #66). Changing your email address and the email switches wait for the server to send
email (#88).

The address is the view (`/` for the list, `/projects/<id>` and its views for a project; the full table is
`utils/routes.ts`), so
refresh and Back work. Different projects build at the same time; one project runs one build at a time, because its
builds share its workspace. If the server is not running, the page says to start it with `make serve`. The production
build (GitHub Pages) has no API and shows the "Coming soon" page instead, with no shell.

| Status shown         | Server status     | Meaning                                                |
| -------------------- | ----------------- | ------------------------------------------------------ |
| Describing           | `draft`           | Requests being written; no spec yet                    |
| Writing the spec     | `spec_generating` | The spec is being written                              |
| Spec ready to review | `spec_ready`      | Approve it, or change the requests (discards the spec) |
| Building             | `building`        | A build, a change, a promote, discard, or roll back    |
| Live                 | `live`            | The app is running at its links                        |
| Build failed         | `failed`          | The last build failed; request a change                |
| Canceled             | `failed`          | Last build is `canceled`. A first one has no app yet   |
| Offline              | `stopped`         | Taken offline; putting a version live brings it back   |

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
      records it (`builds.commit`). A passed `initial`, `change`, or `site` build becomes the project's
      next version, numbered from 1 (`builds.version`). The workspace keeps that commit at
      `refs/schmeide/versions/<n>`, and nothing deletes those refs except deleting the project, so each
      version is kept for good. The build records the commit it started from (`builds.base_commit`);
      the first build, which starts from the template, records none. Then `make up` in the workspace
      for **staging** (Compose project
      `schmeide-<slug>_staging`, web port + 10000) and a wait for `/` and `/api/healthz` to answer
      200: status `live`, with `stagingUrl` and `stagingCommit`. Production is left alone, except for an
      app's first passed build: with nothing live to protect, it is promoted at once (below), so a new
      app is live as soon as it is built.
   5. `checkAcceptance`, then `goLive`: with the commit on staging, a tester follows every acceptance
      check in a browser ([How Schmeide knows each feature works](#how-schmeide-knows-each-feature-works)).
      Broken checks go back to the agent, whose fix passes through steps 3 and 4 again, up to 2 rounds.
      So step 4 holds on staging, and `goLive` is what sets status `live`, promotes a first build and
      takes the version's pictures. A `site` build has no tester and deploys in one step.

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
   `release = promoted`. Staging's database is never copied to production. Before production moves,
   its database is copied (`pg_dump --format=custom` through `docker compose exec db`) to
   `~/.schmeide/backups/<slug>/<build id>.dump` and recorded in `database_copies` with the version
   live then; a copy that fails fails the promote with production untouched. An app's first promote
   has nothing to copy. The last 10 copies are kept, and the newest copy of every version that was
   live. On the cluster nothing is copied yet.

   **Checks** run `make check BASE=<builds.base_commit>`, so the template's `check/migrations`
   (schmeide/template#25) refuses any migration since the build's base that takes away or changes
   something. A build that passes with that target is recorded `additive = true`; one whose
   template has no such target is `additive = null` (unknown).

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
   `release = discarded` and no longer count as built. The discarded version's ref stays, so its commit
   is not lost. Both answer `CONFLICT` while a build runs, when
   there is nothing to do, and (discard) when production's commit was never recorded; a suspended
   business can do neither. Each counts toward building time like any build. No model runs for
   either: its summary is one fixed sentence, written when it ends (`RELEASE_SUMMARIES`).

   `projects.rollBack({ id, version, withInformationFrom? })` starts a `rollback` build: production
   runs an earlier version's commit, without the builder, recorded with who asked. Staging is not
   touched; "Put this version live" after it puts staging's version live again, and a roll back to the
   version live before is the undo in general. Two ways to go back:

   - **Keeping today's information** (the default): production's database is copied, then the old
     code runs against it. No migration runs backwards. This is allowed only if every version whose
     migrations have run on the live database since, and that the earlier version does not hold, only
     added to it (`additive = true`; a `site` build changes no data). Otherwise it answers `CONFLICT`
     naming the version, such as "Version 5 changed how your app stores its information, so version
     3 cannot read it. You can go back to version 3 with the information from 12 November, 14:02
     UTC.", and the error carries the copies taken while that version or an earlier one was live.
   - **With the information from a copy** (`withInformationFrom: copyId`, one of those copies): a
     fresh copy is taken, production stops, its database is emptied and the copy restored, then the
     old code starts. Everything entered since that copy is lost.

   If the earlier version cannot start, production goes back to the version that was live (and, after
   a restore, to the information it had), and the build fails with both reasons. It also answers
   `CONFLICT` while a build runs, when the version is already live or is not a passed version of the
   app, when the live commit has no number (an app live before versions existed), and for a suspended
   business. `release` on builds stays as history; what is live is `productionCommit`, and "how many
   changes customers do not see yet" counts the versions on staging's line (`base_commit`) that are
   not on production's. A roll back does not move staging to the version (decided in #228; #231 does
   that, and #230 can offer it next).

8. `projects.stop({ id })` cancels a running build (it ends `canceled`, with no error; the project is `failed`), or
   runs `make down` for both copies (status `stopped`, volumes kept).
9. `projects.delete({ id })` removes both copies and their volumes, the workspace, the app's checkout, and every
   row.
   Refused while a spec or build is running; returns once everything is gone.

`builds.events({ buildId, afterId })` is the live log: pass the last id seen to page forward.

## The interview

A second way to describe a project, beside `projects.setFeatures`: the server asks one question at a
time and keeps a plan up to date from the answers. The screen is "Start the questions" on the project page; the
API is:

- `interview.start({ id, depth? })` asks the first question, or the next one after a turn that
  failed. It does nothing while a question is waiting or once the interview has finished. A
  `depth` given here is set first.
- `interview.setDepth({ id, depth })` picks `quick` (a sketch of about 5 minutes, 10 questions at
  most) or `thorough` (about 20 minutes, 30 questions at most; the default, recommended on screen).
  It can change at any time; going deeper reopens an interview that stopped at the shorter limit.
- `interview.answer({ id, questionId, answer })` stores the answer, changes the plan, and asks the
  next question. An answer is `{ type: "choices", values }`, `{ type: "yes_no", value }`,
  `{ type: "text", value }` (the person's own words, accepted on any question), or
  `{ type: "you_decide" }`.
- `interview.get({ id })` returns the plan items, the answered questions (each with a `why` line),
  the waiting question, the status of each plan section (`not_started`, `sketched`, `ready`), the
  depth and its limit, the checklist points settled, the current stage, and whether it has finished.
- `interview.addItem`, `interview.updateItem`, and `interview.removeItem` edit the plan directly.

The plan's sections: `business` (what it is, and what the app is for), `who` uses the app, what it
`does`, its `rules`, its `screens`, what it `keeps`, and what it `replaces`. Each item is for
`day_one` or `later`, and is marked `you` or `schmeide` by who it came from.

The interview goes through stages in order (`STAGES` in `server/src/services/interview.ts`): the
business, the jobs, the rules, the people, the information, and day one. Each stage has a checklist;
the model reports which points an answer settled, the stage is the first with a point still open,
and a section is `ready` only when every point of the stages that fill it is settled. The prompt
asks it to understand the business first, build each question on earlier answers, raise what such
businesses usually forget as questions, notice contradictions, and give each question a one-line
reason. `docs/interview-eval.md` runs it against scripted owners.

- Each question is one model call on `SCHMEIDE_INTERVIEW_MODEL` (`sonnet`), made while the request
  waits. The interview ends at its depth's limit.
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
  `type_mismatch`, `422 damaged`, `not_yours`, or `unsafe`, `409 too_many_files` or `business_full`,
  `503 scan_unavailable`.
- `files.list({ id })`, `files.rename({ id, fileId, displayName })`, and `files.delete({ id, fileId })`.
- `files.read({ id, fileId })` returns `{ status: "read", proposals, table }` or
  `{ status: "failed", reason, message }`. Proposals are plan items by section. Nothing is added to the plan.
- `projects.requestChange({ id, request, fileIds })` attaches files of the project to the change.

What the server does with a file:

- Accepts PNG, JPEG, WebP, PDF, CSV, and XLSX, decided by the content. A declared type that does not match is refused.
  HEIC is not accepted. Pictures may be 5 MB, other files 10 MB; a project holds 50 files and a business 500 MB.
- Removes camera, location, author, and comment details from a picture before storing it, and keeps only which way up
  it is. A picture it cannot take apart is refused.
- Scans the bytes after the type check and before anything is stored (`services/fileScan.ts`). A PDF with a script, a
  launch action, or an attached file is refused from its structure, and so is an Excel file with macros, whatever the
  scanner says. The scanner is ClamAV in the cluster (`SCHMEIDE_CLAMAV_ADDRESS`, the clamd `INSTREAM` command). That
  follows the recommendation: ClamAV runs in the cluster with no internet egress except its signature updates, so a
  customer file does not leave the platform. Deploying it belongs in `schmeide/iac`. On a localhost address with the
  variable unset, a stand-in passes every file (`ponytail:`). A public address with it unset refuses to start.
- A file the scan refuses answers `422 unsafe` and nothing is stored. The refusal is a JSON file under
  `review/upload-refusals/` for the operator list (#277). If the scanner cannot be reached, or it times out, the
  answer is `503 scan_unavailable` and the file is not stored.
- A PDF that passes is stored as sent. A spreadsheet that is `mine` and `in_app` is rewritten first: a cell that
  begins with `=`, `+`, `-`, or `@` gets a leading quote, so a spreadsheet program does not run it when the file is
  copied into the app. `neutralizeSpreadsheet` is the same rewrite for a later download (#85). Any other spreadsheet
  is stored as sent.
- Files already on disk are scanned once, the first time the API starts against this scanner. One that fails is
  removed and recorded. The marker is `review/stored-files-scanned`, and it names the scanner, so pointing the
  variable at ClamAV later scans them again. If the scanner is down, the marker is not written and the next start
  tries again.
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

| Variable                   | Default                                    | Meaning                               |
| -------------------------- | ------------------------------------------ | ------------------------------------- |
| `PORT`                     | `3100`                                     | API port (Vite proxies to it)         |
| `DATABASE_URL`             | Postgres on `:5440`, database `schmeide`   | Customer database                     |
| `TEMPORAL_ADDRESS`         | `localhost:7233`                           | Temporal frontend                     |
| `SCHMEIDE_DATA_DIR`        | `~/.schmeide`                              | Workspaces, files, logs, make shim    |
| `SCHMEIDE_TEMPLATE`        | `https://github.com/schmeide/template.git` | Git URL or local path to clone        |
| `SCHMEIDE_AGENT_MODEL`     | `opus`                                     | Fallback model for every agent run    |
| `SCHMEIDE_INTERVIEW_MODEL` | `sonnet`                                   | Model for questions and for reading   |
| `SCHMEIDE_WEBSITE_MODEL`   | `sonnet`                                   | Model for reading a website           |
| `SCHMEIDE_SUMMARY_MODEL`   | `haiku`                                    | Model for a build's running summary   |
| `SCHMEIDE_CLAUDE_BIN`      | `claude` on `PATH`                         | Claude Code executable the SDK runs   |
| `ANTHROPIC_API_KEY`        | unset (uses the CLI login)                 | Model credential in a container       |
| `SCHMEIDE_AGENT_CMD`       | unset                                      | Fake agent command instead of Claude  |
| `SCHMEIDE_TASK_QUEUE`      | `schmeide`                                 | Temporal task queue of this server    |
| `SCHMEIDE_BUILDS`          | `on`                                       | `off`: none; `admins`: admins only    |
| `SCHMEIDE_ROLE`            | `all`                                      | `api` or `worker`: one half only      |
| `SCHMEIDE_DESIGN_TEAM`     | unset (off)                                | `1` turns on the design team (below)  |
| `SCHMEIDE_ACCEPTANCE`      | unset (on)                                 | `0` turns off the acceptance checks   |
| `SCHMEIDE_CLAMAV_ADDRESS`  | unset (every file passes)                  | ClamAV `host:port` that scans uploads |

### Building on the cluster

`SCHMEIDE_RUNNER=kubernetes` (default `host`) makes the worker keep each project in a Forgejo repository and run the
agent and the checks as Jobs in `schmeide-builds` (`docs/stage2.md`, slice 1 step 2). Only the worker reads these; it
checks at startup that it can use Forgejo, the Kubernetes API, Azure and the provisioner database, and that it can
start Chromium, and refuses to start with what to fix. It deploys as [Production](#production) says. Files attached
to a change are refused until slice 2.

The server image carries Playwright's headless Chromium and its system libraries (`PLAYWRIGHT_BROWSERS_PATH`,
`/opt/playwright`), at the version the lockfile pins: the worker takes each version's pictures with it. That is
about 0.9 GB of the image.

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

| Run kind     | What it is                                         | Variable                          |
| ------------ | -------------------------------------------------- | --------------------------------- |
| `spec`       | Writing the plain-language spec                    | `SCHMEIDE_AGENT_MODEL_SPEC`       |
| `initial`    | The first build from the spec, and its fix-up runs | `SCHMEIDE_AGENT_MODEL_INITIAL`    |
| `change`     | A change request on a built app, and its fix-ups   | `SCHMEIDE_AGENT_MODEL_CHANGE`     |
| `design`     | The design lead choosing an app's look             | `SCHMEIDE_AGENT_MODEL_DESIGN`     |
| `review`     | The design review of a build against its brief     | `SCHMEIDE_AGENT_MODEL_REVIEW`     |
| `acceptance` | Writing the acceptance checks of a build           | `SCHMEIDE_AGENT_MODEL_ACCEPTANCE` |

- A kind whose variable is unset or empty uses `SCHMEIDE_AGENT_MODEL`, except `design`, `review` and `acceptance`,
  which use `sonnet`: they judge and write no code, so a mid-size model does. With none of them set, every build
  run uses that one model, as before.
- The server prints the resolved table at startup. Each build run adds an event with the model and the reason, for
  example `Model sonnet for this change run (SCHMEIDE_AGENT_MODEL_CHANGE routes change runs)`, just before
  `Agent started (...)`, which shows the model the SDK resolved it to.
- Every `usage` row carries `run_kind`, so cost per kind is one query:
  `select run_kind, model, sum(cost_usd) from usage group by 1, 2`. An interview question is a fourth kind there,
  `interview`; its model is `SCHMEIDE_INTERVIEW_MODEL`, not this table. Reading a website is a fifth, `website`, on
  `SCHMEIDE_WEBSITE_MODEL`. Reading an uploaded file is a sixth, `read`, on `SCHMEIDE_INTERVIEW_MODEL`. A build's
  running summary is a seventh, `summary`, on `SCHMEIDE_SUMMARY_MODEL`; it is Schmeide's cost, left out of what a
  project or business is shown or counted against, and shown in the admin area's usage by kind of run. The design
  lead's runs are `design`, the design reviewer's `review`.
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
- `~/.schmeide/backups/<slug>/<build id>.dump`: copies of production's database taken before a promote or a roll
  back, removed with the project.
- `~/.schmeide/files/<business id>/<project id>/<file id>`: uploaded files, removed with the file or the project.
- `~/.schmeide/logs/build-<id>.log`: full command output and every raw agent message for a build.
  `e2e-fake-server.log` is the `make e2e/fake` server's output.
- `~/.schmeide/attachments/build-<id>/`: the files a change attached, staged read-only for the builder.
- `~/.schmeide/review/upload-refusals/`: one JSON file per upload the scan refused, for the operator list (#277).
- `~/.schmeide/review/stored-files-scanned`: written after files already stored have been scanned once.
- `~/.claude/projects/<staging path, dashed>/` (or under `CLAUDE_CONFIG_DIR`): the agent's session transcripts.
- `~/.schmeide/bin/make`: a link to GNU make, first on `PATH` for project runs and the agent.
- `~/.schmeide/gitconfig`: neutral git identity used instead of your global git config.
- Each deployed project is two Compose projects: `schmeide-<slug>` on `http://localhost:<web port>` and
  `schmeide-<slug>_staging` on `http://localhost:<web port + 10000>`; its `make test` database uses port
  `5600 + n` for web port `8100 + n`. Web ports stay below 18100 (a database check), so the ranges never meet.

### How long records are kept

`services/retention.ts` holds one period per kind of record, and the worker deletes what is past it at start and
daily after, recording how many of each kind it removed as a `retention sweep` row in the audit log. The periods are
a starting point until a lawyer has read them (#275).

| Kind             | Kept for                    | What                                         |
| ---------------- | --------------------------- | -------------------------------------------- |
| `build_logs`     | 90 days from the last write | Build logs and staged attachments            |
| `agent_sessions` | 90 days from the last write | The agent's session transcripts              |
| `website_reads`  | 1 day                       | The website read limit's record of each read |
| `sign_ins`       | 30 days after they expire   | Sign-in sessions and provider sign-ins       |
| `usage`          | 10 years                    | Tokens and cost, for billing                 |
| `audit_log`      | 10 years                    | What admins did (`admin_actions`)            |

A deleted project's build logs, attachments and transcripts go with it: the sweep removes any whose build or project
no longer exists, however new. Not yet done (#275): removing them at the moment of deletion (a call in the
`removeProject` activity), keeping usage and audit rows of a deletion without personal details, deleting refused
uploads (now under `review/upload-refusals/`, #276) and reports (which do not exist yet) after a year, and publishing
the periods on the privacy page and in "Download my details".

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
  ACR, and runs one ACR quick run that builds and pushes `apps/t<tenant>/<slug>/web` and `.../api` tagged with the
  commit; the frontend bundle is built inside `frontend/Dockerfile`, never in a `cmd` step (#214). A failed
  run's event carries the end of its log and a link to all of it.
- **Namespace**: `tenant-<tenant id>`, applied on every deploy (server-side apply, so it is idempotent) with the
  worker's RoleBinding to `schmeide-tenant-deployer`, a ResourceQuota, a LimitRange, and NetworkPolicies that let
  in only Traefik on 8080 and out only DNS and Postgres on 5432.
- **Each copy** (`app-<id>` for production, `app-<id>-staging`): a Deployment (nginx `web` on 8080 and Node `api` on
  3000, a `migrate` init container, restricted pod security with a read-only root and an `emptyDir` `/tmp`), a
  Service, an Ingress for its host, and a Secret with `DATABASE_URL` for its own database and role (`app_<id>`,
  `app_<id>_staging`), made through `SCHMEIDE_PROVISIONER_URL`.
- **Addresses**: `https://<slug>-<6 random>.apps.schmeide.com` for production and `...--staging` for staging; the
  first label is `projects.host`, chosen on the first deploy. The wildcard certificate serves both.
- **Deploy** waits for the rollout and for `/` and `/api/healthz` to answer 200 over https (five minutes). A rollout
  that times out fails with the Deployment's own reason (an exceeded quota, say); a staging copy that did is scaled
  to zero, production is left as it is. A promote runs staging's images on production, records its commit, and then
  fast-forwards `main`; a discard force-pushes `staging` back, scales staging to zero, drops and recreates its
  database, and starts it again.
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
`runs/read`, `runs/cancel/action` and `runs/listLogSasUrl/action`, plus Container Registry Repository Contributor
limited to `apps/`: a quick run in ABAC mode pushes as its caller, and a delete removes the repositories. The
cluster's kubelet identity needs Container Registry Repository Reader on `apps/` to pull.

## App shapes

The template ships working starting points for common kinds of app, in `docs/shapes/` (#100): `assets`, `bookings`,
`customers`, `dashboard`, `deals`, `handbook`, `invoices`, `orders`, `requests` and `stock`, plus `notes`, the sample
a build replaces. A first build keeps the shapes the spec needs and the template deletes the rest, so the agent adapts
working code instead of starting from nothing.

`services/shapes.ts` picks them with `chooseShapes`. `make shape/list` gives the shapes the template has, and a shape
is chosen when the spec mentions its name (singular or plural) or one of its keywords, as a whole word, ignoring case:
`bookings` on "appointments" or "schedule", `invoices` on "quote" or "receipt", `stock` on "inventory", and so on.
The chosen shapes keep the order the spec first mentions them: the first is the home page and the order is the menu's.
If none matches, only `notes` is kept and the build replaces it. `make shape/keep` then deletes the others, and the
build prompt names the kept shapes and their docs.

The match is by keyword, so a passing word can keep a shape the build then has to drop. The choice is stored in
`projects.shapes` (a `jsonb` list, default `[]`, migration `0031_project_shapes.sql`). A template with no `shapes/`
directory is used whole and stores nothing.

## How Schmeide knows each feature works

A spec is short bullets, and "a photo carousel on the profile" does not say when the carousel is done. So before
the builder runs, every feature gets **acceptance checks** (`server/src/services/acceptance.ts`): short journeys a
person could follow in the running app, each with where they start and what must exist, what they do, and what they
must then see.

- **Who writes them.** `planAcceptance` in `server/src/temporal/activities.ts` (run kind `acceptance`), at the start
  of every build but a `site` one. It is one model answer with no tools and no project settings, given only the spec
  (fenced off as material, never instructions) and held to a JSON schema. The builder has no say in them.
- **What they are.** One to four checks per feature, each with an id such as `F3.2` (feature 3, check 2). A feature
  with parts that can break alone gets a check per part.
- **Where they are kept.** `project_acceptance`, one row per project, with a hash of the spec they were written
  from. A rebuild of the same spec keeps them; a first build from another spec writes them again.
- **A change adds to them.** The writer is given the checks there are and the request, and answers with the checks
  the change needs and the ids of those it makes untrue. A retired check stays in the row, so an id is never used
  twice. A change that needs none says so. An app built before there were checks gets them on its next change, from
  the spec and every change built since.
- **The builder is told.** Its prompt carries every live check and says a tester will follow them in the running
  app, 360px wide, and that a passing test of its own does not make a check pass.
- **Soft.** An answer that does not fit, or no answer, is one event and the build goes on without new checks.
- `SCHMEIDE_ACCEPTANCE=0` turns all of it off, and builds run as they did before.

### The tester

Once a build's commit is up on staging, `checkAcceptance` follows every live check in the running app. It is the
only step that tries a feature the way a person would.

- **Who.** A fresh model run per feature (run kind `acceptance`), a few features at a time. A tester gets its
  feature's checks and a browser. It gets nothing from the builder: no session, no code, no workspace, no file or
  shell tool, and no tool server but the browser's (`strictMcpConfig`).
- **The browser** (`server/src/services/appBrowser.ts`) is the worker's Playwright Chromium, 360px wide, given as
  ten tools: `open` a path, `read` the page as roles, names and text, `look` at a picture of it, `click`, `type`,
  `choose`, `press` a key, `swipe`, `upload` sample pictures, and `resize`. The sample pictures are flat colors in
  a fixed order (red, blue, green, yellow, purple), so the tester can tell which photo a screen shows.
- **It reaches staging only.** Every request to another origin is refused, web sockets included, and `open` takes
  a path. A link out of the app puts the tester back in the app and says so.
- **What it answers.** For each check, `works`, `broken` or `could_not_check`, with a sentence of what it saw. A
  verdict from a tester that never opened the app, a check it left out, and an answer out of form all count as
  `could_not_check`.
- **The gate.** Broken checks go back to the builder's session as a fix round, each with what the tester saw (up to
  2 rounds, `MAX_ACCEPTANCE_ROUNDS` in `server/src/temporal/workflows.ts`). The fix goes through `runChecks` and
  onto staging again, and every check is followed once more. An app's first build goes live only after this loop:
  `deploy` is held on staging (`hold`) and `goLive` does the rest.
- **What is left.** A check still broken after the last round is recorded and the build finishes: the version is
  kept, with that feature not working yet. `could_not_check` never causes a fix round.
- **Where results are.** `build_acceptance` holds each check's last result for the build, and every result is a
  build event, such as `F1.1 is broken: Photo carousel. Tapped Next photo twice; the picture stayed red.`
- **Soft.** No browser, a browser that does not open, or a tester that fails is said in an event and never fails
  the build.

Known limits:

- The tester leaves what it made (accounts, records, pictures) in staging's database. Production has its own.
- A tester can be wrong. A check it wrongly calls broken costs a fix round. One it wrongly calls working is what
  #359 measures.
- The owner sees results only as lines in the build log until #357.
- The server image has no Chromium yet (#355), so on the cluster the tester's browser does not open and every check
  is recorded as could not be checked.
- On one run against a test page with a photo carousel, a tester took about 7 seconds and 2 cents for a feature
  with two checks, and told a carousel whose Next button did nothing from one that worked.

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

## How built apps get their look

The phone rules above are the floor. On top of them, a built app gets one of a small library of
styles (`server/src/services/designStyles.ts`), authored here and reviewed by a person:

| Style       | For                                                          | Not for                             |
| ----------- | ------------------------------------------------------------ | ----------------------------------- |
| `calm`      | Booking, client portals, services: room and one action       | Long lists of numbers               |
| `ledger`    | Inventory, orders, invoices: dense rows, aligned numbers     | Members of the public using it once |
| `friendly`  | Clubs, classes, small shops: warm colors, pill buttons       | Money and formal records            |
| `bold`      | Field work, check-ins, warehouses: big type, high contrast   | Long reading                        |
| `editorial` | Catalogs, menus, directories: serif headings, hairline rules | Form-heavy work                     |

Each is exact: color tokens for light and dark (the token names of the mobile-first skill's
`base.css`, plus `--control-border` for the edge of a form control), a type scale with system font
stacks only, spacing, radii, and how the page frame, menu, table, form, button and empty state look.
`calm` is the default. A test checks every style against the phone floor (16px text, 44px taps,
8px between them) and WCAG AA contrast in both themes: 4.5:1 for text, links, the text on the
accent and the danger color, 3:1 for control edges and the focus ring (`contrastRatio` in
`server/src/services/contrast.ts`).

### The design team

Off unless `SCHMEIDE_DESIGN_TEAM=1`, so it can be merged dark and measured on the to-do fixture before it is turned
on by default (#83). With it off, builds run exactly as above: no extra runs, the same prompts.

- **The design lead** (`planDesign` in `server/src/temporal/activities.ts`, run kind `design`) runs before the builder
  on a project's first build. It is one model answer with no tools and no project settings, given only the spec
  (fenced off as material, never instructions) and the style library. Its answer is held to a JSON schema: the style's
  id, a one or two sentence reason, and the layout of each screen in the spec. An answer that does not fit, names a
  style not in the library, or does not come at all gives the default style, recorded as `fallback`, and the build
  goes on.
- **Brand colors.** Reading the business's own website keeps the colors it found on the project (`brand_colors`).
  The first one that is a `#rrggbb` color, reads at 4.5:1 on the style's background and surface, and has a text color
  that reads on it at 4.5:1 becomes the accent, in each theme separately. A color that fails is not used. The logo is
  not used yet.
- **The brief** is stored in `project_designs`: the style, who chose it (`lead`, `fallback`, or `person`), the reason,
  the resolved tokens, the brand colors used, and the screens. It is made once: a rebuild of the same spec keeps it,
  and every later change reads it.
- **Design applied up front.** The builder's prompt carries the brief. On a first build it says to lay the foundation
  before any screen: the shared stylesheet with exactly the brief's tokens (as a `:root` block, dark values under
  `prefers-color-scheme`), then each shared piece once (page frame, menu, form, table or list, button, empty state)
  styled as the style says, then the screens from those pieces only. This is prompt instructions in the one build
  run, not a run of its own: a separate run would read the whole project again and hand its work over through git,
  for no gain the checks could see. On a change the prompt says to keep to the brief and not change the look.
- **The design review** (`reviewDesign`, run kind `review`) runs after `runChecks` passes and before deploy, on a
  first build and on a change that touches the interface: the build's changes since it started (committed or not)
  include a file under `frontend/` that is not a test (`touchesInterface` in `server/src/services/designReview.ts`).
  Other changes skip it. The reviewer compares every screen in the spec with the brief and returns at most fifteen
  problems, each `serious` or `minor`, serious first. Serious ones go back to the builder's session as a fix round
  (up to 2, `MAX_REVIEW_ROUNDS`); each round's work goes through `runChecks` again, so the phone check and the make
  targets can still fail the build as before. What is still wrong after the last round, and every minor problem, is
  recorded as `Left for later` events and the app is published with it. A reviewer that fails or answers out of form
  is recorded and passes the build.
- **What the reviewer sees.** It has `Read`, `Glob` and `Grep` in the workspace and nothing else: no Bash, no
  writes, no web. It is meant to work from pictures of the running app at 360px and 1280px, light and dark, taken
  through the `ScreenCapture` seam passed to `createActivities`. Nothing takes pictures yet (`noBrowser`): there is no
  browser where builds run. So today it is a **code-based review**, and its prompt says so: it reads the shared
  stylesheet and the screens under `frontend/src/` and judges from the markup and CSS. It cannot see overflow,
  rendering, or contrast as drawn.
- **Apps built without a brief** (before the design team, or with it off) keep their look: a change build makes no
  brief and gets none. Such an app gets a brief only when the person picks a look.
- **The person sees the look and can pick another.** While the design team is on, the app's home shows a "Look"
  section under the spec it was built from: the look in plain words, why it was chosen (the lead's reason, the
  default, or "You picked it"), and every style to pick from (`design.get`, `design.pick` in `server/src/router.ts`,
  `server/src/services/designs.ts`). Picking another stores it as the brief, chosen by `person`, keeping the screens
  the lead laid out. Before the first build that is all; the first build keeps it. On an app that has been built it
  also starts a restyle change (queued behind a running build), whose request asks the builder to set the stylesheet's
  tokens to the new brief and restyle the shared pieces; it is reviewed like any change that touches the interface.

## Dev-mode substitutions

Each is marked in code with a `ponytail:` comment.

| Dev mode                                          | Production target                                 |
| ------------------------------------------------- | ------------------------------------------------- |
| Sign-in limited to approved emails, set by hand   | Open sign-up, invitations, emailed codes          |
| Local git directory per project                   | Self-hosted Forgejo repository                    |
| Agent runs on the host in the workspace           | Sandbox pod per job                               |
| Checks run on the host via the project Makefile   | Kubernetes Job                                    |
| `make up` with Docker Compose, `localhost:<port>` | AKS namespace per tenant (`SCHMEIDE_RUNNER`)      |
| Builds of all projects share one worker           | Task queue per tenant                             |
| Temporal dev server, in memory                    | A real Temporal cluster                           |
| Upload scan passes every file (`ponytail:`)       | ClamAV in the cluster (`SCHMEIDE_CLAMAV_ADDRESS`) |

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
- When a promoted version cannot start, production goes back to the version it was running. `make up` may already
  have run the new version's migrations against production's database by then, so the old code is safe on it only if
  those migrations were additions. Every build now checks that (schmeide/template#25), but an app made from an older
  template has no such check until #206 brings it, and its versions count as unknown.
