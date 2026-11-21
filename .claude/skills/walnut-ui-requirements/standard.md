# Walnut UI standard: one look per kind of control

Walnut's web UI looks consistent and modern only when every control of one kind is the same
component with the same style. This file names that one style per kind, and the tokens it is
built from. A new view reuses these; it never brings its own. The ratchet
`tests/web/ui-standard-ratchet.test.ts` counts the exceptions that exist today, and those counts
only go down.

Why (2026-11-21, the user, on one screen with a question card and a result card): "why the ui
still not consistent ... why they are not even consistent come on". The question card's options
were grey rounded buttons; the result card had a filled blue Acknowledge, an outlined Snooze and an
outlined pin. Both used the same `.btn` class, but each card restyled it in its own CSS.

## Rules

1. **One component per kind.** Buttons are `.btn` with one of the variants below; an answer box is
   `AnswerBox` (or the chat input it wraps); a card is `AskCardFrame` (for anything that asks the
   user) or `NoticeCard` (notices); a status is `NoticeStatus` (dot and word) or `.badge`.
2. **Never restyle a shared control inside a scope.** `.my-card .btn { background: ... }` is a
   second style. Need a new look? Add a variant to the shared component, for every view.
3. **Only tokens.** Colours, radii, font sizes, shadows and layers come from `web/src/styles/globals.css`
   `:root` (and `styles/overlay-glass.css` for glass, `styles/overlay-family.css` for overlays). No
   raw colour, no pixel radius, font size, blurred shadow or z-index number that is not a token, and
   no `var(--x)` of a property nothing defines (`tests/web/css-undefined-vars-ratchet.test.ts`).
4. **2 px grid.** Padding, margins and gaps are even pixel values: 2, 4, 6, 8, 10, 12, 16, 20, 24,
   32. Between blocks (page and card padding, gaps between cards and sections) use multiples of 4;
   2, 6 and 10 are for inside a control or a dense row. Odd values never (1 px only to offset a
   border). Why not 4 px only: on 2026-11-21 the code used 6 px 1,565 times and 10 px 913 times,
   more than 12, 14 and 16 px together, and half of all spacing broke a 4 px rule, so that rule
   guided nothing; the odd values (5, 3, 7, 9 px) are the real drift, and the ratchet counts them.
5. **Calm and modern.** Soft corners, the shared frosted glass for cards and notices, no solid
   highlight blocks, at most one main action per card, the rest quiet.
6. **Match the neighbours.** Before you add a view, open the views beside it; the same kind of
   thing looks the same in both.

## The button family

Every button is `<button className="btn ...">`. Inside a card there is ONE home for its look: the
card's answer row and tool row in `web/src/components/actions/ask-card.css`, used by every card
(question cards, result cards, paged cards, Threads cards). No other file restyles `.btn`.

| Role | Where | Use | Look |
|---|---|---|---|
| Option | `.ask-card-answer .org-answer-options .btn` (`AskOptions`) | each choice of a question, a letter's actions, a Board choice | a row of its own, full width: `--bg` fill, 1 px `--border` hairline, corner 8 px, height 34 px, padding 4 px 12 px, 13 px weight 500 label, then its line of why (`data-detail`) in 12 px `--fg-muted`, cut to the row; a multi choice's ticks are the same rows (`.org-answer-check`), edged in `--accent` when ticked |
| Main action | `.ask-card-answer .btn.btn-primary` | the one main action of a card, at most one: Acknowledge, or the recommended option | solid blue: `--accent` fill, white text, the same size as its neighbours; a recommended option row keeps its "Recommended" word at the right |
| Action | `.ask-card-answer .btn` | any other button on the card (Close, Reopen, Retry) | grey: `--bg-secondary`, no border, corner 8 px, height 34 px, padding 4 px 12 px, 13 px weight 500; hover mixes 8% `--fg` into the fill; disabled at 0.5 opacity |
| Tool | `.ask-card-tools .btn` | Snooze, pin, paging arrows | transparent, no border, `--fg-muted`, corner 8 px, height 28 px, padding 0 6 px, 13 px; hover `--bg-hover` and `--fg`; Snooze reads "Snooze ▾"; an on pin turns `--accent` |
| Send | inside the answer box | send a reply | 28 px circle, `var(--chat-hue-accent, var(--accent))`, white arrow; grey while the box is empty |

Order in every card: the options or buttons first, then the answer box (34 px, corner 8 px,
`--bg-secondary`), with the tools on the box's line at its right; where the card is narrow (a
Home row, a phone) the box takes the whole line and the tools the line under it, at the right. A
card with no buttons is the box and its tools. Lines in the answer row are 8 px apart.

Outside cards (pages, settings, dialogs) a button is `.btn` with `.btn-sm` for small and
`.btn-primary` for the page's one main action, from `globals.css`; never a new `*-btn` class with
its own fill and corner. `.btn-ghost` and `.btn-icon` are used in 12 places but have no CSS yet:
the first change that touches them gives them the tool look above.

Source: the whole-card design the user picked on 2026-11-21 from ten drawn on his own data ("2 is
good": the options as a list of rows), after "Ack button should be blue, or recommended option
should be blue also" and "I like P1 button" (the quiet grey keys and "Snooze ▾" of his Needs you
card). `tests/e2e/browser/ask-card-family.ts` measures it on the page: `ask-card-words-shown.spec.ts`
runs it on every kind of ask (a new kind fails `ask-card-words-guard.test.ts` until that spec plays
it), and the strip and To read specs run it on theirs.

## Inputs

- In a card, the answer box is the chat input in the answer row: `--bg-secondary`, corner 8 px,
  no border until focus (then `--border-strong`), no shadow (`ask-card.css`).
- Elsewhere a reply or answer box is `AnswerBox` (`components/common/AnswerBox.tsx`): corner `--radius-md`
  (12 px), `--bg-secondary`, 1 px `--border`, accent border on focus, 13 px text, a round send
  button. `answer-box-guard.test.ts` already keeps new boxes on it.
- A plain field takes the global `input, textarea, select` rules in `globals.css`; never its own
  border, radius or fill.

## Cards

- Anything that waits on the user is an `AskCardFrame` card (frosted glass, one decision per page:
  `needs-card-unified-ratchet.test.ts`).
- A notice is a `NoticeCard` (`wn-glass-frost`).
- Cards in one list share one corner radius and one padding. Today they differ (thread card 8 px
  solid, side comment card 12 px, notice 14 px, ask card 18 px); a change that touches one of them
  moves it to the ask card's look, never to a new one.

## Status labels

- A state is a dot and a word (`NoticeStatus`), or a `.badge` for a count or a tag. Never a new
  `*-badge`, `*-pill` or `*-chip` class with its own colours.

## Tokens (from `globals.css` `:root`)

| Kind | Tokens |
|---|---|
| Fill | `--bg`, `--bg-secondary`, `--bg-tertiary`, `--bg-elevated`, `--bg-hover`, `--card-bg` |
| Text | `--fg`, `--fg-secondary`, `--fg-muted`; on a solid accent, success or error fill `--on-accent` |
| Accent | `--accent`, `--accent-hover`, `--accent-subtle`, `--accent-text` |
| Lines | `--border`, `--border-strong` |
| State | `--success`, `--warning`, `--error`; their 10% fills `--success-subtle`, `--warning-subtle`, `--error-subtle` |
| Corners | `--radius-xs` 4 px (badges, kbd, checks), `--radius-sm` 8 px (controls), `--radius-md` 12 px (inputs, cards), `--radius-lg` 16 px (large cards) |
| Type | `--font-size-xs` 11 px (labels, badges), `--font-size-sm` 12 px (secondary text), `--font-size-md` 13 px (body, controls), `--font-size-lg` 15 px (card titles), `--font-size-xl` 17 px (section and dialog headings), `--font-size-2xl` 20 px (page titles); families `--font-sans`, `--font-mono` |
| Depth | on a surface: `--shadow-sm` (a raised chip), `--shadow-md` (a hovered card), `--card-shadow`, `--card-shadow-hover`; floating: the overlay family's `--overlay-shadow`, `--dialog-shadow`; glass: `--glass-frost-*`, `--glass-legible-*` |
| Layers | the overlay family's `--z-*` (`styles/overlay-family.css`) and its scrim `--overlay-scrim` |

Nothing sits between two sizes of the scale: a 12.5 px or 14 px label is a decision for the
scale, not for one view. A token written with a fallback (`var(--fg, #1d1d1f)`) is a second
colour for the dark theme; write `var(--fg)`.

## What exists today that breaks this (the ratchet counts them)

Counted on 2026-11-21 by `tests/web/ui-standard-ratchet.test.ts` (per file, in
`tests/web/ui-standard-baseline.json`):

- 27 rules in 9 files restyle `.btn` outside the card family's home, for example
  `styles/org-rail.css` (`.org-ask-tool`, which belongs to the tool role), `styles/globals.css`,
  `styles/routines-groups.css`, `styles/inline-answer.css`.
- 237 rules in 80 files give a `*-btn`, `*-button`, `*-pill` or `*-chip` class its own fill and
  corner instead of a `.btn` variant.
- 102 raw `#007aff` / `#0a84ff` in 26 files where `var(--accent)` belongs.
- `.btn-sm` and `.btn-danger` are each declared twice with different values in `globals.css`.
- Values written where a token belongs (per declaration, `tests/web/ui-token-scan.ts`):
  `rawColour`, `radiusNotToken`, `pillRadius` (96: the pill-shaped controls and labels),
  `fontSizeOffScale`, `shadowLiteral`, `zIndexLiteral`, `spacingOffGrid`. Their counts per file are
  in the same baseline; a new file starts at 0.

A change that touches one of these moves it onto the family; the ratchet then asks for its count to
be lowered (`UI_STANDARD_RECORD=1` on that test).
