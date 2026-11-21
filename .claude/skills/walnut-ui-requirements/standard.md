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

Outside cards (pages, settings, dialogs, rows, toolbars) every button is the family in
`web/src/styles/buttons.css`, the one file that draws `.btn`: a key plus at most one variant and
one size. Never a new `*-btn` class with its own fill, corner, height or font; a class of your own
beside `btn` carries only layout (margin, flex, width).

| Class | Use | Look |
|---|---|---|
| `.btn` | any action (Save draft, Edit, Retry) | the text colour mixed into the page colour, 8 % (18 % in dark), as a solid fill (never see-through), no border, corner `--radius-sm` (8 px), min-height 34 px, padding 4 px 12 px, 13 px weight 500; hover +4 %, pressed +8 %; disabled 0.5 opacity (a disabled main action loses its blue); `aria-pressed="true"` is the on state (`--accent-subtle`, `--accent-text`) |
| `.btn-sm` | rows, toolbars, settings (`SettingsButton` is this; a settings page's header action too) | min-height 28 px, padding 2 px 10 px, 12 px |
| `.btn-primary` | the one main action of a view | `--btn-primary-fill` (the accent 86 % toward black, so white reads at 4.5:1 in both themes), `--on-accent` text, hover `--btn-primary-fill-hover` (74 %) |
| `.btn-danger` | a destructive action | `--btn-danger-text` label (the error red 70 % toward the text colour, 4.5:1 on the grey key) on the plain key; with `.btn-primary` the solid red confirm (Yes, delete, `--btn-danger-fill`) |
| `.btn-ghost` | a quiet tool: Cancel beside a main action, Snooze, a row's tools | no fill until hover, `--fg-secondary` (never `--fg-muted`: a quiet key still reads at a glance); with `.btn-danger` a red label |
| `.btn-icon` | an icon alone | the quiet tool, square: 28 px (24 px with `.btn-sm`), its svg 16 px (14 px) |
| `.btn-link` | an action inside text or at a row's end | `--accent-text`, no box, underline on hover |
| `.btn-block` | a key that takes the whole line | full width, label centred; `.btn-block.btn-ghost` is a menu or list row, label at the left |

Slots inside a key: `.btn-value` (a bold value) and `.btn-caret` (▾, turns over when
`aria-expanded`) make a compound trigger such as "Cost $2,077 ▾"; `.btn-reserve` with `data-r1` and
`data-r2` keeps a key's width when its label flips (Refresh / Refreshing...). Copy is always
`components/common/CopyButton.tsx`. Pills are not buttons: no `999px` corner on a key.

Source: the whole-card design the user picked on 2026-11-21 from ten drawn on his own data ("2 is
good": the options as a list of rows), after "Ack button should be blue, or recommended option
should be blue also" and "I like P1 button" (the quiet grey keys and "Snooze ▾" of his Needs you
card). `tests/e2e/browser/ask-card-family.ts` measures it on the page: `ask-card-words-shown.spec.ts`
runs it on every kind of ask (a new kind fails `ask-card-words-guard.test.ts` until that spec plays
it), and the strip and To read specs run it on theirs.

### Jump to the latest

A button that takes a scrolled view back to its end (a session's timeline, a letter's thread, any
list that offers it) is `ScrollToBottomButton` (`web/src/components/common/ScrollToBottomButton.tsx`,
styled only by `web/src/styles/scroll-jump.css`): a 36 px circle (44 px on a phone) of the shared
frosted glass (`wn-glass-frost`), a down arrow centred in it and no words, horizontally centred in its
scroller and resting 8 px above the scroller's bottom edge, shown only while the view is away from
its end. A count of rows that arrived below is a small `--accent` badge on its corner. Source: the
user, 2026-11-22, of the old grey ellipse at the lower right: "need to be round and in middle, and
glass". `tests/web/scroll-jump-button-guard.test.ts` fails on a jump button drawn on its own.

## Inputs

Every box a person types a message in is ONE input box (2026-11-21, the user on a Threads reply
box: "it's oval ... why does everything have to be round? Everything should be unified! Can there
be one unified input box?"). Its look lives in one file, `web/src/styles/input-box.css`:

| Part | Look |
|---|---|
| Box | class `wn-input`; corner `--input-radius` (8 px, the buttons' corner); `--bg-secondary` fill, a transparent 1 px edge that turns `--border-strong` on focus, no shadow, no ring |
| One line (`is-line`) | 34 px tall with its edges, a button's height; 46 px on a phone (a 44 px key and the two edges); it grows with the text |
| Mic, attach | 28 px rounded squares (corner 6 px), transparent, `--fg-muted`; `--bg-hover` on hover |
| Send (`wn-input-send`) | the same 28 px rounded square, solid blue (`--chat-hue-accent`, blue even inside a chat), white arrow (`ICON_SEND`); grey while there is nothing to send |
| Phone keys | 44 px to tap, drawn 36 px, 4 px clear of the box's edge |
| Drag a picture over | an accent edge and a 2 px dashed accent outline, the same on every box |
| Unread | a session whose new reply is not read yet: one red edge, a faint red fill, and the placeholder says "New reply above, not read yet"; never a second red ring |

- The component is `ChatInput` (with `ReplyComposer` for an ask, a thread or a letter) or
  `AnswerBox` for an answer whose words the owner keeps; both draw the box above. A new composer
  uses one of them; one that cannot carries `wn-input` and `wn-input-send` on its own box and key.
- Only a composer that floats over scrolling chat (the session and Home composers) keeps its glass
  fill and shadow (`globals.css`); its corner, edge and keys are the box's.
- No other file gives an input box, its keys or the mic inside it a corner, fill, edge, outline,
  size or opacity: `tests/web/ui-standard-ratchet.test.ts` (`restyledInput`) fails on a new one.
  It reads CSS only, so never style a box inline (`style={{ borderRadius }}`) either.
- A key rule names only the box's own keys (its controls row, its tools, a key straight in it),
  never every `.mic-btn` inside the box: a band the box holds (a session note's heading) keeps its
  own small mic.
- Text grows with `fitRows` (`web/src/components/common/fit-rows.ts`), which reads the box's own
  padding; never a fixed `rows * 20 + 12`.
- The quick bar (`web/src/components/quickbar/`) is a launcher panel, not a box in a page: its
  panel keeps the dialog corner and its 34 px row; only its mic takes the key's shape (a rounded
  square, `--radius-sm`).
- A plain field (a settings value, a label in a dialog, a search) takes the global
  `input, textarea, select` rules in `globals.css`; never its own border, radius or fill.

## Cards

- Anything that waits on the user is an `AskCardFrame` card (frosted glass, one decision per page:
  `needs-card-unified-ratchet.test.ts`).
- A notice is a `NoticeCard` (`wn-glass-frost`).
- Cards in one list share one corner radius and one padding. Today they differ (thread card 8 px
  solid, side comment card 12 px, notice 14 px, ask card 18 px); a change that touches one of them
  moves it to the ask card's look, never to a new one.

## Toasts

A toast (a notice that pops up and goes by itself) is allowed for only three reasons, and every
call names its reason in `toastReason` (`ToastReason` in `web/src/contexts/notifications/types.ts`;
the thread panel's, the board's and the content actions' toasts take the same field):

1. `failure`: something the person asked for did not happen, or only in part (a write refused, a
   key that did nothing). Error severity stays at least 15 s.
2. `out-of-sight`: news from where the person is not looking: background work that finished or
   waits on them (an ask, a reminder, a download), a change the app made on its own (a sort mode
   switched to Manual by a drag), or their own result landing out of view (a task saved where the
   filters hide it).
3. `undo-of-hidden`: the Undo of a change that takes its object out of sight: delete, complete,
   archive, remove, unpin, snooze, unschedule, clear the filters, hide a bar, a board card sent to another
   lane from a menu or the keys.

Never a toast for a create, move, resize, schedule, pin, tier change, reorder, sort, copy,
reopen or rename the person just made and can see where they made it, nor an "Undone" after an
Undo (what came back is on screen). Its Undo stays on mod+z: push it on the undo stack with
`result: 'visible'` (`web/src/undo/TaskUndoContext.tsx`), which shows no toast. A failure never
has the success severity. All toasts render as the one `NoticeCard` stack; no
view draws a toast of its own (the Sort view's inverted pill was removed). Ratchet:
`tests/web/toast-reason-ratchet.test.ts` lists every allowed non-failure toast by name.

## The chat transcript

- **One reading column.** A session's timeline is `--chat-column` (496 px, about 75 characters of
  English at 14 px) wide, centred in a wide panel, with the composer under it at the same width; a
  narrower panel keeps its gutter. Prose, every step and message row, code, tables and the person's
  bubbles stay inside it; a long code line scrolls in its block (`styles/chat-reading.css`).
- **Chat text is 14 px**, headings 15 px (h1 700, h2 600) and 14 px bold below that; paragraphs and
  lists 8 px apart, list items 4 px.
- **A row is one line or two** (the user, 2026-11-11); a message card or a thought row whose
  words are cut shows its chevron at rest (`components/sessions/cut-cue.ts`), a row that shows all of them only on hover. The
  turn's "Worked for" line is 13 px secondary grey with a 16 px chevron in `--fg` and a hover fill,
  no box and no rule.
- **One condition is one notice.** When the panel shows a notice with its action (the folder-gone
  notice), a row that failed for the same reason says so in a line and does not repeat the action.
- **Nothing starts under a header.** The history's scroll stops clear the glass header; where its
  top is a hard edge (a notice, a split's Chat bar, a strip in flow), a jump stops 12 px below it.
  A history that needs room on its left (the question map, a thread page's sliver) names it in
  `--history-left`; the centred column never comes closer.

Source: the UI audit of the user's own chats, 2026-11-21 (lines of 120 characters, a turn line
that "reads like a grey footnote", notices cut with no way in, the VP chat's folder-gone notice
twice). `tests/e2e/browser/chat-reading.spec.ts` measures the column, the scale, the turn line, the
one notice and the split's first row; `step-row-lines.spec.ts` checks the cut-row cue on every row
kind.

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

- 3 rules restyle `.btn` outside the family's two homes (`styles/buttons.css`, and the card
  family in `components/actions/ask-card.css`), for example `styles/answer-box.css` (the send
  circle) and `styles/inline-answer.css`.
- 100 rules in 45 files give a `*-btn`, `*-button`, `*-pill` or `*-chip` class its own fill and
  corner instead of a `.btn` variant.
- 1261 `<button>` elements in 447 TSX files carry no `btn` class (choice controls with role tab,
  radio, switch, checkbox or option aside). A new file starts at 0.
- 21 raw `#007aff` / `#0a84ff` in 9 files where `var(--accent)` belongs.
- Values written where a token belongs (per declaration, `tests/web/ui-token-scan.ts`):
  `rawColour`, `radiusNotToken`, `pillRadius` (87: the pill-shaped controls and labels),
  `fontSizeOffScale`, `shadowLiteral`, `zIndexLiteral`, `spacingOffGrid`. Their counts per file are
  in the same baseline; a new file starts at 0.
- 8 rules in 2 files style an input box outside `input-box.css`: the floating composers' glass
  fill and shadow, their focus edge and the phone's 44 px send target (all on purpose; a new one
  fails). The unread composer's red edge is a state of the box, in `input-box.css`.

A change that touches one of these moves it onto the family; the ratchet then asks for its count to
be lowered (`UI_STANDARD_RECORD=1` on that test).
