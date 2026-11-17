---
name: mobile-first
description: Styles a Schmeide app so every screen works on a phone, with a starter stylesheet and exact sizes. Use before writing or changing any screen under frontend/.
---

# Mobile first

Most people open the app on a phone, standing up, with one thumb. Design every screen for a 360px-wide phone, make
sure it holds at 320px, then let it use the room on wider screens. The stack is plain CSS; add no CSS framework or
component library.

## 1. Start from the shared stylesheet

Look for a stylesheet that `frontend/src/main.tsx` imports.

- **There is none:** copy [`base.css`](base.css) from this skill's folder to `frontend/src/app.css` and add
  `import "./app.css";` to `frontend/src/main.tsx`. Read it once: it styles plain elements (`main`, `nav`, `form`,
  `label`, `input`, `button`, `table`, `dl`) and a few classes (`.stack`, `.row`, `.card`, `.list`, `.button`,
  `.button-primary`, `.button-danger`, `.table-scroll`, `.empty`, `.muted`).
- **There is one:** use its tokens and classes. Add what is missing to it.

Done when `main.tsx` imports one shared stylesheet with tokens on `:root` for color, spacing, radius and type, each
color with a dark value under `prefers-color-scheme: dark`.

Style that belongs to one component goes in a CSS module beside it (`Invoices.module.css`) and uses the same tokens.
If the customer named a brand color, set `--accent` to it and keep 4.5:1 contrast against `--accent-text`.

## 2. Build each screen to these sizes

| What                            | Value                                                                           |
| ------------------------------- | ------------------------------------------------------------------------------- |
| Design width                    | 360px first, holds at 320px                                                     |
| Wider screens                   | `@media (min-width: …)` only; no `max-width` queries                            |
| Body text                       | 16px (`1rem`) or more; nothing under 14px                                       |
| Text in `input`, `select`, etc. | 16px or more, so iOS does not zoom on focus                                     |
| Tap targets                     | at least 44 by 44px, 8px apart                                                  |
| Page margin                     | 16px each side, plus `env(safe-area-inset-*)`                                   |
| Fixed widths                    | none over 320px; use `max-width`, `min(<width>, 100%)` or `minmax(min(…), 1fr)` |
| Full height                     | `100dvh`, never `100vh`                                                         |
| Reading width                   | content capped near 720px and centered                                          |

The page itself never scrolls sideways.

## 3. Use the pattern that fits

- **Page:** one `<main>` with one `<h1>` that names the screen. One primary action per screen.
- **Menu:** one `<nav>` before `<main>`, at most five items, the current one marked `aria-current="page"`. It sits at
  the bottom of a phone and the top of a wide screen. With more than five places, the fifth item is "More" and opens
  the rest.
- **List of records:** `<ul class="list">` of cards. Each card leads with the name a person would look for, then one
  or two facts, and the whole card opens the record.
- **Table:** only for numbers people compare across rows. Wrap it in `<div class="table-scroll">`. A table of more
  than four columns becomes a `.list` of cards with the detail on the record's own screen.
- **One record:** a `<dl>` of label and value pairs in a `.card`, with its actions below.
- **Form:** one column, the label above its field, the submit button last. Give every field its `type`
  (`email`, `tel`, `number`, `date`), `inputmode` for numbers (`decimal`, `numeric`) and `autocomplete`. Say what went
  wrong beside the field in a `role="alert"` and keep what the person typed.
- **Going back:** every screen reached from a list has a visible way back at the top.
- **Destructive action:** `.button-danger`, away from the primary action, and it asks before it deletes.

## 4. Give every screen its states

Each list and form shows something for all four:

- **Loading:** `<p role="status">Loading…</p>` where the content will be.
- **Empty:** a `.empty` block that says what will appear here and offers the action that adds the first one.
- **Error:** a `role="alert"` that says what failed and what to do next, in plain words.
- **Saving:** the button disabled with a label that says so ("Saving…").

## 5. Check before you finish

Walk every screen in `frontend/src/` against this list. You have no browser, so read the markup and the CSS that
applies to it at 360px wide.

- [ ] Every screen is inside the page frame and uses the shared tokens; no raw color or pixel literal in a component.
- [ ] No element has a fixed `width` or `min-width` over 320px outside a `min-width` media query.
- [ ] Every row of items wraps (`flex-wrap: wrap` or a grid) or scrolls inside its own container.
- [ ] Every button, link in a list, and menu item is at least 44px tall.
- [ ] Every form control has a visible label, a `type`, and text at 16px or more.
- [ ] Every list and form has its loading, empty, error and saving states.
- [ ] Long text (names, emails, addresses) wraps or is cut with an ellipsis and never widens the page.
- [ ] `frontend/index.html` keeps `<meta name="viewport" content="width=device-width, initial-scale=1.0" />`.

Done when every box is true for every screen. Schmeide checks the built app for a stylesheet, the viewport tag and
fixed widths after you finish, and sends failures back to you.

## With the design skills

The design skills load beside this one. After this skill, use `schmeide:better-layout` for grouping and spacing,
`schmeide:better-typography` for text, `schmeide:better-colors` when changing the palette, `schmeide:better-writing`
for labels and messages, and `schmeide:better-accessibility` for the last pass. Where one disagrees with a size in the
table above, the table wins.
