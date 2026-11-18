# schmeide.app

The site at <https://schmeide.app>, built with [React](https://react.dev) and
[Vite](https://vite.dev), typechecked with `tsc`, tested with Vitest, and
deployed as static files to GitHub Pages.

Run `make` to see every target.

```sh
make setup    # install nvm, Node, and dependencies
make serve    # start the Vite dev server
make serve/cloud  # the server and Vite against the cloud's Postgres and Temporal
make build    # typecheck and build the deployable site into dist/
make test     # run tests
make check    # lint, typecheck, and format checks
make fix      # apply lint and format fixes
```

## Serving against the cloud

`make serve/cloud` runs only the platform server and Vite on your machine, against the cloud's Postgres and Temporal,
with no Docker containers for either (builds still use your local docker, git, and `claude`).
`make serve/cloud/watch` also reloads the server on code changes.

One-time setup:

1. Get AKS access and install Telepresence, following [schmeide/iac](https://github.com/schmeide/iac).
2. Read the Postgres password (schmeide/iac documents where it lives) and build the URL with `sslmode=require`:

   ```sh
   export DATABASE_URL='postgres://<user>:<password>@<host>:5432/schmeide?sslmode=require'
   ```

Each time: `telepresence connect`, then `make serve/cloud`. The target fails with a pointer to `telepresence connect`
when Temporal (`temporal-frontend.temporal:7233`) is unreachable, and refuses to run on the local `DATABASE_URL`.

The database is shared, so:

- Migrations do not run by default. Pass `MIGRATE=1` to apply them.
- The local logins are not seeded.
- Your server is also a Temporal worker, and polls its own task queue, `schmeide-$USER` (override with
  `SCHMEIDE_TASK_QUEUE`), so laptops do not take each other's builds. A build you start runs only on your worker: it
  waits while your laptop is off.
- Everyone shares the one `schmeide` database, so workflow IDs (`build-<build id>`) come from one sequence and cannot
  collide. A per-developer database would also need its own Temporal namespace.

## Layout

| Path             | What lives there                                        |
| ---------------- | ------------------------------------------------------- |
| `index.html`     | Page shell and global `<head>` metadata                 |
| `main.tsx`       | Entry point: mounts `<App />` and global styles         |
| `App.tsx`        | Root layout: composes sections, no content of its own   |
| `components/`    | Components, their CSS modules, and `__tests__` specs    |
| `data/copy.ts`   | Typed page copy and outbound links                      |
| `assets/`        | Global styles (`main.css`, design tokens)               |
| `public/`        | Files copied verbatim into the build (`CNAME`, favicon) |
| `vite.config.ts` | Vite and Vitest configuration                           |

## Environment

The site needs no environment variables. If you add one, only `VITE_`-prefixed
variables reach client code, and nothing secret belongs in either — the bundle is public.

### `VITE_MAINTENANCE_UNTIL`

Optional. Set it to announce planned work: while the date is in the future, the site shows the maintenance page
(`components/MaintenancePage.tsx`) with that time as when to come back. Use an ISO 8601 date and time, for example
`VITE_MAINTENANCE_UNTIL=2026-12-01T06:00:00Z`. Unset, empty, or unreadable means no planned work.

It is baked in at build time (`import.meta.env`), so changing it needs a rebuild and a deploy. Only `VITE_`-prefixed
variables reach client code, so the value ships in the public bundle: nothing secret belongs in it.

## Deployment

CI builds the static site and tests it; CD does the same and publishes `dist/` to
GitHub Pages on pushes to `main`. `public/CNAME` sets the custom domain.

One-time setup: in the repository's **Settings → Pages**, set **Source** to
**GitHub Actions**, then point the `schmeide.app` DNS at GitHub Pages.
