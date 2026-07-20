# Approach A — "Editing-Feel-First": the keyboard never has to leave home row

> **One-line thesis:** Make the *act of writing* so fluid that structure (headings, tables, tags, callouts) emerges from the keystrokes you'd type anyway — `/` to build, `#` to label, drag to reorder, select to style — so the editor feels less like a tool you operate and more like paper that anticipates you.

---

## Executive Summary

- **Problem.** The current editor renders Markdown live but has no Notion-grade *micro-interactions*: the slash menu only searches tasks, there is no block drag handle, no `+` inserter, no floating selection toolbar, no tables, no `#tag` input. Capture works but never feels *delightful* — every structural action (make a table, reorder a paragraph, style a phrase) costs more keystrokes or mouse trips than it should. This approach treats the *felt latency and rhythm of editing* as the product.
- **What we'll build (UX, this doc).** A block editor whose every affordance is keyboard-reachable and zero-clutter-until-needed: a Notion-style **insert-block slash menu** (extends the existing `SlashCommandExtension` that already tracks the `/`-range), a hover **drag handle + `+` inserter** rail in the left gutter, a **floating selection toolbar** ("bubble"), **tab-driven table editing**, inline **`#tag`** autocomplete (a third trigger alongside the existing `[[` one), and a **Cmd+K** quick switcher / capture. Markdown stays the source of truth; nothing here changes that contract.
- **Simplest first step.** Flip the slash menu from `task` only to a real insert-block list (the range-tracking and capture-phase keyboard nav *already exist* in `SlashCommandMenu.tsx` / `SlashCommandExtension.ts` — we add menu items + `editor.chain()` actions, not new plumbing). This alone makes the editor feel 10x more capable on day one, with no backend work.
- **User-visible outcome.** You type `/tab`↵ and a 3×3 table appears with the cursor blinking in cell 1; Tab walks you across it, Tab on the last cell grows a new row. You select three words and a small toolbar fades in under your thumb. You type `#stand` and pick `#standup` from a list. You hover a paragraph, grab the `⠿` grip, drop it two blocks up — clean Markdown, no blank-line litter. Cmd+K from anywhere lands you in any note (or a brand-new one) in under a second.
- **Definition of done (user's words).** "All the good features and no bug," "super easy to use." Held to a **no-jank, no-data-loss, byte-clean-Markdown** bar — and specifically here, an *input-latency and pointer-economy* bar: every common structuring action ≤ 2 actions and reachable without the mouse.

> **#1 priority restated:** This approach spends its entire "complexity budget" on the editing surface. Where it must trade, it trades *away from* breadth (fewer block types at launch) and *toward* the tactile quality of the blocks that exist.

---

## Why this angle, given what already exists

The codebase already hands us a near-perfect substrate for a *feel-first* design — we are extending, not rebuilding:

| Existing asset (read from code) | What it unlocks for feel-first UX |
|---|---|
| `SlashCommandExtension.ts` already tracks the `/`→cursor **range** and streams `{query}` to React | The slash menu's hard part (positioning + range replacement) is **done**. We add block items + actions. |
| `SlashCommandMenu.tsx` already does **capture-phase** ArrowUp/Down/Enter/Esc and `onMouseDown` `preventDefault` | Keyboard-first nav and "focus never leaves the editor" are **already the pattern**. We reuse it for the block menu, the table cell menu, and the `#tag` list. |
| `WikiLinkExtension` proves a **second trigger char** (`[[`) coexists with `/` | `#tag` is just a **third trigger** of the same shape — no architectural risk. |
| `TightTaskList`, per-line **Tab indent/outdent w/ child detach**, **ArrowUp nesting fix** | These are *exactly* the kind of tactile details this approach worships. We treat them as a **regression suite** and match their quality in new blocks. |
| `isSourceRef` **save-sync loop guard** + cursor/scroll restore on external sync | The "no cursor jump on save" feel is already engineered. New blocks must not break it (see Tradeoff + invariants). |

So feel-first is not a moonshot here — it's *finishing the gestures the architecture already started.*

---

## The signature UX moves (and WHY each makes editing feel great)

### Move 1 — The left **gutter rail**: `⠿` grip + `+` inserter, revealed on hover
Notion's single best "it just feels right" detail is that the page looks like a clean sheet of paper until your pointer enters a block's row — then a drag grip and a `+` quietly appear in the left margin. **Why it feels great:** affordances are *spatially predictable* (always same x-position, always the current row) and *zero-clutter* (invisible until intent is signaled by hover). It turns "I need to restructure" from a menu hunt into a direct grab.

- **`+`** (insert): click → opens the same slash menu *as if you'd typed `/`* on a new line below. One affordance, one mental model.
- **`⠿`** (grip): click → selects the whole block (shows the block menu: Turn into / Duplicate / Delete / Color); drag → reorders. Drop target is a **2px insertion line** that snaps between blocks.

### Move 2 — `/` is a **builder**, not a search box
Typing `/` anywhere on an empty-ish line opens a filterable *insert-block* palette. **Why it feels great:** it's the universal "I want to add structure" verb — you never memorize which menu holds tables vs. callouts; you just type what you mean (`/tab`, `/quo`, `/h1`, `/code`, `/call`, `/div`, `/todo`). Fuzzy filter + keyboard nav means the whole thing is a 3-keystroke muscle memory: `/`, a letter or two, `↵`.

### Move 3 — The **bubble toolbar** on selection
Select any run of text → a compact floating toolbar fades in just above the selection: **B / I / S / `<>` / link / "Turn into ▾"**. **Why it feels great:** styling is *where your eyes already are* (at the selection), not in a far-off top ribbon. It respects the keyboard too — `Cmd+B/I` still work; the bubble is the *discoverable* path, the shortcuts are the *fast* path. The bubble auto-hides the instant the selection collapses, so it never nags.

### Move 4 — **Tab is the table's nervous system**
In a table, Tab/Shift-Tab move cell→cell; Tab on the last cell **creates a new row** and lands you in its first cell; ↑/↓ move row to row; a small `⋯` on row/column hover gives insert/delete/move. **Why it feels great:** filling a grid becomes a *flow* — type, Tab, type, Tab — never reaching for the mouse or a "+row" button. This is the single interaction Marco (the Notion persona) will judge us on hardest, so it gets first-class keyboarding.

### Move 5 — `#` types a **label**, inline, with autocomplete
Typing `#` followed by letters opens a tag list (autocompleted from tags already in the vault); `↵` or click commits a styled `#tag` chip; `#newthing␣` creates a new tag inline. **Why it feels great:** labeling is a thought you have *mid-sentence* — it must cost nothing and never break typing rhythm. Existing-tag autocomplete also gently steers toward consistency (you reuse `#q3-planning` instead of inventing `#Q3Planning`).

### Move 6 — **Cmd+K** is the front door (jump or capture)
One shortcut, from anywhere: fuzzy-match a note title to *jump in*, or — if nothing matches — press ↵ to *create that note and start typing*. **Why it feels great:** the gap between "I have a thought" and "I'm typing it into the right place" collapses to one keystroke and a few letters. No tree-clicking, no folder decisions.

### Move 7 — **Markdown shortcuts stay on** (the silent power user's path)
`# `→H1, `- `→bullet, `> `→quote, `` ``` ``→code, `[] `→todo, `**x**`→bold all still fire as you type (StarterKit + tiptap-markdown already do most). **Why it feels great:** the slash menu is the *discoverable* path for Marco; Markdown shortcuts are the *expert* path for Riya — both produce the **same blocks and the same clean Markdown on disk**, so the two personas never fork the data.

---

## Wireframes & interaction mockups

### A. The editor at rest vs. on hover (the gutter rail)

```
AT REST (clean paper — no chrome):
┌───────────────────────────────────────────────────────────────┐
│                                                                 │
│   Q3 Planning Sync                                              │  ← H1
│                                                                 │
│   We split the data work across two pods. Decisions below.      │  ← paragraph
│                                                                 │
│   • migrate the ingest job first                                │
│   • backfill after cutover                                      │
│                                                                 │
└───────────────────────────────────────────────────────────────┘

ON HOVER over the paragraph row (rail fades in, same x every time):
┌───────────────────────────────────────────────────────────────┐
│                                                                 │
│   Q3 Planning Sync                                              │
│                                                                 │
│ ⊕ ⠿  We split the data work across two pods. Decisions below.   │  ← + and ⠿ appear
│ ▲ ▲                                                             │     ONLY on this row
│ │ └─ grip: click=select block / menu • drag=reorder            │
│ └─── plus: click=insert block below (opens slash menu)         │
└───────────────────────────────────────────────────────────────┘

DRAGGING a block (2px snap line shows the drop target):
┌───────────────────────────────────────────────────────────────┐
│   Q3 Planning Sync                                              │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │ ← drop here (snap line)
│      ┌─────────────────────────────────────────────┐           │
│ ⠿▏   │ • migrate the ingest job first   (dragging…) │  ← lifted block follows cursor
│      └─────────────────────────────────────────────┘           │
│   • backfill after cutover                                      │
└───────────────────────────────────────────────────────────────┘
```

### B. The `/` insert-block menu (extends today's slash mechanism)

```
User typed "/" on an empty line, then "ta":
┌───────────────────────────────────────────────────────────────┐
│   Meeting notes                                                 │
│                                                                 │
│   /ta▏                                                          │  ← caret; query="ta"
│   ╭───────────────────────────────────────────╮                │
│   │  BLOCKS                          ↑↓ ↵ esc  │                │
│   │ ▸ ▦  Table              3×3 grid, tab-nav  │ ◀ selected     │
│   │   ☑  To-do list         checklist          │                │
│   │   📋 Task reference      link a Walnut task │ ← legacy path  │
│   ╰───────────────────────────────────────────╯                │
└───────────────────────────────────────────────────────────────┘

Full menu when query is empty (grouped, fuzzy-filterable):
╭──────────────────────────────────────────────╮
│  BASIC                                         │
│   ¶  Text            plain paragraph           │
│   #  Heading 1       big section title         │
│   ## Heading 2       medium title              │
│   ###Heading 3       small title               │
│  LISTS                                         │
│   •  Bulleted list                             │
│   1. Numbered list                             │
│   ☑  To-do list      checklist (tight)         │
│  BLOCKS                                         │
│   ▦  Table           grid, tab to navigate     │
│   "  Quote           blockquote                 │
│   <> Code            fenced code + language     │
│   💡 Callout          icon + colored container   │
│   ─  Divider         horizontal rule           │
│   🖼  Image           upload / paste / URL        │
│  REFERENCE                                     │
│   📋 Task             insert a task link         │
│   🔗 [[ Note link    link another note          │
╰──────────────────────────────────────────────╯
   ▲ keyboard: type to filter · ↑↓ move · ↵ insert · esc cancel
   ▲ on insert: the "/ta" text is deleted (range from extension) and
     the block is inserted in its place — caret lands INSIDE the block.
```

### C. Bubble (selection) toolbar

```
User selected "split the data work":
┌───────────────────────────────────────────────────────────────┐
│                  ╭─────────────────────────────────────╮       │
│                  │ B  I  S  <>  🔗 │ Turn into ▾ │ 💡 │ │       │  ← fades in above
│                  ╰───────────────────────┬─────────────╯       │     the selection
│   We [split the data work] across two pods.                     │
│        └──────────────────┘ (selection)                         │
└───────────────────────────────────────────────────────────────┘
   • B/I/S/<> toggle marks (Cmd+B / Cmd+I still work — bubble is the
     discoverable twin of the shortcut).
   • 🔗 opens a tiny inline URL field (paste a URL over a selection
     also wraps it — linkOnPaste already does this).
   • "Turn into ▾" → H1/H2/H3 · Quote · Callout · Code · Bullet · To-do
     (block-level transform of the whole paragraph the selection sits in).
   • Collapses the instant selection is empty. Never covers the caret line.
```

### D. Table editing (Tab is the nervous system)

```
After /table → 3×3 with caret in the first body cell:
┌──────────────────────────────────────────────────────────────┐
│  ╔═══════════╦═══════════╦═══════════╗                         │
│  ║ Attendee  ║ Role      ║ Action    ║  ← header row (bold)    │
│  ╠═══════════╬═══════════╬═══════════╣                         │
│  ║ ▏         ║           ║           ║  ← caret here; Tab →    │
│  ╟───────────╫───────────╫───────────╢                         │
│  ║           ║           ║           ║                         │
│  ╚═══════════╩═══════════╩═══════════╝                         │
└──────────────────────────────────────────────────────────────┘

Keyboard model:
  Tab        → next cell (wraps to next row's first cell)
  Shift+Tab  → previous cell
  ↑ / ↓      → cell directly above / below
  Tab on the LAST cell  → append a new row, land in its first cell
  Enter inside a cell    → soft line break WITHIN the cell (cells can be multi-line)

Hover a column edge → "⋯" control; hover a row's left edge → "⋮" control:
        ⋯ (column menu)
  ╔═════╪═════╦═══════════╗        ⋮ menu:  ┌──────────────────┐
  ║ At… │ Ro… ║ Action    ║                 │ Insert row above │
  ╠═════╪═════╬═══════════╣                 │ Insert row below │
 ⋮║     │     ║           ║  ← row handle   │ Move up / down   │
  ╚═════╧═════╩═══════════╝                 │ Delete row       │
                                            └──────────────────┘
  ⋯ menu: Insert col left/right · Move col · Delete col · Toggle header
  Markdown on disk → standard GFM pipe table (clean round-trip):
     | Attendee | Role | Action |
     |---|---|---|
     |  |  |  |
```

### E. `#tag` inline autocomplete

```
User typed "#stand" mid-sentence:
┌───────────────────────────────────────────────────────────────┐
│   Decisions from the #stand▏                                    │
│                       ╭───────────────────────────────╮         │
│                       │ # TAGS              ↑↓ ↵ esc   │         │
│                       │ ▸ #standup         used 12×    │ ◀ sel   │
│                       │   #standards       used 3×     │         │
│                       │   ─────────────────────────    │         │
│                       │   + Create "#stand"            │         │
│                       ╰───────────────────────────────╯         │
└───────────────────────────────────────────────────────────────┘

Committed (↵ on #standup) — renders as a styled chip, stays text in MD:
   Decisions from the [#standup] meeting were…
                       └───────┘ clickable chip → opens tag view

Behavior:
  • List = tags already in the vault, ranked by frequency (steers reuse).
  • "#newword␣" or "+ Create" makes a new tag inline — no dialog.
  • A tag is a styled inline node; on disk it serializes to a literal
    "#standup" token (chosen Markdown form, frozen in tech design) so it
    round-trips byte-clean and stays greppable by the string index.
  • Click a chip → tag view (Scenario E): every note with that tag, newest
    first, served from the tag index (not an O(n) scan).
```

### F. Hybrid search results (string + semantic, labeled by WHY)

```
Notes search — one box, one ranked list, every hit says why it matched:
┌───────────────────────────────────────────────────────────────┐
│  🔎  planning sync where we split the data work          [⌫]    │
├───────────────────────────────────────────────────────────────┤
│  Q3 Planning Sync                              folder: /work    │
│     …we [split the data work] across two pods…                  │
│     ⟐ exact text  ·  ≈ related meaning            ← both badges │
│ ─────────────────────────────────────────────────────────────  │
│  Data Platform Roadmap                         folder: /work    │
│     …rebalancing ingest ownership between pods…                 │
│     ≈ related meaning  (0.81)                                   │
│ ─────────────────────────────────────────────────────────────  │
│  Standup 2026-03-04                            folder: /daily   │
│     …action: migrate the [ingest] job first…                    │
│     ⟐ exact text                                                │
└───────────────────────────────────────────────────────────────┘
   Rules that build trust:
   • Exact-text hits are NEVER ranked below a purely-semantic hit.
   • Each result is badged: ⟐ exact substring · ≈ related meaning · (both).
   • Matched span is highlighted in the snippet.
   • Semantic side reuses the engine that ALREADY indexes the notes vault;
     string side comes from a derived index (not a full-vault re-read).
```

### G. Cmd+K quick switcher / capture

```
Cmd+K from any screen — jump to a note OR create one:
┌───────────────────────────────────────────────────────────────┐
│  ⌘K   go to note…  ▏                                            │
├───────────────────────────────────────────────────────────────┤
│  ↵ Jump    ⇧↵ Open in panel    esc Close                        │
│  ───────────────────────────────────────────────────────────   │
│   📄  Q3 Planning Sync                          /work           │
│   📄  Quarterly OKRs                            /work           │
│   📄  Q3 retro                                  /daily          │
└───────────────────────────────────────────────────────────────┘

Typed a title that doesn't exist ("Weekly review 06-08"):
┌───────────────────────────────────────────────────────────────┐
│  ⌘K   Weekly review 06-08▏                                      │
├───────────────────────────────────────────────────────────────┤
│   ✚  Create note “Weekly review 06-08”          ↵               │  ← top action
│   📄  Weekly review 06-01                       /daily          │  ← fuzzy near-miss
└───────────────────────────────────────────────────────────────┘
   • Fuzzy title match (subsequence), recents floated to top.
   • ↵ on "Create" makes the note in a sensible default folder and drops
     you straight into a focused empty editor (Sam's zero-decision capture).
   • Pure keyboard: open → type → ↵. Sub-second to "I'm typing."
```

---

## Interaction details (the exact moment-by-moment behavior)

**On `/` (slash):**
- Fires only at line start or after whitespace with no space between `/` and caret — *this rule already exists* in `findSlashTrigger()`. We keep it verbatim.
- Menu opens anchored to the caret; typing filters (fuzzy, not just `startsWith` — upgrade the current `startsWith` so `/cl`→Callout, `/ck`→Checklist work).
- ↑/↓ move selection, ↵ inserts, Esc closes, mouse hover re-selects, `onMouseDown` keeps focus in the editor — *all already the pattern* in `SlashCommandMenu.tsx`.
- On insert: delete the tracked `/…` range (the extension already gives `range.from/to`), insert the block via `editor.chain()`, place caret **inside** the new block. A trailing space or empty line is never left behind (byte-clean).
- `/` typed mid-word (e.g. a URL `a/b`) does **not** trigger — the whitespace rule guards this.

**On hover over a block:**
- After a short hover (≈80–120ms, to avoid flicker on fast pointer sweeps) the gutter rail (`⊕` `⠿`) fades in for *that block only*, at a fixed left x.
- `⊕` click → opens the slash menu for a new block *below* the hovered one.
- `⠿` click → selects the whole block + opens the block menu (Turn into / Duplicate / Color / Delete). `⠿` press-drag → lift block, show a 2px snap line at the nearest gap; drop reorders. ESC mid-drag cancels and returns the block.
- Rail hides when the pointer leaves the block region (with a small grace zone so moving onto the rail itself doesn't dismiss it).

**On selecting text:**
- Non-empty selection → bubble toolbar fades in above the selection (flips below if near the viewport top). Buttons: B / I / S / `<>` / 🔗 / "Turn into ▾".
- The instant the selection collapses (click, arrow key, typing) the bubble disappears — it must never linger over the caret.
- Keyboard shortcuts (`Cmd+B/I`, etc.) keep working independently — the bubble is additive, never the only path.
- Selecting *across* blocks shows only the marks that apply to all (block-level "Turn into" is hidden for multi-block selections to avoid ambiguity).

**On typing `#` (tag):**
- `#` at line start or after whitespace opens the tag list (a *third* trigger of the same shape as the existing `[[` and `/` triggers — proven safe by `WikiLinkExtension`).
- List = vault tags ranked by frequency; typing filters; ↵/click commits a chip; `#word␣` (space) or "+ Create" makes a new tag.
- `#` immediately followed by a non-letter (e.g. `#1` in "issue #123", or a Markdown `# heading`) does **not** open the tag list — disambiguated by requiring a letter and by line-context (a lone `# ` at line start is still a heading shortcut).
- Backspace into a committed chip selects the whole chip first (one more Backspace deletes it) — chips never half-delete into broken text.

**On `[[` (wiki-link):** *(already implemented — we keep it, and fix identity per the PRD's P1 root-cause work; no UX change here beyond it living in the same menu family as `/` and `#`.)*

**On Cmd+K:**
- Opens a centered command palette over any screen (notes or not).
- Fuzzy subsequence match on note titles; recents float up when query is empty.
- ↵ jumps into the top result; if the top action is "Create …", ↵ creates + opens it; ⇧↵ opens in a side panel; Esc closes.
- Entirely keyboard-driven; no row needs a click.

**Cross-cutting feel guarantees (the "no-jank" contract):**
- **No cursor jump on save.** The `isSourceRef` guard + cursor/scroll restore already protects this; every new block must round-trip through the same save path so it stays protected (see invariants).
- **Byte-clean Markdown.** Inserting/reordering blocks never leaves stray blank lines or escapes (the `TightTaskList` saga is the cautionary tale — we hold tables/callouts/tags to the same round-trip test).
- **Smooth on large notes.** Hover-rail and bubble are pure DOM overlays driven by the current selection/hover — they do not re-render the doc, so typing latency is unaffected.

---

## Respecting the hard-won invariants (so feel-first doesn't regress feel)

This approach is *additive overlays + new nodes*; it must not disturb the subtle logic already in `NotesEditor.tsx`:

1. **`isSourceRef` save-sync loop guard** — new block inserts go through normal `onUpdate`; we never bypass it, so the "don't re-`setContent` my own save" behavior holds.
2. **Per-line Tab detach + `tryJoinPreviousListAndSink` + ArrowUp nesting fix** — Tab is overloaded inside tables (cell nav). The table extension must claim Tab *only when the selection is inside a table*; outside a table, the existing list-Tab logic is untouched. This is the one explicit keyboard-precedence rule to get right.
3. **`TightTaskList`** — `/todo` inserts the same tight task list; we do not introduce a parallel "loose" list path that would re-litter blank lines.
4. **External-sync cursor/scroll restore** — overlays read live selection, so an external `setContent` simply repositions the caret (already handled) and the overlays follow; no extra coordination needed.

---

## Biggest tradeoff

**This approach optimizes the *tactile quality* of a deliberately small set of blocks and gestures, and pays for it in launch breadth and in pointer-interaction engineering risk.**

- **What we give up:** fewer block types at v1 (no columns/multi-column, no synced blocks, no toggle lists in the first cut), and the hybrid-search/identity backbone is *consumed*, not advanced, by this doc — it leans on the PRD's P1 work rather than pushing it. A breadth-first reviewer will see a "thin" feature matrix.
- **Where the risk concentrates:** drag-and-drop reorder and the floating overlays are the hardest things to make feel *right* (snap targets, hit-testing, not fighting native text selection, not flickering on fast hovers, never covering the caret). Getting these *almost* right is worse than not shipping them — a janky drag handle reads as "broken," not "minimal." And the **Tab-precedence** rule between table-cell-nav and the existing list-indent logic is a genuine correctness hazard against code that is already delicate.
- **Why it's the right trade for this brief:** the user said the editing experience is "the core of the core of the core." A few blocks that feel *flawless* beat many blocks that feel *okay*. We bound scope to protect feel, and we treat the existing custom keyboard logic as a regression suite so the new gestures raise the floor instead of cracking it. Breadth (columns, more block types) is cheap to add *after* the gesture layer is solid; retrofitting feel onto a broad-but-janky editor is not.
