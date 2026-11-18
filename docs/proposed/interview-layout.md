# Interview layout (draft)

Status: Proposed, needs owner approval.

Refs #49. Nothing here is built or decided; it compares layouts so the owner can choose one.

## What exists today

`components/InterviewStep.tsx` already shows one question beside "Your plan" (four-plus sections, each with a
status, "New" tags, a polite live region, a trail of answers in a `details`). The grid is two columns from 960px
(`InterviewStep.module.css`); below that the plan simply stacks under the question. What #49 asks for and the code
lacks:

- On a narrow screen, the plan behind a labeled control that shows its item count, rather than a long page below.
- An editable plan: reword, remove, move to "Later", and "Add something" per section.
- Reopening an earlier answer, with a warning of which later items would go.
- "You decide" items marked, and heads-ups ([#50](heads-up-triggers.md)) attached to the item that caused them.

Issue #49 says to build "three takes" but does not name them. These are the three this draft compares.

## The three layouts

### A. Side by side, plan stacks below (today's shape, extended)

Two columns from 960px. Under that, question first, the whole plan after it, with an item count in the plan heading.

```text
320px
+------------------------+
| What do you need?      |
| Q: Who sends invoices? |
| ( ) Just me            |
| ( ) My staff           |
| ( ) Something else     |
| [Continue] [You decide]|
|------------------------|
| Your plan (7)          |
| Who uses it            |
|  - Owner         New   |
| What it does           |
|  - Send invoice  New   |
| Its screens ...        |
| What it keeps ...      |
+------------------------+
```

### B. Question first, plan behind a labeled control

Same two columns from 960px. Under that, only the question shows, with a button "Your plan (7 items)" that opens the
plan as a panel (a `details`, or a dialog if it must cover the question).

```text
320px, plan closed          320px, plan open
+------------------------+  +------------------------+
| Q: Who sends invoices? |  | [Hide your plan (7)]   |
| ( ) Just me            |  | Who uses it            |
| ( ) My staff           |  |  - Owner         New   |
| ( ) Something else     |  | What it does           |
| [Continue] [You decide]|  |  - Send invoice  New   |
|                        |  |   [Reword][Remove]     |
| [Your plan (7) v]      |  |   [Move to Later]      |
| Writing: 2 of 4 ready  |  |  [Add something]       |
+------------------------+  +------------------------+
```

### C. The plan is the page; the question opens inside it

One column at every width: the plan document is the page, and the current question appears in the section it is
filling, between the items already there.

```text
320px
+------------------------+
| Your plan (7)          |
| Who uses it    sketched|
|  - Owner               |
|  +------------------+  |
|  | Q: Who else uses |  |
|  | it?              |  |
|  | [ ] My staff     |  |
|  | [Continue]       |  |
|  +------------------+  |
| What it does   ready   |
|  - Send invoice  New   |
| Its screens  not begun |
| What it keeps not begun|
+------------------------+
```

## Comparison

- **Narrow screen, answering.** A: long scroll to reach the plan. B: the question stays put and the plan is a tap
  away. C: the question moves with the stage.
- **Plan beside the question on wide screens.** Yes in all three.
- **"The plan is the page" idea.** A and B: partly. C: fully.
- **Editing the plan.** A: always on screen. B: easy once opened. C: in place.
- **Heads-ups beside their item.** A: yes. B: yes when the plan is open, with a count on the control. C: yes.
- **Focus and announcements.** A: unchanged. B: new focus into and out of the panel. C: focus follows a moving
  question.
- **Risk.** A: the plan is ignored on phones. B: the plan is forgotten behind the control. C: the page jumps and is
  hard to read on a phone.

## What each costs to build

All three reuse the server's interview, stages, and plan items as they are. The new server work in #49 (edit, remove,
move to Later, "Add something", reopen an answer) is the same for every layout and is not counted below.

- **A.** Smallest. Add the count to the plan heading and the editing controls. Roughly a CSS change plus the
  editing work. Tests: the existing `InterviewStep.test.tsx` stays valid.
- **B.** A and a toggle that holds open/closed state, plus keeping the live region announcing changes while the plan
  is closed (the count change must be heard). A `details` is the cheap build and keeps keyboard behavior for free; a
  dialog adds focus trapping and return. One new test per state (closed shows the count, open shows the sections).
- **C.** Most. `QuestionForm` moves into `Plan`; the question's section comes from the current stage
  (`STAGES` in `server/src/services/interview.ts` maps stages to sections, and `day_one` and the business stage
  touch more than one). Scroll and focus management as the question moves, a new empty-section design, and a
  rewrite of most of the interview tests. It is the largest of the three.

## Recommendation

Build **B**. It is the layout #49 describes for narrow screens, it is a small step from what exists, and it keeps the
question as the main surface, which the issue asks for ("question comes first"). A `details` panel gets keyboard
behavior and no focus trap. Keep A's wide layout unchanged.

Start with the cheap panel, then watch whether people open it. If they do not, that argues for C later, and B's
editing controls carry over.

## Open questions for the owner

1. Is B's panel allowed to hide the plan entirely on phones, or must some of it always show (for example the four
   section names with ready states, as in the sketch)?
2. Does "Move to Later" belong in the plan only, or also as a question kind ("sort into day one or later")? The
   server already has a phase on each item.
3. Where does "Write it myself" sit once the plan is editable? Today it is in the action row under the layout.
