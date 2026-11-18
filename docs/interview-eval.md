# Judging the interview

The quality of the interview's questions is the product, so each change to its prompt is run against the same
scripted owners and the transcripts are read side by side. The owners live in `server/src/eval/owners.ts`: a plumber,
a hair salon, a bakery with wholesale customers, and a bookkeeper. Each has a fact sheet it answers from, and a list of
blind spots: things the owner never brings up but an expert in that kind of business would ask about.

## Running it

```sh
make interview/eval                    # every owner, thorough
make interview/eval DEPTH=quick        # the quick sketch
make interview/eval OWNER=plumber      # one owner
make interview/eval MODEL=opus         # another interview model
```

It makes real model calls and costs money: one call per question for the interviewer, and one per answer for the
owner, played by the fast model. It needs `claude` signed in (`make doctor` checks). It uses no database.

Transcripts go to `docs/interview-transcripts/<depth>/<owner>.md`, and the measures for all owners to
`docs/interview-transcripts/<depth>/README.md` (only when every owner ran). Commit them with the prompt change they
judge, so `git diff` shows the questions changing next to the prompt.

## Reading the transcripts

Each question shows its reason, its choices, the owner's answer, how long it took and what it cost, and two marks:

- **builds on an answer**: the question repeats three words of an earlier answer, or says "you said". A question that
  could have been asked first is a weak one by the tenth.
- **raises _topic_**: the question raises one of the owner's blind spots before the owner mentioned it.

The marks are word matches, so they miss paraphrases and can count a coincidence; they point at what to read, they do
not replace reading. Read the same owner's transcript before and after a change, and ask: does it understand the
business before the app, do later questions follow earlier answers, does it bring up what the owner would not, and
does it notice contradictions? The end of each transcript lists the plan it built and the checklist points left
open, which the spec states as assumptions.
