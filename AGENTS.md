# `AGENTS.md`

## Purpose

These instructions tell coding agents how to work in this repository.

`schmeide.app` is a [React](https://react.dev) single-page site built with
[Vite](https://vite.dev), typechecked with `tsc`, tested with Vitest and
Testing Library, and deployed as static files to GitHub Pages.

## Key rule (always)

- Respect the linting and formatting conventions of the various linting and
  formatting configurations and tools being used.
- The configs are the source of truth: `eslint.config.ts`, `.prettierrc`,
  `.prettierignore`, `.markdownlint.yaml`, `tsconfig.json`, and
  `vite.config.ts`. Do not override them inline (no blanket `eslint-disable`,
  no `any`, no `@ts-ignore`) to make a change pass.

## Test-Driven Development (strongly preferred)

1. Write or update a test that captures the desired behavior.
2. Run it and confirm it fails.
3. Implement the minimal code to make it pass.
4. Refactor with the tests still passing.

For a pure refactor, run the existing tests before and after.

## Use Makefile Targets

- Use the Makefile targets to `serve`, `build`, `test`, and `check` the
  codebase rather than crafting your own shell commands.
- If an action needs to be templatized for general usage, add a new Makefile
  target for it rather than running raw commands.
- `make help` lists every target and is the default goal.

| Target       | What it does                                         |
| ------------ | ---------------------------------------------------- |
| `make setup` | Install nvm, the Node version in `.nvmrc`, deps      |
| `make serve` | Vite dev server with hot module replacement          |
| `make build` | Typecheck and build `dist/` — what CI/CD ships       |
| `make test`  | Run the Vitest suite once                            |
| `make check` | ESLint, `tsc`, Prettier, and markdownlint            |
| `make fix`   | Apply ESLint, Prettier, and markdownlint fixes       |
| `make clean` | Remove `dist/`, `coverage/`, and Vite's module cache |

## Development assumptions

- Assume the developer is running the site via `make serve` and that Vite will
  hot-reload on code changes.
- Never attempt to start, stop, or restart the dev server yourself.
- Focus on code changes only; the running server will pick them up.
- To confirm the deployable bundle is sound, use `make build`.

## Project type

- A Vite + React + TypeScript app, built to static files and served by GitHub
  Pages. There is no backend and no runtime data source.
- No router, state library, or CSS framework. Do not introduce one without a
  reason in the PR body.
- Runtime dependencies are `react` and `react-dom`. Anything new belongs in
  `devDependencies` unless it genuinely ships to the browser, and adding it
  needs a reason in the PR body.
- Do not add third-party embeds, remote fonts, remote scripts, analytics, or
  tracking pixels. Self-host assets under `public/` or `assets/` instead.

## Current app structure (follow this)

- `index.html`: the page shell and the single source of truth for global
  `<head>` tags (title, description, Open Graph/Twitter, theme color).
- `main.tsx`: entry point. Imports `assets/main.css` and mounts `<App />`.
- `App.tsx`: root layout. Composition only, no page content.
- `components/`: one public component per file (`Hero.tsx`), with its styles in
  a sibling CSS module (`Hero.module.css`).
- `components/__tests__/`: Vitest specs, named `<Component>.test.tsx`.
- `data/copy.ts`: every string that appears on the page, plus outbound URLs.
  Components import from here; they do not hardcode copy.
- `utils/`: pure TypeScript logic that needs no React, tested under
  `utils/__tests__/`. Create it when the first such function exists.
- `assets/`: global styles and bundled static assets.
- `public/`: files copied verbatim into the build (`CNAME`, favicon, images).
- `vite.config.ts`: dev server, build, and Vitest config in one file.
  `vitest.setup.ts` registers the `jest-dom` matchers.

## Code organization rules

- Keep page content out of `App.tsx`; it wires sections together and nothing
  else.
- Prefer small, focused components: extract a visibly independent section into
  its own component once it earns a name.
- Page copy lives in `data/copy.ts` as `as const` data. Components render it
  with `.map()`; they never inline a sentence in JSX. A copy change should touch
  one file.
- For shared tuning values (colors, spacing, radii, widths), use the design
  tokens defined on `:root` in `assets/main.css` and reference them with
  `var(--token)`. A raw color literal in a component is a bug; add a token
  instead.
- Media-query breakpoints must stay literal — custom properties are not valid
  in media conditions. Keep them in sync with the `--breakpoint-*` tokens.
- Prefer immutable bindings: `const` unless reassignment is required,
  `readonly`/`as const` on data that is never mutated.

## Styling

- Component styles belong in a CSS module next to the component. Only
  genuinely global rules (resets, tokens, `body`) go in `assets/main.css`.
- Do not reach across component boundaries with global selectors to restyle a
  child component; give the child a prop or a class instead.
- Use relative units and `clamp()` for type scale so layouts survive zoom and
  narrow viewports.
- Every color token has a dark-mode value under
  `@media (prefers-color-scheme: dark)` in `assets/main.css`.

## UI/layout principles

- The page must not scroll horizontally at any viewport width. Test at 320px.
- Wide content (tables, code blocks) scrolls inside its own
  `overflow-x: auto` container rather than widening the page.
- Use `grid-template-columns: repeat(auto-fit, minmax(min(<min>, 100%), 1fr))`
  for card layouts so they reflow without a media query per breakpoint.
- Give images explicit dimensions or an `aspect-ratio` so the page does not
  shift as they load.
- Every interactive element must be reachable and visible via keyboard; keep
  the `:focus-visible` outline intact.
- Use real semantic elements (`header`, `nav`, `main`, `section`, `footer`,
  `button`, `a`). Do not attach click handlers to `div`s.
- Images need meaningful `alt` text; decorative elements need
  `aria-hidden="true"`.

## Testing and validation

- Add or update focused tests under `components/__tests__/` for non-trivial
  changes.
- Test rendered output and behavior, not implementation details: query by role
  and text the user sees, assert on element counts and `href` targets.
- Assert on content that would silently rot — outbound links, the headline —
  so a copy change that breaks an invariant fails loudly.
- Do not assert on CSS class names or DOM nesting that carries no meaning.
- Run `make test` and `make check` before declaring a change done. Both must
  pass, and `make build` must succeed.
- CI runs the build plus tests, and a separate Check workflow runs
  `make format` and fails if it produced a diff. Run `make fix` before pushing.

## Markdown

- Markdown files are linted by `markdownlint-cli2`; `.markdownlint.yaml` is the
  source of truth (currently a 120-column wrap, MD033/MD041 disabled).
- Run `make fix` to apply the mechanical fixes, then reflow long lines by hand.

## Pull request and commit conventions (always follow this)

- The description should be lowercase, imperative mood:
  `<issue number>: add null check`, not `<issue number>: Added null check`.
- Include the issue number in the PR body (`Closes #N`).
- Branch names should reflect the issue: `123_short-description`.
- Fill out the PR template — what, why, and how it was tested. "How was this
  tested?" should name the targets you ran and the viewports you checked.
- Commits must be signed off (`git commit -s`).
- This repository keeps a linear history; one focused commit per PR is the
  norm.

## Deployment and generated code

- `main` deploys to GitHub Pages automatically. A merge is a publish — treat
  changes to `main` as user-facing.
- `public/CNAME` sets the custom domain; Vite's `base` is `/` because of it.
  If the custom domain is ever dropped, `base` must become `/schmeide.app/`.
- Do not manually edit generated artifacts or build outputs (`dist/`,
  `coverage/`, `*.tsbuildinfo`, `node_modules/`).
- Do not hand-edit `package-lock.json`; change `package.json` and let npm
  regenerate it.
- Only `VITE_`-prefixed environment variables reach client code. Nothing secret
  belongs in either — the bundle is public.
