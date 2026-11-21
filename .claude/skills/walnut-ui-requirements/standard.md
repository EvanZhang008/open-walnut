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
3. **Only tokens.** Colours, radii, font sizes and spacing come from `web/src/styles/globals.css`
   `:root` (and `styles/overlay-glass.css` for glass). No raw hex colour, no pixel radius or font
   size that is not a token.
4. **4 px grid.** Padding, gaps and sizes are multiples of 4 px (2 px only inside a control).
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
| Option / action | `.ask-card-answer .btn` | every option and action (Acknowledge, Close, Reopen, choices) | grey rounded: `--bg-secondary`, no border, corner 8 px, height 28 px, padding 4 px 14 px, 13 px weight 400; hover mixes 12% `--fg` into the fill; disabled at 0.5 opacity |
| Main action | the same, marked `data-primary` / `data-recommended` | the one main action of a card (at most one) | the same grey button at weight 600 (a recommended option keeps its grey "Recommended" word); never the filled blue `.btn-primary` inside a card |
| Tool | `.ask-card-tools .btn` | Snooze, pin, paging arrows, Quote, Close tools | transparent, no border, `--fg-muted`, corner 8 px, height 28 px, padding 0 6 px, 13 px; hover `--bg-hover` and `--fg`; Snooze has a 15 px clock icon and no "▾"; an on pin turns `--accent` |
| Send | inside the answer box | send a reply | 28 px circle, `var(--chat-hue-accent, var(--accent))`, white arrow; grey while the box is empty |

Order in every card: the buttons first, then the answer box, with the tools on the box's row at
its right. A card with no buttons is the box and its tools.

Outside cards (pages, settings, dialogs) a button is `.btn` with `.btn-sm` for small and
`.btn-primary` for the page's one main action, from `globals.css`; never a new `*-btn` class with
its own fill and corner. `.btn-ghost` and `.btn-icon` are used in 12 places but have no CSS yet:
the first change that touches them gives them the tool look above.

Source: the button set task 971551ee settled on 2026-11-21 for the cards, from the button in the
user's own Needs you card screenshot that he named ("I like P1 button"). It goes live once he
has seen the before and after.

## Inputs

- In a card, the answer box is the chat input in the answer row: `--bg-secondary`, corner 10 px,
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
| Fill | `--bg`, `--bg-secondary`, `--bg-tertiary`, `--bg-elevated`, `--bg-hover` |
| Text | `--fg`, `--fg-secondary`, `--fg-muted` |
| Accent | `--accent`, `--accent-hover`, `--accent-subtle`, `--accent-text` |
| Lines | `--border`, `--border-strong` |
| State | `--success`, `--warning`, `--error` |
| Corners | `--radius-sm` 8 px (controls), `--radius-md` 12 px (inputs), `--radius-lg` 16 px (cards) |
| Depth | `--card-shadow`, `--card-shadow-hover`; glass: `--glass-frost-*`, `--glass-legible-*` |

Font sizes: 13 px body and controls, 12 px secondary text, 11 px labels and badges, 15 px card
titles. There is no font-size or spacing token yet; until there is, use only these values.

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

A change that touches one of these moves it onto the family; the ratchet then asks for its count to
be lowered (`UI_STANDARD_RECORD=1` on that test).
