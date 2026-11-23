# Measuring the features that work

A change to a build prompt, a model or the build steps can make builds drop features, and nobody would know until an
owner found one. So every such change is measured against the same test apps, and the tester's verdicts are spot
checked by a person.

## The test apps

Each test app is a file in `server/src/eval/apps/`: the features as an owner typed them (`request`) and the acceptance
checks a person wrote for them (`checks`, in the `writtenSchema` shape of `server/src/services/acceptance.ts`).

| File                | App                                                                    |
| ------------------- | ---------------------------------------------------------------------- |
| `todo.json`         | The to-do list `make e2e` builds                                       |
| `contacts.json`     | A contact book: add, a sorted list, search, change and delete          |
| `horse-dating.json` | Horse dating, with the profile photo carousel that once shipped broken |

A build of a test app follows these checks, not the ones the writer would write: `make eval/features` saves them for
the spec before approving it, and `planAcceptance` keeps checks written for the same spec. They are numbered as the
writer's would be (`F2.3`), so a result names the same check in every run.

A check is agreed when the pull request that adds it is approved. Keep each one as exact as the writer is asked to:
something two people would agree happened, made through the app itself.

## Running it

```sh
make serve                                   # in one terminal: the server the builds run on
make eval/features                           # every test app
make eval/features APP=horse-dating          # one
make eval/features KEEP=1 SAMPLE=20          # keep the projects; sample 20 verdicts to mark
```

It drives real builds the way `make e2e` does, one app at a time: real model calls, and minutes and dollars per app.
It writes three files to `~/.schmeide/feature-evals/<time>/` (`OUT=<dir>` to choose):

- `run.json`: what each build recorded: the tester's last result for every check, the fix rounds, time and cost.
- `report.md`: per app, the checks that work out of all its checks, fix rounds, time and cost, then every check that
  does not work with what the tester saw. A check with no result counts as not working.
- `verdicts.json`: a sample of the tester's `works` and `broken` verdicts to mark.

## Marking the tester's verdicts

The tester can be wrong. For each entry in `verdicts.json`, open the app (`KEEP=1`), follow the check yourself, and
set `right` to `true` or `false`. Then:

```sh
make eval/features/report RUN=~/.schmeide/feature-evals/<time>
```

The report then says how often the tester was right, and names each check it passed that was broken and each it
called broken that works. A passed check that was broken is the costly one: the owner gets a feature that does not
work.

## The rules

- **Every feature an owner finds broken that the tester passed becomes a check in a test app.** Add it to the test
  app it fits, or a new one, in the shape above, and link where the owner found it in the pull request.
- **Put the numbers in the pull request of any change to the build prompts, the models or `buildWorkflow`.** Run
  `make eval/features` on `main` and on the branch, and paste both reports. The pull request template asks for them.
