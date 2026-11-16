# Contributing

Thanks for wanting to help. Here's how it works.

## Before you start

Make sure your git config (`user.name` and `user.email`) matches your GitHub
profile. **Sign your commits** — here's
[how to set that up](https://gist.github.com/Beneboe/3183a8a9eb53439dbee07c90b344c77e)
if you haven't already. Sign off with `git commit -s`.

Then get the site running:

```sh
make setup   # install nvm, the Node version in .nvmrc, and dependencies
make serve   # Vite dev server with hot reload
```

`make help` lists every target.

## The workflow

1. Branch off `main`, named after the issue: `123_short-description`
2. Keep your branch up to date with `main`
3. Open a PR with a brief description of what changed and why
4. A maintainer will review it

We do linear commit history. One focused commit per PR is the norm — if you've
got a stack of commits, we'll ask you to squash or rebase them cleanly.
[This post](https://www.bitsnbites.eu/a-tidy-linear-git-history/) explains the
reasoning.

`main` deploys to GitHub Pages automatically. A merge is a publish.

## Commit messages

Clear and concise. Under 80 characters for the subject line. If you need more
context, add a body (120 char line limit).

Conventional commits, lowercase and imperative, with the issue number as the scope:
`feat(123): add null check`, not `123: Added null check`. `type` is one of `feat`, `fix`, `docs`, `style`, `refactor`,
`perf`, `test`, `build`, `ci`, `chore` or `revert`. The PR title becomes the commit subject, and CI fails any title
that is not in this form. Put the issue number in the PR body too (`Closes #N`).

## Code style

Run `make check` before you push. If the linter is unhappy, fix it first —
`make fix` handles most of it. Run `make test` too.

CI runs the build and the test suite, and a separate Check workflow runs
`make format` and fails if it produced a diff.

[`AGENTS.md`](AGENTS.md) has the conventions in detail — component structure,
where copy lives, and styling rules. It applies to humans as much as to agents.

## Changing the copy

Every string on the page lives in `data/copy.ts`. Edit it there rather than in
components.

## Found a bug or have an idea?

[Open an issue](https://github.com/schmeide/schmeide.app/issues/new/choose).
We read them.
