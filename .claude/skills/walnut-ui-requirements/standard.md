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
| Option | `.ask-card-answer .org-answer-options .btn` (`AskOptions`) | each choice of a question, a letter's actions, a Board choice | a row of its own, full width: `--bg` fill, 1 px `--border` hairline, corner 8 px (a row, not a key: standard "Shapes"), height 34 px, padding 4 px 12 px, 13 px weight 500 label, then its line of why (`data-detail`) in 12 px `--fg-muted`, cut to the row; a multi choice's ticks are the same rows (`.org-answer-check`), edged in `--accent` when ticked |
| Main action | `.ask-card-answer .btn.btn-primary` | the one main action of a card, at most one: Acknowledge, or the recommended option | solid blue: `--accent` fill, white text, the same size as its neighbours; a recommended option row keeps its "Recommended" word at the right |
| Action | `.ask-card-answer .btn` | any other button on the card (Close, Reopen, Retry) | grey: `--bg-secondary`, no border, round (`--radius-full`), height 34 px, padding 4 px 12 px, 13 px weight 500; hover mixes 8% `--fg` into the fill; disabled at 0.5 opacity |
| Tool | `.ask-card-tools .btn` | Snooze, pin, paging arrows | transparent, no border, `--fg-muted`, round (`--radius-full`), height 28 px, padding 0 6 px, 13 px; hover `--bg-hover` and `--fg`; Snooze reads "Snooze ▾"; an on pin turns `--accent` |
| Send | inside the answer box | send a reply | 28 px circle, `var(--chat-hue-accent, var(--accent))`, white arrow; grey while the box is empty |

Order in every card: the options or buttons first, then the answer box (34 px, corner 12 px,
`--bg-secondary`), with the tools on the box's line at its right; where the card is narrow (a
Home row, a phone) the box takes the whole line and the tools the line under it, at the right. A
card with no buttons is the box and its tools. Lines in the answer row are 8 px apart.

Outside cards (pages, settings, dialogs, rows, toolbars) every button is the family in
`web/src/styles/buttons.css`, the one file that draws `.btn`: a key plus at most one variant and
one size. Never a new `*-btn` class with its own fill, corner, height or font; a class of your own
beside `btn` carries only layout (margin, flex, width).

| Class | Use | Look |
|---|---|---|
| `.btn` | any action (Save draft, Edit, Retry) | the text colour mixed into the page colour, 8 % (18 % in dark), as a solid fill (never see-through), no border, round: a capsule (`--radius-full`; a row of a list, `.btn-block.btn-ghost`, keeps 8 px), min-height 34 px, padding 4 px 12 px, 13 px weight 500; hover +4 %, pressed +8 %; disabled 0.5 opacity (a disabled main action loses its blue); `aria-pressed="true"` is the on state (`--accent-subtle` with a half-accent hairline and `--accent-text` label, kept under the pointer, so even in a chat, whose accent is grey, an on key never reads as merely hovered; `data-on="true"` is the same look), and so is a menu trigger whose menu is open (`aria-haspopup` with `aria-expanded="true"`) |
| `.btn-sm` | rows, toolbars, settings (`SettingsButton` is this; a settings page's header action too) | min-height 28 px, padding 2 px 10 px, 12 px |
| `.btn-sm.btn-tight` | a small key in a row that must give up room before a control leaves it (the composer's condensed row) | the sides narrow to 4 px |
| `.btn-tight` | a key of the default size that fills a narrow line (Mail's New message in its folder column) | 6 px sides, 4 px gap: the same look wherever it has room |
| `.btn-round` | a count that opens its list, on a header's line (the Org node's "5 threads", "51 working": the user's pick, 2026-11-23) | the plain key's fill, min-height 24 px, padding 0 10 px, round as every key, 12 px `--fg-secondary` label (`--fg` on hover) |
| `.btn-primary` | the one main action of a view | `--btn-primary-fill` (the accent 86 % toward black, so white reads at 4.5:1 in both themes), `--on-accent` text, hover `--btn-primary-fill-hover` (74 %) |
| `.btn-danger` | a destructive action | `--btn-danger-text` label (the error red 70 % toward the text colour, 4.5:1 on the grey key) on the plain key; with `.btn-primary` the solid red confirm (Yes, delete, `--btn-danger-fill`) |
| `.btn-ghost` | ONLY: an icon alone (`.btn-icon`); the session header's tool keys and Home's toolbar keys (New task, Display); the composer's triggers (Bypass, btw, Note, the mode pill); a dismissal beside a main action (Cancel, Close, Keep, Back, Dismiss, Not now). Every other text action (a row's Edit, Refresh, Show all, Retry) is the plain `.btn`: a text label with no fill reads as bare text, and a row never mixes a bare-text Edit beside a grey Remove | no fill until hover, `--fg-secondary` (never `--fg-muted`: a quiet key still reads at a glance); with `.btn-danger` a red label |
| `.btn-icon` | an icon alone | the quiet tool, a circle: 28 px (24 px with `.btn-sm`), its svg 16 px (14 px) |
| `.btn-link` | an action inside text or at a row's end | `--accent-text`, no box, underline on hover |
| `.btn-block` | a key that takes the whole line | full width, label centred; `.btn-block.btn-ghost` is a menu or list row, label at the left |

Slots inside a key: `.btn-value` (a bold value) and `.btn-caret` (▾, turns over when
`aria-expanded`) make a compound trigger such as "Cost $2,077 ▾"; `.btn-reserve` with `data-r1` and
`data-r2` keeps a key's width when its label flips (Refresh / Refreshing...). Copy is always
`components/common/CopyButton.tsx`. Every key is round (standard "Shapes"); write `--radius-full`, never a `999px` of its own.

A header row (a title and buttons in one line) follows the header rule in
`components/common/HeaderFit.tsx`: as it narrows, a subtitle gives way, then the buttons' words
fold to icons (`FitButton`), then they go into one More menu (`HeaderFitMore`), and only then does
the title cut, with its full text on hover. `tests/web/header-fit-ratchet.test.ts` counts the
header rows not on it yet; `tests/e2e/browser/header-fit-sweep.spec.ts` sweeps the widths.

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

## Shapes

One shape family (2026-11-22, the user, of the 8 px corners every key had taken on: "我之前这样圆圆的多可爱！你现在把我变成什么都是方块块 ... 我想变成圆形"; and on 11-21: "所有东西都应该统一啊"):

- **Everything you press is round, and so is every short label**: a key (`.btn`, every variant),
  a chip, a segmented control and its thumb, a tab that draws a box, a rail icon (the collapsed
  rail is a column of 36 px circles), a badge, a count. Only a long label that names a time or a
  sentence (Wait until Tomorrow 10:..., a due or start date: `badge({ long: true })`, class
  `badge-long`) keeps a soft 4 px corner (the user, 11-22, of a header with "Wait until Tomorrow
  10:...", "Web 2", "Trigger", "Leader · 1": "the tag the squae like this is fine, as it is kind of
  long, but for the smaller change round please"). Round is
  `--radius-full`: a capsule, which is a circle when the thing is square (an icon key, a one-digit
  count). The input box's mic, attach and send keys were already circles.
- **What you type in or read stays a soft rectangle**: the message box (20 px), a one-line box and
  a field, a card (16 px), a menu or popover (12 px), a dialog (16 px), a row of a list (8 px,
  the ask card's option rows and a `.btn-block.btn-ghost` included), a code block, a thumbnail. A
  row is not a key even when it is a button: it keeps its container's corner.
- Never a corner between the two (6 px, 10 px, 4 px) on a key: there are two shapes, not a scale.
- `tests/web/ui-standard-ratchet.test.ts` counts `squareKey` (`isSquareKey` in
  `tests/web/ui-standard-scan.ts`): a rule whose element is a key (a class on a `<button>`, on a
  `role="button"` or `"tab"` element, beside `btn`, or named `-btn`, `-button`, `-pill`, `-chip`,
  `-toggle`, `-tab`, `-badge`, `-tag`, `-count`) and whose corner is short of round. Rows, cards,
  rails, bars and menus are told by their names (`-row`, `-card`, `-item`, ...), except that a
  `-menu` class on a pressable is the key that opens the menu (`.todo-section-tabs-menu`, 2026-11-24);
  a row whose class
  is named like a key (`.org-channel`, `.todo-row-pill`) says so on its corner:
  `border-radius: var(--radius-sm); /* shape: <why> */`, and so does a row's or card's focus ring.
  A label's own class may take `--label-radius` (the badge's corner); a key may not. `roundRow`
  fails on a row drawn round (`--radius-full` with its text at the left across the line or in a
  column). Both counts are 0 in every file; a new one fails.

## Inputs

Every box a person types a message in is ONE input box (2026-11-21, the user on a Threads reply
box: "it's oval ... why does everything have to be round? Everything should be unified! Can there
be one unified input box?"). Its look lives in one file, `web/src/styles/input-box.css`:

| Part | Look |
|---|---|
| Box | class `wn-input`; corner `--input-radius`: 20 px (the round card the user had), 12 px for a one-line box (`is-line`), never a pill; `--input-fill` (the fields' fill, below), a transparent 1 px edge that turns `--input-focus-edge` (`--border-strong`) on focus, no shadow, no ring |
| One line (`is-line`) | 34 px tall with its edges, a button's height; 46 px on a phone (a 44 px key and the two edges); it grows with the text |
| Mic, attach | 28 px circles, transparent, `--fg-muted`; `--bg-hover` on hover |
| Send (`wn-input-send`) | the same 28 px circle, solid blue (`--chat-hue-accent`, blue even inside a chat), white arrow (`ICON_SEND`); grey while there is nothing to send |
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
  panel keeps the dialog corner and its 34 px row; only its mic takes the key's shape (a circle).

### Fields

Every other field (a search, a name, a number, a select) looks like the message box (2026-11-21
UI audit: the Home, Display menu, Mail, Apps, Memory and Settings searches, "Your name", Rhythm's
goal and minutes and Build a plugin's "Describe it" were nine looks: an underlined bar, a flat
bar, a tall white box, a darker bar beside an outlined one, round clear keys, a faded
placeholder). Its look is in the same file, `web/src/styles/input-box.css` ("Fields"):

| Part | Look |
|---|---|
| Field | the bare `input, textarea, select`: corner `--input-radius` (12 px), fill `--input-fill` (4% of the text colour, 10% in dark), a transparent 1 px edge that turns `--input-focus-edge` (a grey) on focus, and nothing more: no ring, no glow, no accent edge (below) |
| Height | as tall as the buttons beside it: 34 px (`.btn`), or 28 px with `is-sm` beside `.btn-sm` (a toolbar, Settings, a plugin's small row, a lane or name rename); every one-line field 46 px on a phone (`.app-shell-navigation` or a portalled `.is-phone-layer`). Give a small field `is-sm`, never a height, and no vertical padding of its own. A text area's `min-height` is how many lines it starts with, not a look |
| Placeholder | `--input-placeholder` (`--fg-notice`, 4.6:1 on the fill over white), never faded with opacity |
| Error | one red edge (`aria-invalid="true"`), on every field |
| A field with parts | `wn-field` on the box: an icon first (`wn-field-icon`), then the words, then a busy ring, a count, a unit (`wn-field-unit`) and its keys |
| Keys (clear, mic) | the message box's circles (`wn-field-key`, 28 px, 22 px in `is-sm`) |
| Pick-one and suggestions | a `select` and an `input[list]` draw one chevron |

- A search is `SearchField` (`web/src/components/common/SearchField.tsx`): the magnifier, the
  words, a busy ring, the clear key and the mic. Never build a search bar of your own.
- Show a hit count once: where a row below already shows it (Home's section row), the field does
  not.
- A shortcut goes in the field's tooltip, not its placeholder ("Search tasks", not
  "Search tasks... Cmd K"): the words need the room.
- A unit belongs inside its field ("min" in Rhythm's minutes), not beside it.
- The fill is the text colour over whatever is under the field (`color-mix` with `transparent`), so
  one field shows on a white card, the grey Apps page and a dark card alike; never give a field a
  fill of its own for one surface. On a coloured banner, where a tint cannot be read (the Apps
  page's "Describe an app"), put `wn-on-color` on the field: it sits on the page's colour.
- An inline rename (a session, lane, note or tier name) is the same field, kept to its text's line
  (its own small padding), never an accent box of its own.
- What stays different, on purpose (each one is the only entry left in the `restyledField`
  baseline for its file): a title typed in place, drawn as the heading it edits (Passwords' item
  title, a calendar event's title); a calendar time read as words in its "when" sentence that is a
  field only while edited; the media bar's speed pick-one, drawn as the toolbar keys beside it;
  the mail folder filter, which stands in for a folder row (32 px, its words in the folder column);
  the sign-in page's pairing code (52 px for its 22 px digits); the session folder picker's
  path mode (an accent edge: the words are a path, not a search); the idle-compact share out of
  range (a `--warning` edge: a warning, not an error); text typed onto a drawing (the
  paper's own white and ink); the quick bar's placeholders in its own window palette; and the
  side panel's docked one-line composer.
- No other file gives a field, its placeholder or its keys a fill, edge, corner, shadow, outline
  or height: `tests/web/ui-standard-ratchet.test.ts` (`restyledField`) fails on a new one. A
  rule that takes a field's look away (`border: 0` for the words inside a `wn-field`) is fine.
- A focused field, `wn-field` box or message box shows only its edge turning `--input-focus-edge`
  (`--border-strong`), on a click and from the keys alike, and its caret: no outline, ring, glow,
  or blue or accent edge, in any file (2026-11-23, the user, of a 2 px accent ring round the quick
  bar: "so gross!"; SKILL.md rule 19). Only checkboxes, radios and ranges, which have no edge to
  darken, keep a 2 px `--accent` ring for the keyboard
  (`tests/web/focus-ring-owner-guard.test.ts` fails on any other).
- An empty message box shows no hint text: the session box has none, only its `aria-label`
  ("Send a message to this session"); a placeholder only says what the user cannot see otherwise,
  in a few words ("New reply above, not read yet"; SKILL.md rule 20).

## Choice controls

A control that picks a value is one of six components (and a picked row, a nav item or an option card is one of the three states below them) from `web/src/components/controls/`
(`index.ts`), drawn by `web/src/styles/choice-controls.css`. A view only places them (margin, flex,
width); it never gives them a fill, border, corner or size of its own, and never a native
`accent-color`. The selected state is always ARIA, one hook per kind, never a per-view `.active` /
`.on` / `.is-active` class.

| Kind | Component | Use it for | Look | On state |
|---|---|---|---|---|
| Tabs | `Tabs` (items), or `TabList` + `Tab` for tabs that carry a close button | switching between the panels or pages of one view, at the top of a pane | text tabs on one line in a 32 px strip, 2 px apart, each a 26 px capsule (`--radius-full`), padding 0 10 px, 13 px weight 500 `--fg-secondary`, `--bg-hover` under the pointer; the selected one a capsule of `--accent-subtle` with `--accent-text` words (the 11-19 round tab the user asked back for); a 1 px `--border` line under the strip (`flush` drops it on a header that has its own); a count in 11 px `--fg-muted`; a vertical list (`aria-orientation="vertical"`, the model picker's engine rail) has no lines and draws the selected tab as a Nav item's current page (`--accent-subtle` fill, `--accent-text`, weight 500) | `aria-selected` on `role=tab`; arrows, Home and End move and select |
| Segmented | `SegmentedControl` (also exported as `Segmented`) | one of 2 to 6 values of a setting or a view mode, inline in a row or a toolbar | a 28 px `--choice-track` (`--bg-tertiary`) track, round (`--radius-full`), 2 px inset; segments 24 px, padding 0 12 px, round, 12 px weight 500 `--fg-secondary`; the selected one a lifted thumb (`--bg-elevated`, a white tint in dark) with a 1 px shadow and `--fg` text; `fill` makes equal segments across the line; `size="sm"` (segments padded 0 8 px) in a menu row or a popover; it never runs past its container (it shrinks and scrolls); icon segments are 28 px circles; `value={null}` picks nothing, for a setting that is not in effect yet (no vault for its length) | `aria-checked` on `role=radio` in a `role=radiogroup`; arrows move and select |
| Chip | `Chip`, several in a `ChipGroup` | a filter over a list (one or many on), or a pick among options that wrap | 24 px, round (`--radius-full`), padding 0 8 px, 12 px weight 500; off `--bg-secondary` fill and `--fg-secondary` text, hover `--bg-tertiary`; on `--accent-subtle` fill, `--accent-text` text and an accent hairline; a count in 11 px `--fg-muted` | `aria-pressed` (or `aria-checked` on a `role=radio` chip) |
| Switch | `ToggleSwitch` | an on/off setting that takes effect at once | 38 x 22 track (`size="sm"`: 28 x 16 in a menu row or a dense toolbar), off `--choice-switch-off`, on `--accent`, white round thumb; round, as every key | `aria-checked` on `role=switch` |
| Checkbox, Radio | `Checkbox`, `Radio` (`SettingsCheckbox` for a Settings list row) | picking items of a list, or a choice a form applies on Save; a radio for one of a few choices that each need a line of words | the native input drawn: 16 px, corner 4 px (half of `--radius-sm`; a radio is round), 1 px `--choice-box-border`; checked `--accent` with a white tick (a radio a 5 px accent ring); with `label` the box and words are one clickable row, 8 px apart, 13 px, an optional 12 px `--fg-muted` detail line | `:checked` (`:indeterminate` for "some") |
| Disclosure | `DisclosureButton`, or `DisclosureChevron` inside a header that is its own button | showing or hiding what is under it | a 12 px chevron in `--fg-muted` that points right when closed and turns down when open (one rotation rule), the label 13 px weight 500 `--fg-secondary`; transparent, hover `--bg-hover`, corner 8 px; `inline` takes the size of a line of small text it sits in (16 px); no other chevron component is written, a fold never swaps one icon for another | `aria-expanded` |
| Menu caret | `MenuCaret` (`components/controls`) | the mark of a key that opens a menu or a picker ("Snooze", the model pill) | a 6 px down chevron (the room the typed caret took) in `--fg-muted` in the key's `.btn-caret` slot (a site's own slot class keeps `wn-menu-caret`), turned up while the key's `aria-expanded` is true; no other caret component or hand-drawn caret is written; every key that shows words or a value and opens a picker or a menu wears it and carries `aria-haspopup` (an icon key, a fold and a row inside a menu, which ends with `DisclosureChevron`, take none: `tests/web/menu-key-mark-guard.test.ts`) | `aria-haspopup` and `aria-expanded` on the key |
| Picked row | `.wn-pick-row` on the row | the current value among the rows of a menu or a list of options (model, effort, permission mode, a music track, a lane, a view), and a menu's on/off row (Show tab bar) | the picked row's name in `--accent-text` at weight 500, every other row `--fg` at 400; no check mark (the user, 2026-11-14: "why must there be a checkmark ... just show the name, and colour the selected one", `tests/web/picker-no-checkmark-guard.test.ts`), no fill and no colour of its own (never orange: a risky value warns in its own description line), and no check shown by a stylesheet either; a name in an element with a colour of its own carries `wn-pick-name`; a fill is only the pointer's or the keyboard's (`data-active="true"`, `--bg-hover`, text keeps its colour); a row that only flips between two values (Reply style) has no chevron: it names the current value and says what a press does; a risky value's description line is `--priority-important-text`, never `--warning` (2.2:1 as small text) | `aria-checked` on `role=menuitemradio` or `menuitemcheckbox`, or `aria-selected` on `role=option`; in a browse list (`data-pick="browse"`, the Provider column) `aria-selected` is the row being browsed (the `data-active` fill) and the row holding the current value is `aria-current="true"` |
| Nav item | `.wn-nav-item` (`styles/pick-and-nav.css`) | the rail, the sidebar, a section list (Settings, the notification panel's filters) | one row in every nav list: 32 px tall, padding 0 10 px, 8 px from its icon (16 px), 13 px weight 400 `--fg-secondary`, `--bg-hover` under the pointer; a list may indent a sub-level row or draw a collapsed rail as round keys, never its own type size or padding; the page you are on: `--accent-subtle` fill, `--accent-text`, weight 500; a key that opens a pane beside the page (the task panel): a quiet `--bg-tertiary` fill and `--fg`, so the current page and an open pane never look the same | `aria-current="page"`; an open pane `aria-pressed="true"` |
| Option card | `.wn-option-card` | one of a few large side-by-side choices with a title and a line of words (New task or Quick question) | every card the same 1 px `--border` and 16 px padding, its name in `.wn-option-card-title` (`--font-size-lg`, 600) and its line in `.wn-option-card-desc`; the picked one a half-accent hairline and `--accent-subtle`; the focus ring only on `:focus-visible` | `aria-checked` (on `role=radio`) or `aria-pressed` |

Every fold mark is a `DisclosureChevron` and every menu key's caret a `MenuCaret`, never a typed
triangle or angle quote, never a chevron SVG or component a file draws for itself; a direction (back,
next, a row that goes somewhere, a sort order) is `ICON_CHEVRON_LEFT` / `ICON_CHEVRON_RIGHT` from
Icons.tsx (the user, 2026-11-23: "everything should be one"; `tests/web/disclosure-mark-guard.test.ts`).
Beside words ("Open", "2 more", "Next", a crumb before a link) the icon sits in
`<span className="wn-dir-mark" aria-hidden="true">`; a typed `‹ ›` (or `« »`) alone, or at the start
or end of a key's words or a string, fails the guard in any class, and only one inside a sentence
("Settings › Voice") is prose. The session timeline's folds wear `DisclosureChevron` too, never an
icon set's own chevron.

Tabs have one other look, `TabList tiles`: large square cards (an icon, a title and a line),
picked with the accent edge, a ring and a tint, for a choice between two kinds of the same thing at
the top of a form (the new task draft's Start task and Quick chat). Its keys and ARIA are the tabs'.

Which one: a switch acts at once, a checkbox waits for Save. Tabs change what panel shows; a
segmented control changes a value or a mode of the same content. A chip filters a list or picks
from many options that wrap; it is never a status label (that is a `.badge`). One of a few short
values inline is a segmented control; one of a few choices that each need a line of words is a
column of radios. Several of a list of items (rows, calendars) are checkboxes; several filters
over a list are chips.

Heights next to the neighbours: a 28 px segmented control or a 24 px chip sits in a toolbar beside
28 px tool buttons; in a card's 34 px answer row there is no segmented control or chip (its choices
are the option rows of "The button family").

Controls that only mean something while a master switch is on (an Inbox Triage rule under the
Inbox Triage switch) sit in a `ControlGroup` that the master names with `aria-controls`
(`masterProps(id)`). While the master is off the group is a disabled fieldset: every control in it
is disabled and drawn off (an on switch or a ticked box is `--fg-muted` grey, never accent blue),
with one line under the master saying why. A control is never shown on when what it belongs to is
off. `tests/e2e/browser/choice-controls-dependent.spec.ts` walks every Settings section and fails on
a master that is off while a control it names is not disabled.

Every button and choice control keeps a visible 2 px `--accent` focus ring for the keyboard (a text field shows only its edge, above). A page's pick of tab,
filter or mode is kept with `usePageView` (`tests/web/view-memory-guard.test.ts`).

`tests/web/choice-controls-ratchet.test.ts` finds every tab, segmented control, switch, selectable
chip, checkbox, radio and disclosure built by hand (by `role`, `input type`, and `-tab`, `-seg`,
`-switch`, `-chip`, `-toggle` class names, plus stylesheet rules that draw one and every
`accent-color`), per file (`tests/web/choice-controls-baseline.json`); the counts only go down.

Source: the 2026-11-21 audit (14 segmented controls, 14 tab bars with five active-state names,
nine switches in six sizes, 49 native checkboxes with 16 `accent-color` rules) and the user on
round controls: "什么鬼东西都要是圆形的呀？所有东西都应该统一啊".

## Cards

- Anything that waits on the user is an `AskCardFrame` card (frosted glass, one decision per page:
  `needs-card-unified-ratchet.test.ts`).
- A notice is a `NoticeCard` (`wn-glass-frost`).
- A card's text never hides what it asks: a question or why cut to its lines gets Show more /
  Show less under it, the one fold (`components/common/TextFold.tsx`); a thread card's own words are
  shown whole, never cut (`CardWords`); and a bare URL or path in it reads as a short label with the
  whole address as its tooltip (`AgentText shortLinks`, `RichMarkdown shortLinks`,
  `tests/web/markdown/short-link-labels.test.ts`, `tests/web/thread-card-words-guard.test.ts`). A card under
  460 px wide puts its box on a line of its own, with Snooze and pin under it at the right.
- Cards in one list share one corner radius and one padding: the ask card's, `--ask-card-radius`
  (`--radius-lg`, 16 px) and `--ask-card-pad` (12 px 12 px 8 px), defined in `globals.css` `:root`. The thread card, the thread
  review card, the approval card and the side question card read them; a new card in a list does too.
  (Notices keep their own frosted card, `NoticeCard`.)
- A card in the flow of a page or a list is filled with `--card-bg` (white in light, #1C1C1E in dark), never the
  page's `--bg` (black in dark: the card has no edge) nor `--bg-elevated`. `--bg-elevated` is a layer's: a card
  placed over the page (a popover, a hover card, the thread stack, a note over a document's text) or one on a
  tinted lane (a board column). Ratchet: the `cardBg` count in `tests/web/ui-standard-ratchet.test.ts`.

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

- **The chat uses the panel's width.** The timeline and the composer keep the panel's plain
  gutter; no centred column, no wide margins around the composer (the user, 2026-11-22, by voice: "why did you make the margins around it so big",
  after a 496 px centred column shipped without his yes; a half margin after it was still too much:
  "change the margin right now"). A change to how wide the chat reads is his to pick first. A long code line scrolls in its block.
- **Chat text keeps the chat's own size (14 px today, the one size the scale has yet to name)**;
  h1 and h2 are `--font-size-lg` (h1 700, h2 600), a smaller heading is the chat text in bold;
  paragraphs and lists 8 px apart, list items 4 px. The reply's time and a failed-send line are
  `--font-size-sm`.
- **A row is one line or two** (the user, 2026-11-11); a message card, a thought row or a tool call whose
  words are cut shows its chevron at rest (`components/sessions/cut-cue.ts`), a row that shows all of them only on hover. The
  turn's "Worked for" line is `--font-size-md` secondary grey with a 16 px chevron in `--fg` and a hover fill,
  no box and no rule.
- **One condition is one notice.** When the panel shows a notice with its action (the folder-gone
  notice), a row that failed for the same reason says so in a line and does not repeat the action.
- **Nothing starts under a header.** The history's scroll stops clear the glass header; where its
  top is a hard edge (a notice, a split's Chat bar, a strip in flow), a jump stops 12 px below it.
  A history that needs room on its left (the question map, a thread page's sliver) names it in
  `--history-left`.

Source: the UI audit of the user's own chats, 2026-11-21 (lines of 120 characters, a turn line
that "reads like a grey footnote", notices cut with no way in, the VP chat's folder-gone notice
twice). `tests/e2e/browser/chat-reading.spec.ts` measures that the chat fills the panel, the scale, the turn line, the
one notice and the split's first row; `step-row-lines.spec.ts` checks the cut-row cue on every row
kind.

## Overlays: menus, popovers, hover cards, tooltips, dialogs

Every surface that floats over the page is one of five classes in `web/src/styles/overlay-family.css`,
and closes through one hook. Its own CSS keeps only its size, padding and content layout.

| Kind | Class | Look | Closes with |
|---|---|---|---|
| Menu (a list of rows) | `wn-overlay wn-menu` | solid raised surface (`--overlay-glass-bg`), 1 px `--overlay-border`, corner `--overlay-radius` (12 px), `--overlay-shadow`, 4 px inside, rows at `--overlay-row-radius` (8 px), layer `--z-menu` | `useOverlayLayer` (Escape closes only the top layer; an outside press closes and its click is swallowed), placed by `useMenuPlacement` |
| Popover, flyout, hover card, chart readout | `wn-overlay` | the same frame; its own padding | the same |
| Dialog panel | `wn-dialog` over a `wn-scrim` | the same surface at `--dialog-radius` (16 px); header `wn-dialog-head` (title, then ONE `wn-dialog-close` at the right, drawing `{ICON_CLOSE}` from `web/src/components/common/Icons.tsx`), footer `wn-dialog-foot` (buttons right-aligned, 8 px apart) | `useModalOverlay` (Escape, scroll lock, nesting; a dialog opened over a popover owns Escape) |
| Scrim | `wn-scrim` | `--overlay-bg` (30% black light, 50% dark), layer `--z-modal`; an image viewer keeps its dark stage | the dialog's |
| Tooltip | `wn-tip` | dark in both themes (`--tip-bg`), corner 8 px, 12 px text, one line, layer `--z-tooltip` | hover and focus |

- Menus and popovers stay SOLID: rows were unreadable through WebKit glass (2026-11-04,
  `overlay-glass.css`); only the overlays in `GLASS_OVERLAYS` (`tests/web/overlays-opaque.test.ts`)
  add `wn-glass`, which then owns the material while `wn-overlay` keeps the corner and the layer.
- Layers come only from the tokens (`--z-sheet`, `--z-modal`, `--z-menu`, `--z-plugin-dialog`,
  `--z-tooltip`), never a number of its own.
- A surface drawn in place (not portalled) that floats over its neighbours is a member too: it wears
  the family class. A surface beside the user's work rather than over it (the selection's quote bar)
  is a `passive` layer: Escape is still the layer's, the page's shortcuts keep working under it.
- A pointer menu opens rightward and down from the pointer, and flips only where the window has no room.
- A list cut by its height cap fades its foot while rows are below it (`useMoreBelow`, `data-more`).
- `tests/web/overlay-family-ratchet.test.ts` finds every overlay from the source (portals, nodes put on
  `<body>` by hand, floating surfaces drawn in place) and counts, per file, the ones off the family,
  without a close hook, with a hand-written Escape, with a frame of their own (CSS or inline), drawn in
  place off the family, and tooltips without `wn-tip`; the counts only go down. It also fails on the
  CSS of a floating surface no component draws any more.
  `tests/e2e/browser/overlay-family.spec.ts` opens a list of them on the page and checks the window
  edges, the corner, the layer, Escape and an outside press.

### Big menus

A menu of eight or more rows of different kinds (the task and session ⋮ menus, the composer +
menu, a long right-click menu) has one shape (`web/src/utils/menu-shape.ts`):

1. **Everyday rows first**, with no rule between them (snooze, details, Status, Pin to).
2. **The rest is named**: collapsed groups (`KebabGroup`: icon, name, a short hint of what it holds,
   the chevron) or a section under a heading (`MenuHeading`, `.wn-menu-heading`: sentence case,
   11 px weight 600, `--fg-secondary`, the one heading look of every menu; a ContextMenu `section`
   row draws it too). Every menu's section name is it, small menus and pickers too, never a class
   of its own in capitals (2026-11-26: the mode and model pickers said PERMISSION MODE, MODEL and
   EFFORT; `tests/web/menu-heading-look.test.ts`). A heading names its section, so there is no rule
   right above it. A menu that
   acts on two objects heads each one's section with its name (the session menu: Session, Task).
3. **Rare rows sink** into the group they belong to (Move to Background and Add to topic in Move &
   transfer), and the group's hint names them in two to four words, since it sets the menu's width.
4. **Danger rows last**, alone under one rule, named for what they delete ("Delete task").
5. **At most three bare rules** between sections (the danger section's not counted), **at most 16
   first-level rows** with every group closed.
6. **Every row that opens more** (an inline group, a flyout, a picker) ends with the one
   `DisclosureChevron` at its right edge; no drawn arrow glyph (▶︎, ▸, ▾, ›). A setting row's value
   chip (`ContextMenuItem.value`) keeps its caret (a `MenuCaret`).
7. Rows are the one menu row (6 px 12 px, icon and words 8 px apart, 12 px words, the accent tint on
   hover). Its height and words size come from the family (`--overlay-row-height`,
   `--overlay-row-font`), the same in every menu: 30 px, and 44 px for a finger on a phone, never a
   menu's own (2026-11-26: at 390 wide the ⋮ menus' rows were 44 px and the others 30 px, and the
   Display, mode and model menus drew 13 px words; `tests/web/menu-row-family.test.ts`). **Every row is one drawn icon and one line of words** (the user, 2026-11-23, on the +
   menu's boxed @, / and ···: one icon, one text, no box): the icon slot holds an icon from
   `Icons.tsx` ("Menu row icons"), never a typed character (@, /, arrows, quote marks, #) and never
   an outlined cap. No action row goes without its icon either (2026-11-26: the phone's session
   rows, a narrow header's "..." rows, the sync rows and the board card menu drew only words): the
   phone and desktop session menus share one row (`SessionMenuRow`), and a row that stands in for a
   header button (a header's More menu, the session header's "...") shows that button's own icon
   (`MirroredIcon`); one that stands in for a chip of words only (Terminal, Board) names its own
   icon (`HEADER_ITEM_ICONS`), and a flyout's own action rows (Pin to's "Customize menu…" and Done)
   draw one like the rows above them. Only an info line, a pick list's option, a row led by its switch and a group of
   chips draw none. The Display panel (Filter, Layout) uses the same heading and chevron.

ContextMenu has 2 and 4 by construction (`normalizeContextMenuItems`). `tests/web/menu-shape.test.ts`
checks the rules, finds every menu surface from the source (a new one must be classified), and the
long item builders run the check in their own tests; `tests/web/menu-row-icons.test.ts` finds every
menu row icon slot from the source and fails on a typed character; `tests/e2e/browser/big-menu-shape.spec.ts`
measures the hand-built big menus as drawn, icons included.

## Empty, loading and unavailable states

Every place with nothing to show is `EmptyState` (`web/src/components/common/EmptyState.tsx`, its
look in `components/common/empty-state.css`), or its two forms `LoadingState` and `UnavailableState`.
Never a `*-empty` / `*-loading` class with its own type, colour or padding, and never a bare
"No ..." or "Loading..." line: `tests/web/empty-state-ratchet.test.ts` counts both per file.

- **Words:** a title that says what this place is and why it is empty ("No messages yet",
  "No tasks match ‘foo’", "Loading events…", "Couldn't load tasks"), then at most one hint
  sentence: the next step, or what still works ("New messages you send still work."). Loading
  says what loads. A failure says it failed and why, never as an empty list. A raw error (a file
  name, "HTTP 502") goes in `detail`, never in the hint: it shows when it reads as a plain sentence
  and folds behind "Details" otherwise. A failure's icon is the root warning colour everywhere.
- **One next step** when the place has one: Clear search, Retry, the first create, with no "+"
  glyph. A `.btn` at `pane` size, `.btn btn-sm` in a section or row (`btn-primary` only for a
  page's first setup, as Mail with no account; a reader's New note stays grey); a rare second one beside it.
- **Three sizes, one look:** `pane` for a whole pane or reader (centred, 32 px icon, 15 px title,
  13 px hint), `section` for a list, panel or card body (centred, 20 px icon, 13 px title, 12 px hint),
  `row` for a line in a list, menu, picker or form (left, no icon, 12 px). Muted text, no box, no
  border, no fill. Inside a Settings group (a form of 44 px rows) a state is drawn as one such row: left,
  13 px, the row padding and hairline (`empty-state.css` does it; never a class of the pane's own).
- An agenda or grid that stays usable when empty gets a `row` state above it (no events, still
  loading, or a calendar that could not be read, with Retry), never a silent empty grid.
- A line that only looks like a state (a button's "Loading…", an option "No limit") carries
  `empty-state-ok` in a comment on that line.

## Status labels

Why (2026-11-21, the user, of the pill-shaped controls): "什么鬼东西都要是圆形的呀？所有东西都应该统一啊"
(why must everything be round? everything should be consistent). Task rows read as a list of tags:
blue, violet and grey pills, dashed boxes, a violet "12 workers" beside a red "3 need you", each
drawn by its own class (565 class names, 155 looks).

- A state is a dot and a word (`NoticeStatus`); a task's state icon is its phase glyph
  (`phaseIcon`, `web/src/components/common/Icons.tsx`). A count, a tag or a kind (Worker, Leader, Trigger, Cron, a pull request, a source, Beta) is the one `.badge`
  (`web/src/styles/badge.css`, class list from `badge()` in `web/src/components/common/badge.ts`).
  Settings' `SettingsTag` follows it: a state tone (success, warning, error: Ready, Needs setup,
  Failed) draws the dot and word, neutral and accent (Built-in, Recommended) the badge.
- One look: 18 px tall, round (`--label-radius`, a capsule; a circle at one digit; `badge-long`, a time or a sentence, 4 px: standard "Shapes"), padding 0 6 px, 11 px
  weight 500, normal case. A member class keeps only its place (flex, margin, max-width), never a
  fill, words colour, edge, corner, padding or type size.
- Four tones from tokens: neutral (default, a grey tint, `--fg-secondary`), `badge-accent` (on, yours,
  Focus, a passing or open pull request), `badge-warning` (soon, running, pending), `badge-error`
  (failed, stopped, overdue). `badge-alert` (solid `--error`, white figure) is only the count of what
  needs the user: the Org list's thread count, the bell, a rail app's count. Forms: `badge-count` (a
  number, square at one digit), `badge-paused` (dashed, no fill: switched off, or shown and never
  acting: every trigger paused, another person's pull request, an imported session).
- The one exception to the size: a count on a rail icon (`badge-corner`) is 16 px with 10 px figures
  and a ring, so the 20 px glyph under it still reads. A dot with no words (a mark on an icon) stays
  round: it is a dot, not a label.
- On a line of words (a status card's meta line, "Marina · Leader · 1"), a badge reads as one more
  word: no box, grey unless its tone carries news (badge.css does this; members do nothing).
- One mark per place: the bell shows its count, or a dot when there is no count, never both.
- Reading order on a task row: the title, then where it lives (tier and project, as words), then its
  kinds (Trigger, Cron, pull request, tags, Worker, Leader), then its state (start, due, until, limit),
  with the needs-you mark on the row's left (its state icon and dot). Narrow columns fold each kind to
  its letter (`data-short`, `row-pill-fit.css`), except a search result's second line, which wraps
  and keeps the words.
- `tests/web/ui-standard-ratchet.test.ts` counts `ownLabel`: a `*-badge`, `*-pill`, `*-chip` or `*-tag`
  rule that paints its own fill, words colour, edge or corner; a rule that restyles `.badge` for
  one place; and a `*-count`, `*-state`, `*-role`, `*-kind`, `*-new` or `*-status` rule that draws a
  box (fill or edge, and a corner short of a circle). Its per-file count only goes down.
- Text a badge may cut goes in a child element (`<span>`): a flex box draws no ellipsis on bare
  text (`.badge > *` ellipsizes).
- **Only a Working task's status glyph moves**: it breathes (opacity 1 to .55 and back, 2 s, CSS only,
  no JS timers) and is still under `prefers-reduced-motion: reduce`. Rule: `.task-working-pulse` in
  `web/src/styles/globals.css`; guard: `tests/web/working-pulse-guard.test.ts`. iOS does the same and
  respects Reduce Motion.

## Text that does not fit

One rule for every list row, tree row, card and header (`web/src/styles/text-fit.css`):

- **The words that tell one item from another never cut.** A task title, a person's or agent's
  name, a mail subject, a notification's title and a card's summary are `.wn-title`: they wrap onto
  as many lines as they need. Never `text-overflow: ellipsis` or a line clamp on them.
- **Only secondary metadata cuts**, and it gives up its room first: a project, a source, a router
  reason, a chip's label are `.wn-meta` (one line, shrinks before anything else, its full text shown
  on hover in place by `utils/truncation-peek.ts`).
- **Times, counts, icons and buttons are `.wn-fixed`**: never cut, never grow, and never take a
  title's line; when a row is narrow they move under the title, never squeeze it.
- A view never writes its own ellipsis or clamp on a title class: `cutTitle` in
  `tests/web/ui-standard-ratchet.test.ts` counts those that exist today (they only go down), and
  `tests/e2e/browser/text-fit-scan.spec.ts` measures the main screens at 1512, 1280 and their
  narrowest column and fails when a title is cut.
- **The one exception is one-line chrome** whose room is fixed by design (a tab in a tab strip, a
  file path bar, a breadcrumb, a toolbar's current-item label): there a name may cut, the full text
  shown on hover, and the cut says why on its own line, `text-overflow: ellipsis; /* meta: <why> */`
  (the ratchet skips only marked cuts). A list row, tree row, card or header is never chrome.

Why (2026-11-21, the UI audit on the user's own data): task titles in the task panel and search
results lost the part that tells tasks apart while the small icons and time beside them kept their
room; Org names were cut at every tree level while right-edge counts stayed.

## Panes

- **An empty area says what it is for.** A pane with nothing open shows its title and the one next
  step (a hint, a button), or the panes reflow so no blank half of the window is left.
- **The next step sits next to the choice.** A form or draft keeps its choices right above or beside
  the field or button they lead to, never hundreds of pixels away.
- **Width goes by content.** A list whose rows are cut never sits beside an empty reader or an empty
  form at its full width: the list takes the room first, the empty pane shrinks to its content.

## Page heads

One look for the title of a page, the title of a pane and the key that makes a new thing. The type
lives only in `web/src/styles/page-head.css`; a view sets only the margin, padding or line height
around it.

| Part | Where | Look |
|---|---|---|
| Page title | `.page-title` on the page's `h1` (`PageHeader` writes it; a Settings pane, an app's detail and a plugin's page wear the class) | `--font-size-2xl` 20 px, weight 700, `--fg` |
| Line under it | `.page-subtitle` | `--font-size-md` 13 px, `--fg-muted` |
| Pane title | `.pane-title`: the list column of a split view (Org, Notes, Memory, Settings, Passwords, Scratchpad), a sheet's head (Board), the calendar's dates | `--font-size-xl` 17 px, weight 600, `--fg` |
| New key | `NewKey` (`components/common/PageHeader.tsx`): `.btn.btn-primary`, a drawn plus (Mail's drawn pencil), its words in sentence case | on the page title's line, at the right (`PageHeader`'s `action`); in Mail, at the head of its folder column; the family's on look (`aria-pressed`) while the box it opened is open (Routines); a key whose form takes its place leaves the head while the form is open (Agents, Commands); 44 px on a phone |

- A page has at most one New key, and it is the main key of the page. A pane head's own create
  (Notes' new note, Passwords' new item) is an icon key (`.btn.btn-icon`) beside the pane title.
- No create key shows a typed "+": the plus is drawn (`ICON_PLUS`), and the words are sentence case
  ("New agent", "Add host"), on a page, in a menu or in a dialog.
- A centred card that stands alone on an empty screen (a sign-in, an unlock, a first run) is not a
  page head and keeps its own heading.
- Guard: `tests/web/page-head-guard.test.ts` (every `h1` in the console and the shipped plugins is a
  page or pane title, no other stylesheet sets their type, no typed "+" or Title Case create key).
  Source: the UI audit of 2026-11-26 on the user's data, when page titles came in five sizes (28,
  26, 24, 22, 20 px), pane titles in four sizes and two weights, and the New key three ways.

## Words

Why (2026-11-21, the UI audit on the user's data): the composer showed "Bypass", "btw" and "Note"
in one row with no word on what each does; the side chat was "btw" on its button, "Side thread"
in the + menu and "Side threads" in its own header, beside the user's Threads; Settings said "Bar
chips" and "org_send". `tests/web/ui-words-ratchet.test.ts` counts what breaks the rules below
(per file, in `tests/web/ui-words-baseline.json`), and the counts only go down.

1. **One name per concept**, the same on every screen:

   | Concept | Say | Never |
   |---|---|---|
   | a unit of work on the board | task (subtask under it) | todo, ticket, job |
   | an agent run on a task | session | conversation, agent run |
   | one subject of the user's requests to a node | thread | topic (a topic is a group chat with members, its own thing) |
   | a question asked beside a session, kept out of it | side chat; its button and header read "btw", the session note's "Notes" (the user's names, 2026-11-23) | side thread |
   | a task's states | Needs you, To read, Working, Waiting (one task: Waiting or Snoozed), Not started, Completed | Need action, Needs action, Needs attention, Done (for a task) |
   | a thread's groups | Needs you, Waiting, Closed | |
   | the machine Walnut's server runs on | This Mac, else its host name | local, `__local__` |
   | shipped with Walnut | Built-in | Builtin, builtin |

2. **A control's label says what happens**: a verb and its object ("Mute for 1 hour", "Send in
   split view"), never a bare noun, an abbreviation or an inside name ("Quiet 1h", "Bar chips").
   A pick in a menu that changes how something behaves says what it does in a few muted words on
   its own line or at its right (the permission-mode menu).
3. **Every icon-only button has an `aria-label` or a `title`** that says what it does.
4. **Two counts side by side say what each counts** ("49 open", "155 waiting"), or one of them goes.
5. **No tool, field, file or engine ids in UI text**: no `snake_case` names (`org_send`), no model
   ids (`opus-5-5`), no config keys. Name the thing; a raw value the user must type or copy stays in
   `<code>`.
6. **Times read as a person says them**: one format in one list ("until today 1:30 AM", "until
   Nov 30, 6:00 PM"), the same clock (12 or 24 hour) everywhere, a duration in words ("1 hour").
7. **Plain English, sentence case** for labels and buttons ("Clear all", not "Clear All"); no
   em dashes.
8. **A setting is a label, a control and at most one short help line** (120 characters, about two
   lines). A settings panel holds settings, never a page of explanations: the why goes on the row's
   hover or in Settings' own page for it (2026-11-21, the user on the Org settings panel, a switch
   under two paragraphs and a four-point list: "the setting is shit", "no taste"). An experiment's
   line is its `summary` in `src/core/experimental.ts` (its description is the hover); the drawn
   length of every pane's help lines is checked by `tests/e2e/browser/settings-help-short.spec.ts`.

## Tokens (from `globals.css` `:root`)

| Kind | Tokens |
|---|---|
| Fill | `--bg`, `--bg-secondary`, `--bg-tertiary`, `--bg-elevated`, `--bg-hover`, `--card-bg` |
| Text | `--fg`, `--fg-secondary`, `--fg-muted` (light `#6E6E73`, 5.1:1 on `--bg`: the quietest grey that still passes AA for 12 px text), `--on-accent` (on a solid `--error` or `--accent` fill) |
| Accent | `--accent`, `--accent-hover`, `--accent-subtle`, `--accent-text` |
| Lines | `--border`, `--border-strong` |
| State | `--success`, `--warning`, `--error`; their 10% fills `--success-subtle`, `--warning-subtle`, `--error-subtle`. A count in a state colour takes it only above zero: "0 in alarm" and a diff's "-0" read plain or drop (`tests/web/zero-in-warning-colour.test.ts`) |
| Corners | `--radius-full` (every key, chip, segment, tab and count: standard "Shapes"), `--label-radius` (a badge: round; `badge-long` 4 px), `--radius-xs` 4 px (kbd, checkboxes, a long label), `--radius-sm` 8 px (rows, small boxes), `--radius-md` 12 px (inputs, menus), `--radius-lg` 16 px (cards) |
| Type | `--font-size-xs` 11 px (labels, badges), `--font-size-sm` 12 px (secondary text), `--font-size-md` 13 px (body, controls), `--font-size-lg` 15 px (card titles), `--font-size-xl` 17 px (section and dialog headings), `--font-size-2xl` 20 px (page titles); families `--font-sans`, `--font-mono` |
| Depth | on a surface: `--shadow-sm` (a raised chip), `--shadow-md` (a hovered card), `--card-shadow`, `--card-shadow-hover`; floating: the overlay family's `--overlay-shadow`, `--dialog-shadow`; glass: `--glass-frost-*`, `--glass-legible-*` |
| Layers | the overlay family's `--z-*` (`styles/overlay-family.css`) and its scrim `--overlay-scrim` |

Nothing sits between two sizes of the scale: a 12.5 px or 14 px label is a decision for the
scale, not for one view. A token written with a fallback (`var(--fg, #1d1d1f)`) is a second
colour for the dark theme; write `var(--fg)`.

## The phone (iOS column)

The phone app (`ios-native/`, SwiftUI) follows the same standard with its own components. Tokens are
in `ios-native/Walnut/Core/ThemeTokens.swift` (`Theme.Radius`, `Theme.Space`, `Theme.TextSize`,
`Theme.Glyph`, `Theme.Control`) and colours in `Core/Theme.swift`; the shared controls are in
`ios-native/Walnut/Views/Shared/DesignSystem/`. A view never writes its own corner, colour, text size
or button shape.

| Kind | Web | iOS |
|---|---|---|
| Accent | `--accent` blue | Walnut's brown, not the web's blue (2026-11-24, the user: the earlier yellow-based look is nicer, "because it's Walnut"): `Theme.tint` (#8B5A2B / the golden #C99659) for links, selection and quiet actions; `Theme.accent` (the same colour) for a solid fill, with `Theme.onTint` words on it (white in light, #1C1207 in dark, where white on the golden reads only 2.2:1) |
| Chat palette | `chat-palette.css` | the web's greys inside every chat (2026-11-24, the user: "white, black, grey, and maybe a bit of yellow"): `Theme.Chat` (bubble #F0F0F0 / #2C2C2E, panel #F7F7F7 / #1C1C1E, accent #3A3A3C / #8E8E93 with white on a glyph key, `keyFill` #636366 in dark under words, soft grey #757579 / #8E8E93), set by `.walnutPalette(.chat)` at each chat root (the design system reads `\.walnutPalette`, a view writes `palette.tint`, a timeline cell `Theme.Chat` itself); the brown stays outside chats and on what waits on the person (a pending permission or question card, Action needed: `.walnutPalette(.app)`) |
| Main action | `.btn-primary` | `.buttonStyle(.walnut(.primary))`: round, solid `Theme.accent`, `Theme.onTint` words, at most one per card or page |
| Action | `.btn` | `.walnut(.secondary)`: `tertiarySystemFill`, primary words |
| Tool | `.ask-card-tools .btn` | `.walnut(.tool)`: no fill, `Theme.secondaryOnCard`; a menu's label is `WalnutMenuLabel` ("Snooze ▾") |
| Destructive | `.btn-danger` | `.walnut(.destructive)`: the grey fill, `Theme.dangerText` words |
| Option | `AskOptions` row | `.walnut(.option(recommended:))` with `WalnutOptionLabel`: full width, hairline, a 12 pt corner (a long key: `WalnutButtonStyle.optionShape`, never a capsule), the recommended one solid `Theme.accent` with "Recommended" at its right. Every choice of a question is one: a permission card's (never half-width keys side by side), an ask card's, a thread's, a letter's decision. The main action and the recommended choice are always solid in the accent, whatever the list names (2026-11-26, the team's rule: one look keeps its main action in the main colour): a permission list's first Allow (`PendingPermission.strongChoiceID`; the web's `strongChoiceId` fills the same one), an ask's or a letter's recommended choice; a refusal's words are `Theme.dangerText`. A label's own trailing "(Recommended)" is dropped from what shows and becomes the mark at the right (`WalnutOptionLabel.shown`), and that row is solid; the answer sent keeps the label as written; a pick shows by its radio mark and a ring |
| Picker key | composer pills | `.walnutPickerKey(active:wraps:)` on every small picker key of a tool row (the composer's Mode and Model, the new-session row's folder, project, sync, mode and model keys, quick folders): a capsule beside the round +, mic and send, the 12 pt corner only once its words wrap; a picked value is `tintSoft` with an accent hairline. A row of them wraps onto a second line, never cuts a key at the screen's edge |
| Chip, filter | none | `.walnutChip(selected:)`: round, 32 pt drawn, 44 pt touch; selected is `Theme.chipSelected` (a step stronger than `tintSoft`) with an accent hairline and primary words. A chip row that can be wider than the screen scrolls sideways, and a filter that is on says so in the list |
| Badge | `.badge` | `WalnutBadge` (round, `Theme.TextSize.xs` semibold, one tone); a state is `WalnutStatusLabel` (dot and word) |
| Diff count | `+N −M` | `LineCounts`, written by `DiffCount` alone: only the sides above zero ("+7", "−3", "+12 −3"), nothing when no line changed; the zero side never takes a state colour |
| Card | `AskCardFrame`, `NoticeCard` | `.walnutCard()` (grouped fill, `Theme.Radius.card` 16, hairline); `frosted: true` for a card that asks; a notice is the shared notice card (`Theme.Radius.notice` 14, as on the web and the Mac) |
| Reply box | `AnswerBox`, `wn-input` | the one message box (`MessageBox` / `ReplyBox`): its own box corner, round keys |
| Plain field | global `input` rules | `.textFieldStyle(.walnut)` or `.walnutFieldBox()`; inside a `Form` the system row |
| Empty state | `EmptyState` | `WalnutEmptyState` (`pane`, `section`, `row`), never `ContentUnavailableView` |
| Toast | `NoticeCard` stack, toast rule | the shared notice center only, under the toast rule above; no view draws a toast of its own |

Sizes: controls are 44 pt (a finger), a small one draws 32 pt and keeps a 44 pt touch, a tool 28 pt.
Corners of surfaces `Theme.Radius.xs/sm/md/lg/card/notice` = 4 / 8 / 12 / 16 / 16 / 14 (a list row 8, a single-line field 12, a card 16). Text sizes are iOS text styles at the
web's scale (`Theme.TextSize.xs...xxl` = caption2 11, caption 12, footnote 13, subheadline 15, body 17,
title3 20), so they grow with Dynamic Type; a glyph of fixed size is `Theme.Glyph`. Spacing is the web's
2 pt grid (`Theme.Space`). Shapes as on the web ("Shapes"): what you press and every tag is round (a capsule; a square one a circle),
what you type or read in is a rounded rectangle from `Theme.Radius`, and no corner in between on a key. A long key
(one that spans its line or takes two lines: an option row, a full-width key) is a long block, so it takes the 12 pt corner
(`WalnutButtonStyle.optionShape`), never a capsule, which on it reads as an oval (2026-11-23, the user's "长的方的可以，小的要圆":
long and square is fine, small must be round); the ratchet's `wideCapsule` counts a capsule in a chain that spans its line. No system `.bordered` / `.borderedProminent`: the OS
picks their shape (a capsule on iOS 26).

`tests/web/ios-ui-standard-ratchet.test.ts` counts, per Swift file, each view that still draws its own
(literalColour, literalFont, radiusLiteral, systemButtonStyle, ownButtonStyle, ownReplyBox,
ownEmptyState, tintFill, wideCapsule; `tests/web/ios-ui-standard-baseline.json`), and the counts only go down.
It also holds three classes whole (2026-11-26): no picker key on the composer and new-session rows draws
its own shape, every button that answers a permission or question choice is an option row with
`WalnutOptionLabel`, and no view writes a "+N −M" count outside `DiffCount`. A line that must
keep its shape (a sheet's grabber, a camera shutter) says why with `// ui-standard-ok: <why>`.

## What exists today that breaks this (the ratchet counts them)

Counted on 2026-11-23 by `tests/web/ui-standard-ratchet.test.ts` (per file, in
`tests/web/ui-standard-baseline.json`):

- 1 rule restyles `.btn` outside the family's two homes (`styles/buttons.css`, and the card
  family in `components/actions/ask-card.css`): `styles/inline-answer.css`.
- 305 rules in 97 files give a key its own fill and corner instead of a `.btn` variant: a
  `*-btn`, `*-button`, `*-pill` or `*-chip` class, or any class written on a `<button>` outside the
  family (`.nfc-card-action` had no such name, 2026-11-23).
- 927 `<button>` elements in 376 TSX files (the console's and the plugins' in `plugin-store/`) carry no `btn` class (choice controls with role tab,
  radio, switch, checkbox or option aside). A new file starts at 0.
- A key's own behaviour drawn beside the family's look is listed with its reason in
  `OWN_BEHAVIOUR` (`tests/web/ui-standard-scan.ts`): a permission rule's 5 s armed countdown bar
  (`.is-armed::after`; the armed key itself takes the family's on look, `data-on`) and a session
  card's busy ring on a phone (`.permission-request-btn.is-busy`).
- 21 raw `#007aff` / `#0a84ff` in 9 files where `var(--accent)` belongs.
- Values written where a token belongs (per declaration, `tests/web/ui-token-scan.ts`):
  `rawColour`, `radiusNotToken`, `pillRadius` (69: the pill-shaped controls and labels),
  `fontSizeOffScale`, `shadowLiteral`, `zIndexLiteral`, `spacingOffGrid`. Their counts per file are
  in the same baseline; a new file starts at 0.
- 8 rules in 2 files style an input box outside `input-box.css`: the floating composers' glass
  fill and shadow, their focus edge and the phone's 44 px send target (all on purpose; a new one
  fails). The unread composer's red edge is a state of the box, in `input-box.css`.

A change that touches one of these moves it onto the family; the ratchet then asks for its count to
be lowered (`UI_STANDARD_RECORD=1` on that test).
