# Approach C — Minimal-Delta / Ship-Fast

> **UX exploration, design phase only.** No implementation code. This document proposes UX,
> wireframes, interaction contracts, and the smallest credible path from today's editor to a
> Notion-class feel. It deliberately reuses what already exists in `web/src/components/notes/`.

---

## Executive Summary

- **Problem.** The editor is already a TipTap/ProseMirror WYSIWYG that round-trips Markdown — but
  it *feels* like a textarea, not Notion: the `/` menu only searches tasks, there are no tables, no
  tags, no block handles, and no floating toolbar. The gap is **affordances and a few blocks**, not
  a missing engine.
- **The fix (this angle).** Reach a great Notion-class feel with the **smallest change to the
  existing setup**: add a short list of battle-tested off-the-shelf TipTap extensions, and *re-skin
  the slash mechanism we already wrote* (it already detects `/`, tracks a range, renders a floating
  panel, and replaces text on select). We extend; we do not rewrite. New custom code is concentrated
  in exactly two small custom nodes (Callout, Tag) where no clean off-the-shelf option round-trips to
  our Markdown contract.
- **Simplest first step.** Flip the slash menu's command list from "one task entry" to a real
  insert-block list (heading / list / quote / code / divider / table / callout / todo) and wire each
  entry to a TipTap command. This is a one-file content swap on top of machinery that already works —
  it ships a Notion feel on day one, before tables or tags land.
- **User-visible outcome.** You press `/` and pick a block; you hover a paragraph and a grip + "+"
  appear; you select text and a small toolbar floats in; you type `#` and tags autocomplete; `Cmd+K`
  jumps you to any note or captures a new one. It feels like Notion, and the file on disk stays clean
  Markdown.
- **The bet.** *Buy, don't build.* Every hour spent re-implementing tables/drag/toolbar is an hour of
  bug surface against our #1 priority (editing quality). Off-the-shelf extensions are used by
  thousands of editors and already handle the ProseMirror edge cases our hand-rolled list logic shows
  are easy to get wrong.

---

## One-line thesis

**Don't build a Notion clone — assemble one:** add a curated set of proven TipTap extensions and
re-skin the slash/`[[` machinery we already have, so a Notion-class feel ships in the fewest moving
parts and the least new bug surface — keeping editing quality #1 by *not* reinventing the hard parts.

---

## Why minimal-delta is the right lens here (grounded in the code)

I read `web/src/components/notes/NotesEditor.tsx` and its `slash-commands/` + `wiki-link/` helpers.
Three facts make "assemble, don't build" the lowest-risk path to a great editor:

1. **The slash engine already exists and is generic.**
   `slash-commands/SlashCommandExtension.ts` is a ProseMirror `Plugin` whose `view().update()`:
   walks the text before the cursor (`findSlashTrigger`), finds a valid `/`, computes an absolute
   `range {from,to}`, and pushes `{ phase:'commands', range, query }` to React via `onStateChange`.
   `SlashCommandPortal.tsx` renders a floating panel at `editor.view.coordsAtPos(range.from)` and, on
   select, does `editor.chain().focus().deleteRange(range).insertContent(...)`. **That is exactly the
   Notion insert-block flow.** The *only* reason it inserts a task link today is that
   `NOTE_SLASH_COMMANDS` in `slash-commands/types.ts` has a single `task` entry and the portal's
   `handleCommandSelect` only knows `'task-search'`. Swap the list, add command dispatch → block menu.
   No new trigger plumbing.

2. **`#tag` and the new block menu are the same shape as `[[`.**
   `wiki-link/WikiLinkExtension.ts` is a near-identical `Plugin` that detects `[[`, tracks a range,
   and renders `WikiLinkAutocomplete`. A `#`-trigger for tags is the *same pattern with a different
   trigger char and a different result set* — we already wrote this shape twice (slash + wiki), so a
   third instance is well-trodden, not novel.

3. **Markdown round-trip is already solved for the standard blocks.**
   `tiptap-markdown` is configured with `html:true` and transform-paste/copy. The official
   table/heading/quote/code/divider blocks serialize to **standard Markdown** (pipe tables, `#`,
   `>`, fences, `---`) through prosemirror-markdown with no custom serializer. Only **Callout** and
   **Tag** lack a canonical Markdown form — so those are the *only* two places we write a custom
   node + serializer. Everything else is configuration.

> **Consequence:** the delta is **~5 npm extensions + one slash-menu content swap + two small custom
> nodes + two reused trigger panels.** That is the whole P0 editor. The hard, bug-prone parts
> (table cell selection, drag reordering, toolbar positioning) are delegated to maintained packages.

---

## The off-the-shelf shopping list (what to add, what to reuse)

| Need (P0) | Decision | Package / source | Markdown round-trip |
|---|---|---|---|
| Tables (create, cell edit, Tab nav, add/del row+col, header) | **ADD off-the-shelf** | `@tiptap/extension-table` family (Table, TableRow, TableHeader, TableCell) | ✅ native pipe tables via prosemirror-markdown |
| Block drag handle ("grip") + "+" inserter | **ADD off-the-shelf** | `@tiptap/extension-drag-handle-react` (React grip component) | ✅ pure UI; reorders nodes, no serialization change |
| Floating selection toolbar (bold/italic/H/quote/link…) | **ADD off-the-shelf** | `@tiptap/extension-bubble-menu` (BubbleMenu) | ✅ pure UI over existing marks |
| Bold / italic / strike / inline code / H1–H3 / lists / quote / code block / divider | **REUSE — already in StarterKit** | `@tiptap/starter-kit` (installed) | ✅ standard Markdown |
| Checklists / nested todos / per-line Tab | **REUSE — keep as-is** | existing `TightTaskList` + `TaskItem` + custom `handleKeyDown` | ✅ already tuned |
| Slash *insert-block* menu | **REUSE engine, swap content** | existing `SlashCommandExtension` + `SlashCommandPortal` | ✅ inserts standard nodes |
| `[[wiki-link]]` autocomplete | **REUSE — keep as-is** | existing `WikiLinkExtension` | ✅ stays plain `[[name]]` |
| Images (paste/drag/upload) | **REUSE — keep as-is** | existing `Image` + handlers | ✅ |
| Links (autolink, task SPA routing) | **REUSE — keep as-is** | existing `TaskAwareLink` | ✅ |
| `#tag` inline node + autocomplete | **BUILD (small) — reuse trigger pattern** | new `TagExtension` modeled on `WikiLinkExtension` + a `Tag` mark | ⚠ defined form: literal `#tag` text in Markdown |
| Callout block (icon + colored container) | **BUILD (small)** | new `Callout` node + serializer | ⚠ defined form: blockquote with a leading marker (see §"Markdown contracts") |
| Hybrid search panel (string + semantic) | **BUILD UI, reuse engines** | new search panel calling existing substring endpoint + existing embedding store | n/a |
| `Cmd+K` quick switcher / capture | **BUILD (small) — app-level** | new command-palette overlay (not an editor extension) | n/a |

**Net new dependencies: 3 extension families** (table, drag-handle-react, bubble-menu) — all
first-party `@tiptap/*` packages on the same major version (3.x) as everything already installed, so
no version-skew risk. **Net new custom nodes: 2** (Callout, Tag). Everything else is reuse or a
content swap.

> **Deliberately NOT added (keeps bug surface + scope down):** no community block-suite mega-package
> (couples us to one vendor's opinionated schema and Markdown), no columns/multi-column (P1), no
> frontmatter/properties node (P1), no graph/canvas (hard non-goal). Minimal delta means *resisting*
> extensions as much as adding them.

---

## Screen map

```
┌──────────────────────────────────────────────────────────────────────────┐
│  NotesPage                                                                 │
│ ┌───────────────┐ ┌──────────────────────────────┐ ┌────────────────────┐ │
│ │ NotesTreePanel│ │     NotesEditorPanel         │ │  BacklinksPanel    │ │
│ │ (folders/     │ │   → NotesEditor (TipTap)     │ │  (reused, served   │ │
│ │  notes tree,  │ │   ← the core of the core     │ │   from index P1)   │ │
│ │  reused)      │ │                              │ │                    │ │
│ └───────────────┘ └──────────────────────────────┘ └────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────┘
        ▲                                                    ▲
        │                                                    │
   Cmd+K overlay (new, app-level)                    Search results (string + semantic,
   floats over everything                            same overlay surface)
```

The editor column is unchanged structurally — we only enrich what happens *inside* `NotesEditor`.
The tree and backlinks panels are reused untouched (their O(n) backends are a separate, P1 root-cause
fix and out of this UX doc's editor focus).

---

## Wireframe 1 — The editor at rest, and on hover (block affordances)

The empty page stays calm (progressive disclosure — Sam never sees clutter). Affordances appear only
on hover, exactly like Notion.

```
  At rest (nothing hovered):                Hovering a block:

  ┌────────────────────────────────────┐    ┌────────────────────────────────────┐
  │                                    │    │                                    │
  │  Weekly Sync — Q3 planning         │    │  Weekly Sync — Q3 planning         │
  │                                    │    │                                    │
  │  Notes from today's call about     │    │ ⠿ ＋  Notes from today's call abou… │ ← grip + "+"
  │  splitting the data workstream.    │    │  splitting the data workstream.    │   fade in on the
  │                                    │    │                                    │   hovered block's
  │  • action item one                 │    │  • action item one                 │   left gutter
  │  • action item two                 │    │  • action item two                 │
  │                                    │    │                                    │
  └────────────────────────────────────┘    └────────────────────────────────────┘
         ▲ placeholder text only                  ▲ ⠿ = drag handle (grab to move)
           on the empty first line                  ＋ = insert a block below
```

- **`⠿` drag handle** (from `@tiptap/extension-drag-handle-react`): grab → the block lifts and a thin
  blue **drop line** tracks between blocks; release → block moves. Click (no drag) → selects the
  whole block and opens a **block actions menu** (see Wireframe 5).
- **`＋` inserter**: click → opens the *same* slash menu as typing `/`, anchored to this block, and
  inserts the chosen block immediately below. (Reuses the slash portal — one menu, two entry points.)
- Handles live in the **left gutter**, never overlapping text, so they don't disturb typing rhythm.

---

## Wireframe 2 — The slash menu (the day-one win)

Typing `/` (or clicking `＋`) opens an insert-block picker. This is the existing
`SlashCommandPortal` with a new command list — same positioning, same `deleteRange → insertContent`.

```
   …call about splitting the data workstream./tab█
                                              └─ you typed "/tab"
   ┌─────────────────────────────────────────────┐
   │  BLOCKS                            ↑↓ to move │
   │ ──────────────────────────────────────────── │
   │  ▦  Table              Rows & columns, Tab nav│ ◄ filtered to "tab"-matching;
   │ ──────────────────────────────────────────── │   "Table" matches on keyword
   │  (other blocks hidden while query = "tab")    │
   └─────────────────────────────────────────────┘   ⏎ inserts · Esc closes · ⌫ on empty "/" closes

   Full list when query is empty (grouped, keyboard-navigable):
   ┌─────────────────────────────────────────────┐
   │  BASIC                                        │
   │   ¶  Text            Plain paragraph          │
   │   H1 Heading 1       Big section title        │
   │   H2 Heading 2       Medium title             │
   │   H3 Heading 3       Small title              │
   │  TODO/LISTS                                   │
   │   ☑  To-do           Checklist item           │
   │   •  Bulleted list   Simple bullets           │
   │   1. Numbered list   Ordered list             │
   │  BLOCKS                                       │
   │   ❝  Quote           Callout a passage        │
   │   ▦  Table           Rows & columns           │
   │   {} Code            Fenced code w/ language   │
   │   💡 Callout         Highlighted box (icon)    │
   │   —  Divider         Horizontal rule          │
   │   🖼  Image           Upload or paste          │
   │  REFERENCES                                   │
   │   📋 Task reference   Link a Walnut task  ◄────┼─ the ONLY pre-existing entry, preserved
   │   🔗 Link to note     Insert a [[wiki-link]]   │   as one menu item (no behavior lost)
   └─────────────────────────────────────────────┘
```

**Why this feels great:** zero syntax to memorize (Marco's bar), instant filter-as-you-type, and the
existing task-reference path is *preserved as one entry* — we lose nothing, we gain a Notion menu.
The menu lives on machinery already proven in production (`coordsAtPos`, click-outside close,
above/below flip), so positioning quirks are already handled.

---

## Wireframe 3 — Table creation & editing (Notion-style)

`/` → **Table** inserts a starter 3×3 with a header row, cursor in the first cell. Off-the-shelf
`@tiptap/extension-table` gives Tab/Shift-Tab cell traversal and resize for free.

```
  Just inserted (cursor in cell A1, header row shaded):

  ┌──────────────┬──────────────┬──────────────┐
  │ Attendee   █ │ Role         │ Action       │  ← header row (bold, subtle fill)
  ├──────────────┼──────────────┼──────────────┤
  │              │              │              │
  ├──────────────┼──────────────┼──────────────┤
  │              │              │              │
  └──────────────┴──────────────┴──────────────┘
     Tab → next cell   ·   Shift+Tab → prev   ·   Tab in last cell → new row

  On hover over a column boundary / row — controls appear (Notion parity):

         ┌── ⊕ (add column here)
         ▼
  ┌────┬─┴─┬────┐         ◄ ⊕ buttons appear at row/column edges on hover
  │ A1 │ … │ …  │         ◄ select a column header → ▾ menu: Insert left/right,
  ├────┼───┼────┤              Delete column, Toggle header, Align L/C/R
  │    │   │    │  ⊕ ◄ add row
  └────┴───┴────┘

  Selecting cells (drag across) → BubbleMenu adapts to a table context:
  ┌──────────────────────────────────────────────┐
  │  Insert ▸   Delete ▸   Header row   Merge      │   ← cell/row/col ops surface here
  └──────────────────────────────────────────────┘
```

- **Round-trip:** serializes to a standard Markdown pipe table — survives load→edit→save with no
  custom code. (Caveat handled in §"Markdown contracts": block-level content inside a cell, e.g. a
  nested list, has no Markdown pipe-table representation — we constrain cell content to inline +
  soft breaks to guarantee clean round-trips, which matches what Notion-grade tables need anyway.)
- **Time-to-first-table:** `/` → "Table" = 2 actions, well under the ≤3s / ≤2-action bar.

---

## Wireframe 4 — Tag input (`#`) and the floating toolbar

### Typing `#`

`#` at a word boundary opens a tag autocomplete (a *third* instance of the trigger pattern we already
use for `/` and `[[`). Existing tags rank first; a new tag can be created inline.

```
  …we should revisit this in #q█
                              └─ you typed "#q"
   ┌────────────────────────────┐
   │  #q3-planning      12 notes │ ◄ existing tags, by frequency, from the tag index
   │  #q3                 4 notes│
   │  #quick-wins         2 notes│
   │ ────────────────────────── │
   │  ＋ Create tag "#q"         │ ◄ inline-create when nothing matches
   └────────────────────────────┘
      ⏎ accepts · Space/Esc dismisses (the "#text" stays as literal text)

  Accepted → renders as a pill, still plain "#q3-planning" in the Markdown file:

   …we should revisit this in (#q3-planning)        ← pill: rounded, subtle bg, clickable
```

- **Click a tag pill** → opens the search overlay pre-filtered to that tag (Scenario E). Tags are
  first-class and browsable.
- **Round-trip:** the on-disk form is just the literal string `#q3-planning` (see contracts). The
  pill is a *rendering* of inline text, so no information is added to the file — the safest possible
  round-trip and trivially greppable by the string index.

### Selecting text → floating toolbar (BubbleMenu)

```
   You drag-select "split the data workstream":

   …decided to ▒split the data workstream▒ across two pods.
                 ┌───────────────────────────────────────┐
                 │  B  𝑖  S̶  <>  H1 H2  ❝  🔗  •  💡       │ ◄ floats just above the selection
                 └───────────────────────────────────────┘
                    │  │  │   │   └──┴ turn block into heading
                    │  │  │   └ inline code
                    │  │  └ strikethrough
                    │  └ italic
                    └ bold        🔗 = make link · ❝ = quote · • = list · 💡 = callout
```

- Pure off-the-shelf `BubbleMenu`; buttons just call existing marks/commands (`toggleBold`, etc.).
  No new serialization. This is the lowest-effort, highest-felt-quality addition — Marco's "inline
  styling without leaving the keyboard," and it also exposes commands keyboard users hit with
  shortcuts.

---

## Wireframe 5 — Block actions menu (click the grip)

Clicking the `⠿` grip (not dragging) selects the block and opens its actions — the Notion
"right-click a block" affordance, but driven by the off-the-shelf drag handle's click event.

```
  ⠿ �┃ • action item two           ◄ block selected (highlighted)
  ┌─────────────────────────┐
  │  ⌫  Delete               │
  │  ⧉  Duplicate            │
  │  ↕  Turn into        ▸   │──► ¶ Text · H1 · H2 · ☑ To-do · ❝ Quote · {} Code · 💡 Callout
  │  ⤓  Move up / down       │
  └─────────────────────────┘
```

- "Turn into" reuses the same node-conversion commands the slash menu and toolbar use — one set of
  block transforms, three entry points (slash, toolbar, block menu). Minimal-delta = one mechanism,
  many surfaces.

---

## Wireframe 6 — Hybrid search (string + semantic, together)

A single overlay, one result list, **each hit labeled by *why* it matched** so exact hits are never
buried under fuzzy ones (PRD §5, Risk #3). String results come from the existing substring endpoint
(P1: served from a derived index, not an O(n) scan); semantic results come from the embedding store
that **already indexes the notes vault** — we only surface it.

```
  ┌───────────────────────────────────────────────────────────────┐
  │  🔎  split the data workstream                          ⌫  ✕   │
  │ ─────────────────────────────────────────────────────────────│
  │  EXACT MATCHES                                                 │ ◄ string hits FIRST,
  │   📄 Weekly Sync — Q3 planning          · folder: /work        │   never out-ranked by
  │      …decided to ▒split the data workstream▒ across two pods…  │   semantic ("matched text")
  │ ─────────────────────────────────────────────────────────────│
  │  RELATED BY MEANING                                            │ ◄ semantic hits, labeled
  │   📄 Data platform RFC               ~ related   · /work/rfcs  │   so the user trusts ranking
  │      …proposes dividing ingestion vs. analytics ownership…     │
  │   📄 Pod restructure 1:1 notes       ~ related   · /1on1s      │
  │ ─────────────────────────────────────────────────────────────│
  │  #q3-planning  #standup        ◄ tag filters (click to scope)  │
  └───────────────────────────────────────────────────────────────┘
     ↑↓ navigate · ⏎ open · this is the SAME overlay as Cmd+K (one surface, two modes)
```

- **Both modes always run** (no toggle); results are merged, de-duped by note, and **grouped by
  match reason** — the cheapest UX that makes blended ranking trustworthy. A `~ related` badge marks
  semantic-only hits; an inline highlight marks the exact substring.
- Minimal-delta: the *backends already exist* (substring endpoint live today; embedding store live
  and watching `NOTES_DIR`). This screen is a UI that calls both and renders two labeled groups.

---

## Wireframe 7 — Cmd+K quick switcher / quick capture

The same overlay component as search, opened from anywhere, defaulting to **jump-to-note** and
falling back to **create**. Keyboard-only, sub-second (Scenario F).

```
  ┌───────────────────────────────────────────────────────────────┐
  │  ⌘K   weekly sy█                                          ✕    │
  │ ─────────────────────────────────────────────────────────────│
  │  JUMP TO NOTE                                                  │
  │   📄 Weekly Sync — Q3 planning            /work                │ ◄ fuzzy title match,
  │   📄 Weekly review template               /templates           │   recents first
  │ ─────────────────────────────────────────────────────────────│
  │   ＋ Create note "weekly sy"               ⏎                   │ ◄ no match → inline create,
  │   ✎ Capture a quick note                   ⌘⏎                  │   lands in a sensible default
  │ ─────────────────────────────────────────────────────────────│
  │   🔎 Search note contents for "weekly sy"  →                   │ ◄ hand off to full search
  └───────────────────────────────────────────────────────────────┘
```

- **Quick capture** (`⌘⏎`): opens a focused empty note instantly — 0 required decisions (no forced
  folder/tag/title), meeting the ≤1.5s / 0-decision newcomer bar.
- Reuses the **search overlay shell** (same component, different default mode) — minimal-delta: we
  build one overlay, use it twice.

---

## Signature UX moves (and *why* each makes editing feel great)

1. **Re-skin, don't rebuild, the slash menu.**
   The single highest leverage move: the engine (trigger detection, range tracking, portal,
   `deleteRange→insertContent`) already exists and works in production. Turning it into a Notion
   insert-block menu is mostly *content* (the command list) plus per-block command dispatch. **Why it
   feels great:** instant, zero-syntax block insertion — Marco's headline expectation — delivered
   with near-zero new bug surface because the risky positioning/lifecycle code is unchanged. *This is
   the day-one shippable win.*

2. **Three surfaces, one set of block transforms.**
   Slash menu, BubbleMenu, and the block-actions "Turn into" all call the **same** node-conversion
   commands. **Why it feels great:** the editor behaves *consistently* no matter how you reach for a
   transform — and for us it means one tested code path, not three. Consistency is felt as polish;
   single-path is felt (later) as fewer bugs.

3. **Buy the hard interactions (tables, drag, toolbar) off the shelf.**
   Cell selection, drag-to-reorder with a drop indicator, and toolbar auto-positioning are exactly
   the things our own hand-rolled list code (`tryJoinPreviousListAndSink`, `detachListItemChildren`,
   the ArrowUp fix) proves are *easy to get subtly wrong*. **Why it feels great:** mature packages
   have already absorbed years of ProseMirror edge-case fixes, so dragging and tabbing *just work* —
   and our scarce engineering attention stays on the #1 priority (overall editing quality and clean
   Markdown) instead of re-deriving solved problems.

4. **The `#` tag is the `[[` pattern wearing a different hat.**
   We already shipped the trigger-autocomplete-insert pattern twice (slash, wiki-link). Tags are a
   third instance. **Why it feels great:** tagging is as fluid as wiki-linking (same muscle memory),
   and because the on-disk form is just literal `#text`, tags are greppable by the existing string
   search with *zero* new serialization risk.

5. **Progressive disclosure keeps the page calm.**
   Grip, `＋`, and toolbar appear only on hover/selection; the empty note shows only placeholder text.
   **Why it feels great:** Sam (newcomer) is never overwhelmed, while Marco's power affordances are
   one hover away — the same surface serves all three personas without modes or settings.

6. **One overlay = search + quick-switcher + capture.**
   `Cmd+K` and notes-search are the *same component* in two default modes. **Why it feels great:**
   one consistent "command surface" for getting into, finding, and creating notes — and one thing to
   build, test, and keep bug-free.

7. **Labeled hybrid results make blended ranking trustworthy.**
   Exact (string) hits are grouped *above* "related by meaning" (semantic) hits, each badged with
   *why* it matched. **Why it feels great:** users instantly trust the list ("there's my exact
   phrase, and here are the fuzzy ones below") — solving the #1 search-trust risk with a pure UX
   move, no ranking-algorithm gamble.

---

## Interaction details (the contracts)

### On `/`
- **Trigger:** `/` at line start or after whitespace, no space between `/` and cursor — *the existing
  `findSlashTrigger` rule, unchanged.*
- **Open:** floating block picker at the `/` position (reuses `coordsAtPos`, above-or-below flip).
- **Filter:** characters after `/` filter the block list live by name + keyword (e.g. `tab`→Table).
- **Navigate:** `↑/↓` move selection, `⏎`/click insert, `Esc` or `⌫`-on-empty-`/` closes.
- **Insert:** chosen block → `editor.chain().focus().deleteRange(range).<setBlockCommand>().run()` —
  the slash query text is removed and the real block appears in its place, cursor placed sensibly
  (e.g. first table cell, or inside the new heading).
- **Preserved entry:** "Task reference" remains one menu item invoking today's task-search sub-panel;
  "Link to note" invokes the wiki-link flow. *No existing capability is removed.*

### On hover over a block
- After a short hover, the **`⠿` grip** and **`＋` inserter** fade into the left gutter of that block
  (off-the-shelf drag-handle component decides the active block by cursor position).
- **`＋`** opens the slash menu anchored to insert *below* this block.
- Hover affordances never shift text or change layout (they occupy the existing gutter), so typing
  rhythm is undisturbed.

### On selecting text
- A non-empty selection within a single block surfaces the **BubbleMenu** just above the selection.
- Buttons toggle existing marks/blocks: bold / italic / strike / inline code / H1–H3 / quote /
  list / make-link / callout. Toolbar hides on collapse, Esc, or scroll.
- In a **table**, a cell/multi-cell selection swaps the toolbar to table ops (insert/delete row+col,
  toggle header, align) — same component, context-aware contents.

### On typing `#`
- **Trigger:** `#` at a word boundary (line start or after whitespace) — same boundary rule family as
  `[[`, implemented as a new `Plugin` mirroring `WikiLinkExtension`.
- **Autocomplete:** existing tags ranked by frequency (from the tag index, P1; until then, from tags
  seen in the open vault), plus an inline **Create tag** row.
- **Accept:** `⏎`/click inserts the tag; it renders as a pill but the document/file stores literal
  `#tag` text. **Space/Esc** dismisses and leaves `#text` as ordinary text (never traps the user).
- **Click a pill:** opens the search overlay scoped to that tag.

### On `[[`
- **Unchanged.** Existing `WikiLinkExtension` + `WikiLinkAutocomplete`: detect `[[`, autocomplete note
  titles, insert `[[name]]`, create-on-miss + navigate. (Stable-identity link resolution is the P1
  root-cause fix tracked elsewhere; this UX doc does not alter the `[[` interaction.)

### On `Cmd+K`
- Opens the command overlay anywhere in the app (app-level key handler, not an editor extension), in
  **jump-to-note** mode: fuzzy title match over notes, recents first.
- `⏎` opens the highlighted note; if nothing matches, **Create note "<query>"**; `⌘⏎` = **quick
  capture** (focused empty note, no required metadata); a row hands off to **full content search**
  (string + semantic) — the *same overlay component*, switched to search mode.
- `Esc` closes; focus returns to where the user was.

---

## Markdown round-trip contracts (where the only new serialization risk lives)

Per PRD Risk #2, every block must survive load→edit→save with **zero spurious diffs**. Standard
blocks inherit prosemirror-markdown's serializers and are low-risk. The two custom nodes need a
*frozen, defined* on-disk form:

| Block | On-disk Markdown (proposed, defined & frozen) | Why this form |
|---|---|---|
| Heading / quote / code / divider / lists / todo | StarterKit + `tiptap-markdown` defaults (`#`, `>`, ```` ``` ````, `---`, `-`, `1.`, `- [ ]`) | already round-trips today; **don't touch** |
| Table | standard pipe table (`\| a \| b \|` + `\|---\|---\|`) | native to prosemirror-markdown; cell content **constrained to inline + soft breaks** (no block children) to guarantee clean round-trips |
| **Tag** | literal inline text `#tag-name` (no wrapper) | greppable by string index; nothing added to file → safest possible round-trip; pill is render-only |
| **Callout** | a blockquote variant with a leading marker, e.g. `> [!note] …` (the widely-used "admonition" convention) | a *blockquote* base round-trips through existing serializers; the `[!type]` marker is the only custom parse/serialize rule — a single, testable extension point |

> **Acceptance gate (from PRD):** a fixed corpus of representative notes must round-trip with 0
> diffs. The custom Callout serializer is the one place to invest test effort; everything else rides
> on already-proven serializers. Minimal-delta = **minimal new serialization = minimal round-trip
> risk.**

---

## Shipping order (each step independently valuable, smallest first)

```
  Step 0  Slash menu content swap → real insert-block menu (heading/list/quote/code/divider/todo)
          ▸ smallest possible change; reuses the whole existing slash engine
          ▸ ships a Notion feel on day one, BEFORE tables/tags exist
                                   │
  Step 1  BubbleMenu (selection toolbar)  +  drag-handle grip/＋
          ▸ two off-the-shelf extensions; pure UI; no serialization change
                                   │
  Step 2  Tables (off-the-shelf family)  → /Table, Tab nav, row/col ops, pipe-table round-trip
                                   │
  Step 3  #tag node + autocomplete (clone the [[ pattern)  +  Callout node + frozen serializer
          ▸ the only new serialization; gated behind the round-trip acceptance test
                                   │
  Step 4  Hybrid search overlay (string + semantic, labeled groups)  →  reused as Cmd+K + capture
          ▸ backends already exist; this is the UI that surfaces them
```

Each step is shippable on its own and leaves the editor in a working state — so we can stop, ship,
and gather feedback at any boundary without a half-built rewrite sitting in the tree.

---

## Biggest tradeoff

**We inherit other people's design opinions and release cadence in exchange for speed and low bug
surface.** Off-the-shelf extensions (table, drag-handle, bubble-menu) carry their own default
schema, DOM, keymaps, and styling assumptions — which means (a) some visual/behavioral details won't
match a hand-built Notion pixel-for-pixel without CSS/config wrangling, (b) we're exposed to upstream
breaking changes and bugs we can't unilaterally fix on our timeline, and (c) two opinions can collide
(e.g. a generic table's cell-selection keymap vs. our hard-won custom `handleKeyDown` Tab/ArrowUp
logic for task lists — they must be reconciled so Tab does the right thing in a list vs. in a table).

This is the right trade *for this angle and this product*: editing quality is #1, and the fastest way
to a high-quality, low-jank editor is to **not** re-implement table cell selection, drag reordering,
and toolbar positioning — the exact ProseMirror surfaces our existing custom list code shows are
error-prone. We accept "very good and shipped, with a few rough edges to polish via CSS/config" over
"theoretically perfect and months away, with a large surface of our own new bugs." The escape hatch:
the **two genuinely bespoke needs** (Callout, Tag) are where we *do* build custom — so where our
product is differentiated we own it, and where the problem is generic we buy it. If an upstream
extension ever blocks the editing-quality bar, the same trigger/portal pattern we already own is the
fallback to bring that one piece in-house.
```
