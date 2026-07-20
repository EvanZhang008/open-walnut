# Approach B — "Find-First Workspace": Information Architecture as the Editor's Scaffolding

> **UX exploration — design only.** No implementation code. ASCII wireframes, interaction specs, data-model
> sketches, and API contracts only. The editing experience remains priority #1; this exploration argues that a
> great editor is only *felt* as great when the surrounding workspace makes every note **trivial to reach, place,
> relate, and re-find** — so the writer never leaves the keyboard and never loses a thought.

---

## Executive Summary

- **Problem (IA-shaped).** Today a note lives in a flat folder tree, is found only by O(n) substring scan, links
  resolve by fragile basename, and there is no way to *jump* to a note or *capture* a thought without first
  navigating the left rail to `/notes`, opening the tree, and clicking. Capture has friction and recall is weak —
  so even a perfect editor would feel marooned on an island you can't quickly get to.
- **What we'll build (the fix).** A **find-first workspace shell** around the existing editor: one **Cmd+K command
  bar** that unifies *jump-to-note + capture + hybrid search + block actions*; a **three-zone shell** (Rail → Tree →
  Editor → optional Context dock) where every navigation surface is fed by *rebuildable indexes* instead of vault
  scans; **tags as a first-class navigation axis** that compose with folders and search; and a **Relations dock**
  that shows backlinks + linked tasks/memory next to the note — turning the vault from a pile of files into a
  *navigable graph you query, not crawl*.
- **Simplest first step.** Ship **Cmd+K with two tabs only**: "Go to note" (fuzzy title jump over the existing
  `/list` endpoint) and "New note" (inline capture into a default folder). Zero index work, zero editor risk — it
  immediately removes the #1 friction (getting *into* a note) and becomes the home for search/blocks later.
- **User-visible outcome.** You hit `Cmd+K` from anywhere, type four characters of a half-remembered title, and you're
  typing in that note in under a second — or you type a vague *idea* and semantic search surfaces it — or you type
  `>` and run a block action — or you just start writing and it's captured. Tags, folders, and search stop being
  three separate things and become one **findable system**.
- **Definition of done (user's words).** "All the good features and no bug," "super easy to use." The IA bar:
  *anything you ever wrote is at most one keystroke (`Cmd+K`) and one vague phrase away*, and navigation never
  re-reads the whole vault.

---

## One-line thesis

> **Make the workspace a single queryable system — one command bar (Cmd+K) over tags + folders + backlinks +
> hybrid search — so the exceptional editor is always one keystroke away and every note you write is permanently,
> effortlessly findable.**

---

## 1. Why an IA-first lens serves the editing experience (not a distraction from it)

The user is explicit: the *editing experience* is the core of the core. So why lead with information architecture?

**Because the editor's quality is only *experienced* through the IA around it.** A writer's real loop is not "type
in one open document forever." It is: *capture a thought → keep writing → jump to a related note → drop a link →
come back → find it again in three weeks.* Every arrow in that loop is an IA operation. If any arrow has friction —
if jumping to a note means mousing to the rail and crawling a tree, if finding it means a substring scan that misses
your phrasing — the writer **stops trusting the tool and writes elsewhere.** A beautiful editor you can't quickly
reach is a beautiful room at the end of a long hallway.

So this exploration treats IA as **the editor's delivery mechanism**: the shell exists to put a focused, full-width
editor one keystroke away and to make the *output* of editing (links, tags, structure) immediately navigable. Every
IA decision below is justified by "does this let the writer stay in flow and never lose a note?"

**Three IA truths grounded in the current code that shape this design:**

1. The semantic notes index is already organized by a **PARA-style taxonomy** — `Areas/ Projects/ Resources/
   Archive/` — with per-folder relevance weights (`note_areas`, `note_projects`, … from `memory-search.ts`). The
   *index already believes* in this top-level structure. We make that structure **visible and navigable** in the UI
   rather than inventing a parallel one. Folders below those four are free-form.
2. Search, backlinks, and move are **O(n) full-vault scans today** (`getAllMdFiles` then read-every-file). The IA
   cannot scale on scans. **Every navigation surface in this design reads from a rebuildable sidecar index**, never
   the raw vault, per the source-of-truth principle (files master; index derived).
3. Wikilinks resolve by **basename**, so navigation breaks on same-name collisions and rename. The shell's
   navigation (backlinks, link-following, Cmd+K jump) is designed to ride on a **stable note identity** the moment
   it lands (PRD P1), and degrades gracefully to basename until then.

---

## 2. The workspace shell — three zones + a floating command bar

The single most important IA decision: **the editor gets the whole stage; everything else is summonable.** No
permanent clutter around the writing surface. Navigation is either a collapsible rail/tree (for browsing) or the
Cmd+K bar (for jumping) — both get out of the way the instant you're writing.

```
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│ R │  NOTES TREE (Zone 2)        │  EDITOR  (Zone 3 — the stage)              │ CONTEXT DOCK (Z4) │
│ A │  collapsible · index-backed │  full-width, distraction-free              │ collapsible       │
│ I ├─────────────────────────────┼────────────────────────────────────────────┼───────────────────┤
│ L │  🔍 Filter tree…            │   Q3 Planning Sync          ⌫ ⋯  ◧ dock     │ ▸ Outline         │
│   │                             │   ───────────────────────────────────────  │   • Decisions     │
│ • │  ▼ Areas                    │   #standup #q3-planning        ← tag chips   │   • Attendees     │
│ H │    • Team Health            │                                             │   • Action items  │
│ o │  ▼ Projects                 │   We split the data work between…           │                   │
│ m │    • Apollo Launch  ← open  │   ┌───────────────────────────────────┐     │ ▸ Relations       │
│ e │    • Q3 Planning            │   ┊ Decision                          ┊     │   Backlinks (3)   │
│   │  ▸ Resources                │   ┊ Ship behind a flag on Friday.     ┊     │   • Roadmap ›     │
│ • │  ▸ Archive                  │   └───────────────────────────────────┘     │   • Retro ›       │
│ N │                             │                                             │   Linked tasks(2) │
│ o │  ── TAGS ──────────         │   | Name   | Role   | Action        |       │   ☐ Wire flag ›   │
│ t │  #q3-planning  12           │   |--------|--------|---------------|       │   Mentions        │
│ e │  #standup       8           │   | Riya   | Eng    | data pipeline |       │   • (memory) PARA │
│ s │  #retro         5           │   | Marco  | PM     | comms         |       │                   │
│ • │  + more…                    │                                             │ ▸ Properties      │
│   │                             │   ☐ Wire the feature flag                   │   status: active  │
│ ⌘ │                             │   ☐ Send recap by EOD                       │   updated: 2d ago │
│ K │                             │                                             │                   │
└───┴─────────────────────────────┴────────────────────────────────────────────┴───────────────────┘
   ▲ Zone 1: icon rail (existing Sidebar.tsx — Notes is already a peer of Tasks/Sessions/Memory)
                                                            ⌘K opens the command bar over ANY zone, from ANY page
```

**Zone responsibilities (each is an IA promise):**

| Zone | Role | Fed by | Collapse behavior |
|---|---|---|---|
| **1 — Rail** | Cross-app nav (Home/Tasks/Sessions/Memory/**Notes**). *Already exists* (`Sidebar.tsx`). | static | Existing collapse |
| **2 — Tree** | *Browse* the vault: PARA top level + free folders, plus a **Tags** section as a second navigation axis. | tree index + tag index | Hides → editor goes full-bleed |
| **3 — Editor** | The stage. Block editor. Title + tag chips + breadcrumb. | the note file | Always present; can go full-width |
| **4 — Context dock** | *Relate*: Outline, **Relations** (backlinks + linked tasks/memory), Properties. | link/backlink index + task/memory bus | Hidden by default on narrow screens |

**Signature move — the editor is the only thing that's always there.** Zones 2 and 4 are *summonable surfaces*.
A writer in flow collapses both (`Cmd+\` toggles the tree, `Cmd+.` toggles the dock) and types on a clean,
centered column. The IA never costs the writer screen real estate they didn't ask for. This is the difference
between "an editor inside a file manager" and "an editor with a file manager available."

---

## 3. The keystone: one Cmd+K command bar (jump · capture · search · act)

This is the heart of the IA-first approach. **One surface, four modes, mode-switched by the first character** —
so the writer never has to remember which palette does what. It is reachable from *any page in the app*, not just
`/notes`, which is what makes capture and recall feel ambient rather than destination-bound.

```
                       (press ⌘K anywhere)
   ┌──────────────────────────────────────────────────────────────────────────┐
   │  ⌘K   q3 plan|                                                     [esc]   │
   ├──────────────────────────────────────────────────────────────────────────┤
   │  Mode is chosen by what you type:                                          │
   │     (plain text) → JUMP + SEARCH    │   >  → block / page ACTIONS          │
   │     #  → filter by TAG              │   +  → NEW note (capture)            │
   ├──────────────────────────────────────────────────────────────────────────┤
   │  JUMP TO NOTE                       (fuzzy title — instant, from index)    │
   │   →  📄 Q3 Planning Sync            Projects ·  edited 2d ago        ↵     │
   │      📄 Q3 Planning — Budget        Projects ·  edited 1w ago              │
   │                                                                            │
   │  SEARCH RESULTS                                  (hybrid: text + meaning)  │
   │   ●text  …we split the **data work** in *Q3 plan*ning sync…  Q3 Planning   │
   │   ◐both  Roadmap — Q3 commitments and staffing…              Roadmap       │
   │   ○idea  Retro: what slipped last quarter…       (related)   Q1 Retro      │
   │                                                                            │
   │  ─────────────────────────────────────────────────────────────────────    │
   │   +  Create note “q3 plan”  →  Projects/                            ⌘↵     │
   └──────────────────────────────────────────────────────────────────────────┘
      ●=exact text   ◐=text+meaning   ○=meaning only   (the legend that builds trust — see §5)
```

**Mode prefixes (the entire mental model fits on one line):**

| You type | Mode | What happens |
|---|---|---|
| `q3 plan` | **Jump + Search** | Top band = fuzzy *title* matches (jump). Below = **hybrid search** hits (string + semantic), labeled by why. `↵` opens the selected; `⌘↵` creates a note with that text as title. |
| `#standup` | **Tag filter** | Live-completes to existing tags; `↵` opens the **tag view** (all notes with that tag). Type `#a #b` to intersect. |
| `> ` | **Action** | Command list scoped to context: *New note, Move note, Rename, Insert table, Toggle dock, Rebuild index, Open in memory…*. The block-insert actions (table/callout/divider) mirror the in-editor slash menu so muscle memory transfers. |
| `+ ` | **Capture** | Everything after `+` becomes a new note's title; `↵` creates it in the default capture folder and drops you into the body. The fastest path from thought → typing. |

**Why this makes editing feel great (not just navigation):**

- **Capture has zero ceremony.** `Cmd+K`, `+`, type a title or nothing, `↵`. You are typing the *body* in under a
  second, from any screen. No folder dialog, no "where should this go" — it lands in a sensible default (Scenario C/F).
  A thought never escapes because the path to record it was too long.
- **Jumping never breaks flow.** Mid-sentence you remember a related note. `Cmd+K`, four characters, `↵`, you're
  there — keyboard only, no mouse, no tree-crawl. Come back with `Cmd+[` (back) or `Cmd+K` again. The editor stays
  the center of gravity.
- **One bar, no decision fatigue.** Notion/Obsidian fragment this into separate "quick switcher," "command palette,"
  and "search." Collapsing them behind first-character routing means the writer builds *one* reflex. Simplicity is
  the feature.

**Keyboard contract (must be airtight — this is a "no-bug" surface):** `↑/↓` move; `↵` open / run; `⌘↵` create;
`Tab` cycle mode bands; `Esc` close (and, if mid-capture with text, offer "discard?" rather than silently dropping —
*no lost notes, ever*); recently-opened notes show on empty query (recency is a first-class signal). Focus returns
to the editor caret exactly where it was on close.

---

## 4. Tags + folders + backlinks compose into one findable system

The PRD lists tags, folders, search, and backlinks as separate P0/P1 items. The IA-first move is to **make them one
coherent retrieval system with three complementary axes**, so the writer can find a note by *where it lives*, *what
it's about*, or *what it connects to* — and combine them.

```
                         ┌──────────────────────────────────────────┐
   FIND A NOTE BY…       │  Axis 1: PLACE     →  Folder tree (PARA)  │
                         │  Axis 2: TOPIC     →  #tags (cross-cut)   │
                         │  Axis 3: RELATION  →  links / backlinks   │
                         └─────────────────────┬────────────────────┘
                                               │  all three feed, and are
                                               ▼  feedable from, the ⌘K bar
                                   ┌────────────────────────┐
                                   │      ⌘K command bar     │  ← the single front door
                                   └────────────────────────┘
```

- **Place (folders).** The tree's top level is the PARA taxonomy the semantic index already assumes (`Areas /
  Projects / Resources / Archive`); below that, free-form folders. Drag-move in the tree triggers the **move** API,
  which updates the link index *by identity* (not whole-vault regex). Place answers "where did I file it."
- **Topic (tags).** `#tags` are a *cross-cutting* axis — a note in `Projects/Apollo` can carry `#q3-planning` and
  surface in a tag view alongside notes from other folders. Tags live in the editor (inline, autocompleted) **and**
  as a browsable section in the tree (Zone 2) showing tag + count. Topic answers "what is it about, regardless of
  where it lives."
- **Relation (links/backlinks).** `[[wiki-links]]` (forward) and the **Backlinks** list in the Context dock
  (reverse) form the graph. Both are served from the incremental **link/backlink index**, resolved by **stable note
  identity** so they survive rename/move. Relation answers "what connects to this."

**The composition is the point.** In the Cmd+K bar you can type `#q3-planning roadmap` to search the *topic* `#q3-
planning` for the *string/idea* "roadmap." The tag view has its own search box scoped to that tag. Backlinks in the
dock are clickable jumps. No axis is a dead end; each one hands you to the others. This is what turns a folder of
files into a **system you query** rather than a hierarchy you crawl.

### Tag input — inline, in the editor (editing-experience-first)

```
   Type ‘#’ in the editor body:                Tag chips render inline & in the title zone:

   …owned by Riya for the #q|                  #standup  #q3-planning  #data-eng ×
                          ┌──────────────────┐
                          │ #q3-planning  12 │ ← existing tags, by frequency (from tag index)
                          │ #q3-budget     3 │
                          │ #queue          1│
                          │ ─────────────────│
                          │ + create “#q”    │ ← create-new is always the last row
                          └──────────────────┘
   • ‘#’ + chars opens the menu; ↵ or space commits the highlighted tag.
   • Committed tags render as removable chips; in Markdown they persist as plain ‘#tag’ tokens
     (round-trip-clean — the storage contract picks ONE canonical form, frozen in the tech-design doc).
   • Clicking a chip → opens that tag’s view (same surface as ⌘K ‘#’ mode).
```

### Tag view (Scenario E — tag-driven review)

```
   ┌──────────────────────────────────────────────────────────────────────────┐
   │  #q3-planning                          12 notes        [ rename ]  [ ⊕ ]  │
   │  🔍 search within this tag…                                                │
   ├──────────────────────────────────────────────────────────────────────────┤
   │  📄 Q3 Planning Sync          Projects   …split the data work…    2d ago   │
   │  📄 Roadmap                   Projects   …Q3 commitments…         5d ago   │
   │  📄 Budget v2                 Areas      …headcount for Q3…        1w ago   │
   │  …                                                                         │
   ├──────────────────────────────────────────────────────────────────────────┤
   │  Also tagged with:  #standup ·  #retro ·  #data-eng     (related tags)     │
   └──────────────────────────────────────────────────────────────────────────┘
   • Rename ‘#q3-planning’→‘#q3’ updates every note via the tag index (no manual find-replace).
   • ‘⊕’ merges this tag into another. Both are index operations, not vault scans.
```

---

## 5. Search results — hybrid, labeled by *why* (the trust surface)

Search is where IA either earns or loses trust. The user wants **both** string and semantic, working together. The
IA decision: **one ranked list, every result labeled with *why* it matched**, exact matches never buried under
fuzzy ones. The semantic side reuses the engine that already indexes the notes vault (`memoryNotesSearch` over
`getNotesStore`); the string side is served from a derived index, not the current O(n) scan.

```
   ⌘K  noisy neighbor lease|
   ┌──────────────────────────────────────────────────────────────────────────┐
   │  SEARCH                                          12 results · 38 ms        │
   ├──────────────────────────────────────────────────────────────────────────┤
   │  ● text   “…the **noisy neighbor** and the **lease** renewal…”             │
   │           Apartment Notes        Resources ·  #home          ↵            │
   │  ◐ both   “…landlord dispute over quiet hours…”               (text+idea)  │
   │           House Log              Resources                                 │
   │  ○ idea   “…downstairs construction keeps waking the baby…”   (related)    │
   │           Daily Journal 04-12    Areas                                     │
   ├──────────────────────────────────────────────────────────────────────────┤
   │   Filter: [ all ] tag▾  folder▾  edited▾          Sort: relevance ▾        │
   └──────────────────────────────────────────────────────────────────────────┘

   LEGEND  ● exact text  ◐ text + meaning  ○ meaning only       ↑ this legend = the trust mechanism
```

**Why this design earns trust (and prevents the "it didn't find my note" failure):**

- **The badge tells the writer *why*.** `●` exact / `◐` both / `○` meaning-only. When semantic recall surfaces
  something surprising, the `○` badge says "I matched the *idea*, not the words" — so a surprising-but-right hit
  reads as smart, not broken (Scenario C). When the writer typed an exact name, the `●` hit is visibly at top.
- **Exact wins ties, always.** Ranking rule frozen as policy: *any* string/substring hit ranks above a purely-`○`
  hit. Semantic enriches the long tail; it never displaces a literal match. This is the single most important
  ranking guarantee (PRD Risk #3) and it lives in the IA, not in opaque scoring.
- **Filters compose with the axes.** `tag▾ folder▾ edited▾` let the writer narrow by the same three axes (§4), so
  search isn't a fourth silo — it's the union surface where place + topic + recency converge.
- **Served from indexes, not scans.** Sub-300ms first results because the string side reads a derived index and the
  semantic side hits the existing embedding store. No file is re-read on a keystroke.

---

## 6. How notes relate to Walnut tasks & memory (the butler advantage)

Walnut is not just a notes app — it's a butler with **tasks** (the atom) and **memory**. The IA-first move is to
make notes a **first-class citizen of that graph**, surfaced *in the editor's context dock* so relations are visible
while you write — without cluttering the page.

```
   CONTEXT DOCK ▸ Relations                          (all index-/bus-served, never a vault scan)
   ┌───────────────────────────────────────────┐
   │ ▾ Backlinks (3)                             │   ← notes that [[link]] here (reverse link index)
   │    • Roadmap            …see [[Q3 Sync]]…  ›│
   │    • Q1 Retro           …carried into…     ›│
   │ ▾ Linked tasks (2)                          │   ← /tasks/ links in this note → live task state
   │    ☐ Wire the feature flag       in-prog   ›│       (status badge stays live via event bus)
   │    ☑ Send recap by EOD           done      ›│
   │ ▾ Mentions in memory (1)                    │   ← semantic neighbors from the MEMORY store
   │    • PARA method overview      (related)   ›│       (cross-store recall — notes ↔ memory)
   └───────────────────────────────────────────┘
```

- **Notes ↔ tasks (bidirectional).** A note can `[[link]]` or `/tasks/`-reference a task (the editor already SPA-
  routes `/tasks/` links via `TaskAwareLink`). The dock lists those tasks with **live status** from the event bus —
  so a meeting note shows whether its action items are done, *in the note*. Conversely, a task can show "mentioned
  in notes." This is the butler differentiator: notes and tasks are one fabric, not two apps.
- **Notes ↔ memory (semantic bridge).** Both the notes vault and the memory store are indexed in the **same**
  embedding engine. "Mentions in memory" surfaces semantically-near memory entries beside the note — and notes
  appear in memory recall too. The writer's long-term knowledge and their working notes cross-pollinate
  automatically (no manual linking).
- **The butler can land in the right place.** Because capture (Cmd+K `+`) and the default-folder convention are
  explicit IA, the AI butler writing a note directly drops it into the same structure the human browses — one
  vault, one set of indexes, no special-case "agent notes" silo. The watcher re-indexes it; it's instantly findable.

---

## 7. Editor + block affordances (the stage, kept clean)

The shell exists to deliver *this*. The editor surface itself stays minimal until the writer asks for more. Block
affordances appear on hover/`/`, never as permanent chrome — progressive disclosure is the IA discipline that keeps
the stage clean.

```
   ┌────────────────────────────────────────────────────────────────────────┐
   │                                                                          │
   │  ⠿ ⊕   ## Decisions                          ← hover any block: grip(⠿)  │
   │        │                                        + insert(⊕) fade in at   │
   │  ⠿ ⊕   We agreed to ship behind a flag.         the left margin only     │
   │        ▲ drag the grip to reorder · click grip → block menu              │
   │                                                                          │
   │  ⠿ ⊕   ┌──────────────────────────────────┐                             │
   │        ┊ 💡 Callout                        ┊  ← /callout or block menu   │
   │        ┊ Decision owner: Marco.            ┊                             │
   │        └──────────────────────────────────┘                             │
   └────────────────────────────────────────────────────────────────────────┘

   SELECT TEXT → floating toolbar (appears above the selection, follows it):
        ┌─────────────────────────────────────────────┐
        │  B  I  S  </>   H1 H2 H3   “ ”   🔗   #tag   │
        └─────────────────────────────────────────────┘

   TYPE ‘/’ on an empty line → Notion-style INSERT-BLOCK menu (filterable):
        ┌────────────────────────────┐
        │ /tab|                       │
        │  ▸ Table            ⌗       │   ← arrow keys + ↵; type to filter
        │  ▸ To-do list       ☐       │
        │  ▸ Tabbed … (n/a)           │
        │  ── reference ──            │
        │  ▸ Link a task   /task →    │   ← the EXISTING task-search path, preserved as one entry
        └────────────────────────────┘
```

### Table editing (Notion-style, P0)

```
   /table → choose size →                Editing a cell:
   ┌─────────┬─────────┬─────────┐       • Tab → next cell (creates a row past the last cell)
   │ Name ▾  │ Role ▾  │ Action ▾│ ← hdr • Shift+Tab → previous cell
   ├─────────┼─────────┼─────────┤       • Hover a column edge → ⊕ to insert col; ⠿ handle to drag/del
   │ Riya    │ Eng     │ pipeline│       • Hover a row edge   → ⊕ to insert row; ⠿ handle to drag/del
   │ Marco   │ PM      │ comms   │       • Enter in last row + Tab → appends a row (never lose data)
   ├─────────┼─────────┼─────────┤
   │  ⊕ add row                  │       Round-trips to a GitHub-flavored Markdown table on disk.
   └─────────────────────────────┘
```

The interaction grammar is shared on purpose: **the grip (`⠿`), the insert (`⊕`), the slash menu, and the Cmd+K
`>` actions all speak the same verbs** (insert / move / turn-into / delete). One vocabulary across the whole
workspace is what makes it feel "super easy to use." (Detailed editor-internal interactions are the same across all
explorations; this approach's distinct contribution is the *shell and IA around them*.)

---

## 8. Interaction details (the exact spec asked for)

| Trigger | What happens | Why (IA rationale) |
|---|---|---|
| **`/` (on empty line / start of block)** | Notion-style **insert-block** menu opens at the caret: H1/H2/H3, bullet, numbered, to-do, quote, divider, code, callout, **table**, image. Type to filter; `↑/↓`+`↵` to insert; `Esc` closes. A `── reference ──` group preserves the existing `/task` link-a-task path as one entry. | Keeps creation on the keyboard; reuses the slash mechanism that already exists, repurposed from "task search only" to "insert blocks." |
| **`/` (mid-text)** | Inserts a literal `/`. The menu only arms at block start / empty line, so prose with slashes ("and/or") never triggers it. | No false positives = trust. |
| **Hover a block** | A **grip (`⠿`)** and an **insert (`⊕`)** fade in *in the left margin only* (never over the text). Grip: drag to reorder, or click for the block menu (turn-into / duplicate / delete / move-to). `⊕`: insert a block below. | Direct manipulation with zero permanent chrome — the stage stays clean (progressive disclosure). |
| **Select text** | A **floating toolbar** appears just above the selection and tracks it: **B I S `</>`**, H1–H3, quote, link, and a **`#tag`** action. `Esc` or click-away dismisses. | Styling without leaving the keyboard or hunting a fixed menubar; the toolbar comes to the text. |
| **Type `#`** | Inline **tag autocomplete**: existing tags ranked by frequency (from the tag index) + a "create `#…`" row last. `↵`/space commits; committed tags render as removable chips and persist as plain `#tag` in Markdown. Clicking a chip opens that tag's view. | Tags become a *navigation axis* you build while writing, not a separate metadata chore. |
| **Type `[[`** | **Wiki-link autocomplete** (the existing `WikiLinkExtension`) lists notes by title; `↵` inserts `[[Title]]`; "create new" makes the note and links it. Resolution targets **stable identity** (degrading to basename pre-identity). | Linking is the relation axis; identity-based resolution is the root-cause fix for rename/collision (PRD debt). |
| **`Cmd+K` (anywhere in the app)** | The **command bar** opens centered over the current page. Empty = recent notes. Plain text = jump + hybrid search. `#` = tag filter. `>` = actions. `+` = capture. `↵` open/run, `⌘↵` create, `Esc` close (with discard-guard if mid-capture). | The single front door: capture + jump + search + act, reachable from anywhere — ambient, not destination-bound. |
| **`Cmd+\`** | Toggle the **tree** (Zone 2). | Reclaim the stage for writing. |
| **`Cmd+.`** | Toggle the **context dock** (Zone 4). | Relations on demand, hidden in flow. |
| **`Cmd+[` / `Cmd+]`** | Navigate **back / forward** through visited notes. | Jumping (Cmd+K) + back is the core navigation loop; no mouse needed. |
| **Drag a note in the tree** | Calls **move** (rename + re-home); the link/backlink index updates **by identity**, not whole-vault regex; embeddings re-index via the existing watcher. | Reorganizing never orphans a link (Scenario B). |
| **Click a backlink / linked task in the dock** | SPA-navigates to that note/task; back returns you. Task badges stay **live** via the event bus. | Relations are navigable jumps, and tasks show live state inside the note. |

---

## 9. Data model & API sketch (design only — no implementation)

Per the source-of-truth principle: **files are master; everything below is a rebuildable sidecar** that can be
deleted and reconstructed from the vault at any time.

```
  ~/.open-walnut/notes/                       ← MASTER (markdown vault, git-friendly)
     Areas/ Projects/ Resources/ Archive/…    ← PARA top level (the semantic index already assumes this)
     <free folders>/…
     images/

  ~/.open-walnut/notes/.index/                ← SIDECAR (derived, rebuildable, never the source of truth)
     notes.sqlite  ──┬─ note(id, path, title, mtime, …)      ← stable identity ↔ current path
                     ├─ link(src_id, dst_id, raw_target)     ← forward links  → backlinks = reverse query
                     ├─ tag(note_id, tag)                    ← tag index (counts, rename, merge)
                     └─ fts(note_id, text)                   ← string/substring (replaces O(n) scan)
  (semantic) existing QMD notes store via getNotesStore() + qmd-watcher.ts  ← already indexes the vault
```

**Navigation/search API contracts the shell depends on (shapes, not code):**

```
  GET  /api/notes-v2/tree                         → folders + notes (existing; now index-backed, not scan)
  GET  /api/notes-v2/search?q=&mode=hybrid        → [{ noteId, path, title, snippet, match: 'text'|'both'|'idea',
       &tag=&folder=&edited=&limit=                   score }]   (string from FTS + semantic from QMD, merged,
                                                                  exact-wins-ties; replaces O(n) substring scan)
  GET  /api/notes-v2/jump?q=                       → fuzzy TITLE matches for ⌘K jump band (cheap, index/title-only)
  GET  /api/notes-v2/backlinks/:noteId             → reverse link query on the index (replaces O(n) regex scan)
  GET  /api/notes-v2/tags                          → [{ tag, count }]  (tree Tags section + ‘#’ autocomplete)
  GET  /api/notes-v2/tags/:tag                     → notes carrying tag (+ related tags)  (tag view)
  POST /api/notes-v2/tags/rename | /merge          → index op (no vault find-replace)
  POST /api/notes-v2/move                           → re-home; link index updates by IDENTITY (existing endpoint,
                                                       upgraded from whole-vault regex rewrite)
  POST /api/notes-v2/index/rebuild                  → blow away & rebuild all sidecars from files (the safety valve)
```

**Identity (the root-cause fix the whole navigation rides on):** every note gets a **stable id** (e.g. a short id
persisted in frontmatter, or a content-addressed id mapped in `notes.sqlite`). Links resolve id→path through the
index. Rename/move updates the *mapping*, not the text of every `[[…]]` across the vault. Backlinks become a reverse
index lookup, not a regex crawl. This single change retires three O(n) hot paths (search, backlinks, move) and the
basename-collision class of bugs — *one systemic fix, not three patches.*

---

## 10. Scenario walkthroughs (mapping to the PRD's E2E scenarios)

- **A — Meeting note w/ table + tags (⭐):** `Cmd+K` → `+` → "Q3 Planning Sync" `↵` (in editor, <1s). `/table` →
  fill by Tab. `/callout` for the decision. Type `#standup #q3-planning` (autocompleted from the tag index, become
  chips). Three weeks later: `Cmd+K` → "that planning sync where we split the data work" → `◐/○` hits surface it;
  also `Cmd+K` → "Riya" → `●` exact hit. The result legend shows *why* each matched.
- **B — Reorganize w/o breaking links (⭐):** drag `Apollo Launch` to another folder in the tree → **move** updates
  the link index *by identity*; every `[[…]]` still resolves; the dock's **Backlinks** are instant (reverse index,
  not scan).
- **C — Newcomer brain-dump found by vibe (⭐):** `Cmd+K` → `+` → `↵` (no title even), type freely; lands in the
  default folder. Later `Cmd+K` → a phrase that appears nowhere verbatim → the `○ idea` badge makes the
  semantic-only top hit read as smart, not lucky.
- **D — Restructure with blocks:** hover grips to reorder; floating toolbar to bold/heading/quote; `/` to convert a
  list to a checklist and a snippet to a code block. Clean Markdown out.
- **E — Tag-driven review:** click `#q3-planning` chip → tag view lists every tagged note + related tags; rename to
  `#q3` once (index op). Assemble the weekly review by jumping between them.
- **F — Quick switcher / capture from anywhere:** the entire reason Cmd+K is global. From `/tasks` or `/sessions`,
  `Cmd+K` jumps into a note or captures a new one without first navigating to `/notes`.

---

## 11. Biggest tradeoff of this approach

**We invest first in the *workspace shell and indexes* (Cmd+K, the three-zone layout, the tag/link/FTS sidecars,
stable identity) — which means the most visible early work is *around* the editor, not *inside* it.** The risk is
optics and sequencing: a reviewer who opens the app on day one sees a command bar and a nicer tree, but the *table*
and *drag handle* — the things the user pointed at as "the core of the core" — could appear to lag if we let the IA
scaffolding consume the schedule.

We accept this tradeoff because the shell is *cheap at the front and compounding*: the **simplest first step
(Cmd+K with just Jump + Capture) is a few days, zero editor risk, and immediately removes the #1 friction** of
getting into a note — and it becomes the permanent home that *search and block-actions plug into later*. But we
**hard-guard the editing-first priority** so the IA never starves the editor:

1. **Editor blocks (table, slash-insert, drag handle, floating toolbar) and the Cmd+K *Jump+Capture* core ship in
   the same first milestone.** The IA front door and the first real editing wins land *together*, so the writer
   never experiences "great navigation, weak editor."
2. **Indexes are introduced behind the *existing* endpoints** (search/backlinks/move keep working on the O(n) path
   until the sidecar is proven equal-or-better against a corpus). Navigation correctness is never gated on new
   infrastructure — the IA upgrade is invisible and reversible (`/index/rebuild` is the safety valve).
3. **The dock and tags ship after the editor feels right**, exactly as the PRD sequences identity/index at P1 —
   but the *Cmd+K front door* is pulled forward to P0 because it is what makes the editor feel *reachable*, which is
   itself an editing-experience property.

**The honest cost:** more moving parts than a pure editor-only push (a command bar, a context dock, a SQLite
sidecar, an identity scheme), and a strict discipline required to keep the shell from stealing focus from the table
and the grip. The bet is that *findability is what makes an editor feel like a second brain rather than a text box*
— and that the user's "super easy to use" bar is met not by the editor alone but by *never having to think about
where a note is or how to get back to it.*
