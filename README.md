# schmeide.app

The site at <https://schmeide.app>, built with [React](https://react.dev) and
[Vite](https://vite.dev), typechecked with `tsc`, tested with Vitest, and
deployed as static files to GitHub Pages.

Run `make` to see every target.

```sh
make setup    # install nvm, Node, and dependencies
make serve    # start the Vite dev server
make build    # typecheck and build the deployable site into dist/
make test     # run tests
make check    # lint, typecheck, and format checks
make fix      # apply lint and format fixes
```

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

## Deployment

CI builds the static site and tests it; CD does the same and publishes `dist/` to
GitHub Pages on pushes to `main`. `public/CNAME` sets the custom domain.

One-time setup: in the repository's **Settings → Pages**, set **Source** to
**GitHub Actions**, then point the `schmeide.app` DNS at GitHub Pages.
