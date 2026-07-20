# Notes / PKM Redesign — Consolidated UX Decision

> **Status:** UX direction decided. This document selects the winning approach, scores all three,
> grafts the best ideas from the runners-up, and freezes the interaction specs that the technical
> design doc will build against. **No implementation code here** — interaction contracts, wireframe
> references, and decisions only.
>
> **Inputs:** `01-product-design.md` (PRD) + `ux-explorations/approach-a.md` (Editing-Feel-First),
> `approach-b.md` (Find-First Workspace), `approach-c.md` (Minimal-Delta / Ship-Fast).
>
> **Unmovable rule (from the PRD):** the editing experience is the core of the core. Every tradeoff
> below resolves in favor of editing quality and the "no bug" bar.

> **⚠️ Superseded where it conflicts (post-Round-2 reconciliation):** `02-technical-design.md` is the
> **reconciling authority** for cross-cutting P-levels and contracts. Where this UX doc and the tech
> design disagree, the tech design wins. Three items were reconciled after this doc was first frozen and
> are corrected inline below so an implementer reading this doc does not build the wrong scope:
> - **Cmd+K Jump+Capture is P1** (early-pull candidate pending explicit user sign-off), **not P0** — see
>   tech §9.3/§14/§15. (This doc originally proposed pulling it to P0; that promotion is withdrawn.)
> - **The relations / context dock is deferred (post-v1, P1+)**, not part of this effort's v1 — see tech
>   §18. It is **not** a permanent non-goal like canvas/graph; it is a roadmap item, but out of v1.
> - **Tables: the header row is always on (no "toggle header off"), and cells are inline + HARD-break
>   (`<br>`) only** — a soft break is not representable in a GFM cell. See tech §6.1, which owns a custom
>   GFM table serializer. Drop "toggle header" from the column controls below.

---

## 1. Decision in one line

**We ship Approach C (Minimal-Delta / "Assemble a Notion, don't build one") as the spine — buy the
hard, bug-prone interactions (table, drag-handle, bubble-menu) off the shelf and re-skin the slash /
`[[` machinery we already own — and we graft onto it (a) Approach A's gesture-level "feel" contracts
so the bought parts are tuned, not just dropped in, and (b) Approach B's IA backbone: Cmd+K as a
global front door, the "why it matched" hybrid-search trust legend, and stable note identity as the
root-cause fix for rename + O(n) backlinks.**

---

## 2. Why C wins (grounded in the code, not vibes)

The PRD's #1 priority is editing quality with a hard "no data loss / no jank / byte-clean Markdown"
bar, and an explicit warning (Risk #1) that the editor already carries delicate hand-rolled logic
that new blocks can break. C is the approach whose entire thesis is *minimize new bug surface against
that exact risk* — and its feasibility claims check out against the real source:

- The slash engine is already the Notion insert-block flow. `SlashCommandExtension.ts`
  (`findSlashTrigger` → tracked `range {from,to}` → `{phase:'commands', range, query}`) plus
  `SlashCommandPortal.tsx` doing `.deleteRange(range).insertContent([...])` at `coordsAtPos(range.from)`
  is *literally* "delete the `/query`, drop a block at the caret." `NOTE_SLASH_COMMANDS` in
  `slash-commands/types.ts` really is a single `task` entry — so "swap the list, add command dispatch"
  is a true one-file content swap, shippable day one before any new dependency.
- The trigger pattern is already proven twice. `WikiLinkExtension.ts` (`[[`) is the same
  detect → range → autocomplete shape; `#tag` is a third instance of code we've already written and
  shipped, not a novel mechanism.
- The off-the-shelf parts exist and are version-safe. `@tiptap/extension-table`,
  `@tiptap/extension-drag-handle-react`, `@tiptap/extension-bubble-menu` are first-party `@tiptap/*`
  packages published on the same 3.x major (3.26.x available; we run 3.20.1) as the StarterKit, task-list,
  image, and `tiptap-markdown` packages already installed — no version-skew risk.
- The risk the PRD names is the risk C is built to dodge. `NotesEditor.tsx` (609 LOC) carries
  `TightTaskList`, `tryJoinPreviousListAndSink`, `detachListItemChildren`, a custom `handleKeyDown`
  (Tab indent/detach + ArrowUp nesting fix), and the `isSourceRef` save-sync loop guard with
  cursor/scroll restore. Hand-rolling table cell-selection and drag-reorder on top of this is exactly
  where new ProseMirror bugs would breed. Buying those keeps our scarce attention on Markdown
  round-trip fidelity and the personas' felt quality.

A and B are not wrong — they are **the right specs at the wrong layer to be the spine.** A is a
gesture/feel design (the *how it should feel* layer) and B is an IA/workspace design (the *how you
reach and re-find it* layer). Neither answers "what is the lowest-bug-surface way to get real blocks
into the editor by next week." C does, and A/B then make C excellent. So C is the chassis; A and B are
the tuning and the chassis-mounts to the rest of Walnut.

### One honest caveat we accept with C

We inherit upstream design opinions, keymaps, and release cadence. Concretely, a generic table's Tab
cell-nav keymap will collide with our custom `handleKeyDown` Tab list-indent/detach logic. This is a
real correctness hazard (A and C both flag it). We accept it because the fix is bounded and one-time
(see §6 Table UX: Tab precedence rule), whereas re-implementing tables in-house is an open-ended bug
surface against our #1 priority. Escape hatch: the trigger/portal pattern we already own is the
fallback to bring any single blocking piece in-house.

---

## 3. Scorecard

Weighted: **editing quality is the dominant axis** (per the PRD's "core of the core"); ease-of-use,
feasibility on the existing TipTap base, and PRD fit follow. Scores are 1–5 (5 best).

| Approach | Editing quality (×3) | Ease-of-use (×2) | Feasibility on TipTap base (×2) | Fit with PRD (×1) | Weighted total (/40) |
|---|---|---|---|---|---|
| **C — Minimal-Delta / Ship-Fast** ⭐ | 5 (15) | 4 (8) | 5 (10) | 5 (5) | **38** |
| **A — Editing-Feel-First** | 5 (15) | 5 (10) | 3 (6) | 4 (4) | **35** |
| **B — Find-First Workspace** | 3 (9) | 5 (10) | 3 (6) | 4 (4) | **29** |

**Reading the scores.**

- **Editing quality.** A and C both target a flawless editor; A by hand-crafting gesture feel, C by
  buying battle-tested interactions that thousands of editors already use. Both 5. B explicitly invests
  first in the shell/indexes *around* the editor, so the editor's blocks risk lagging — 3.
- **Ease-of-use.** A and B are 5: A's "keyboard never leaves home row" and B's "one Cmd+K front door,
  one reflex" are both genuinely lower-friction framings. C is 4 — equally easy for the user, but it
  inherits some off-the-shelf interaction details that won't be pixel/keystroke-perfect without
  polish, so it gets docked slightly on felt smoothness until tuned.
- **Feasibility on the existing TipTap base.** C is 5: verified line-by-line — content swap on a live
  engine + 3 first-party same-major extensions + 2 tiny custom nodes. A is 3: its signature
  drag-reorder + floating overlays are "the hardest things to make feel right," and it leans on
  hand-built interaction polish where C buys it. B is 3: the value is gated on SQLite sidecars,
  identity, and a 3-zone shell — more new moving parts than an editor-only push.
- **Fit with PRD.** C maps 1:1 onto the PRD's "we extend, we do not rebuild," its P0 list, its
  shipping-smallest-first ethos, and its Risk #1/#2 mitigations — 5. A and B fit the *intent* but each
  over-rotates on one layer (feel / IA) relative to the PRD's "editor blocks first" sequencing — 4.

---

## 4. Merged feature set (P0 unless noted)

The winner is C's spine with A's feel contracts and B's IA backbone grafted in. P-levels follow the
PRD (editor blocks are P0; the identity/index durability backbone is P1, pulled toward P0 only if
rename breakage blocks power-users in testing).

> **Reconciled (post-Round-2):** this doc originally argued Cmd+K Jump+Capture should be pulled to P0
> ("reachability is an editing-experience property"). A Bar Raiser ruled that inverts the PRD's explicit
> ordering and grows the v1 no-bug surface. **Cmd+K is P1 (early-pull candidate, pending user sign-off)**
> — tech §9.3 holds the line. The table below is corrected to match.

| Feature | Source | How it's built | P |
|---|---|---|---|
| Slash *insert-block* menu (H1–H3, lists, to-do, quote, code, divider, callout, **table**, image, + preserved Task/Note-link entries) | C spine | Re-skin existing `SlashCommandExtension` + `SlashCommandPortal`: swap the one-entry command list for a real block list + per-block `editor.chain()` dispatch. **Day-one win.** | P0 |
| Tables (create, cell edit, Tab nav, add/del row+col, header) | C buys it | `@tiptap/extension-table` family; native GFM pipe-table round-trip | P0 |
| Block drag-handle (`⠿`) + `＋` inserter | C buys it; A/B tune feel | `@tiptap/extension-drag-handle-react`; `＋` opens the *same* slash menu | P0 |
| Floating selection toolbar ("bubble") | C buys it; A tunes feel | `@tiptap/extension-bubble-menu`; buttons call existing marks + shared block transforms | P0 |
| All basic text styles (bold/italic/strike/inline-code/headings/lists/quote/checklist/links) | reuse | StarterKit + `TightTaskList` + `TaskAwareLink`, already tuned | P0 |
| Markdown shortcuts stay on (`# `, `- `, `> `, ` ``` `, `[] `) | A | StarterKit + `tiptap-markdown` already fire these; expert path that produces the *same* blocks as the slash path | P0 |
| `#tag` inline node + frequency-ranked autocomplete | C builds small (A/B specs) | New `TagExtension` cloning the `[[` trigger pattern; renders as a chip, stores literal `#tag` text on disk | P0 |
| Callout + divider blocks | C builds Callout small | Callout = `> [!note]` admonition blockquote (one custom serializer); divider = StarterKit `---` | P0 |
| One set of block transforms, three surfaces | C | Slash menu, bubble "Turn into", and grip block-menu all call the **same** node-conversion commands — one tested path | P0 |
| Hybrid search (string + semantic) with **"why it matched" labels** | C overlay + B trust legend | One overlay; string from substring endpoint (P1: derived index), semantic from the embedding store that **already indexes the vault**; exact-wins-ties guarantee | P0 |
| **Cmd+K global front door** (Jump + Capture; Search + `>` Actions + `#` Tag modes layer in) | B | Same overlay component as search, opened from any page; first-character mode routing | **P1** (early-pull candidate; tech §9.3) |
| Stable note identity + incremental link/backlink + tag + FTS sidecar | B backbone | One SQLite sidecar (id↔path, forward links, tags, FTS); files stay master, index rebuildable | P1 |
| Tag browse/rename/merge view; backlinks-from-index; move-by-identity | B | Index ops, not vault scans | P1 |
| Context dock: backlinks + linked Walnut tasks (live status via event bus) + memory neighbors | B (butler advantage) | Dock beside the editor, collapsible; relations as navigable jumps | **Deferred / post-v1 (P1+)** — out of this effort's v1 (tech §18) |

**Rejected for v1 (kept as hard non-goals / deferred):** community block-suite mega-packages, columns/
multi-column, frontmatter/properties node, canvas/whiteboard, graph view, real-time multiplayer,
proprietary storage — see §7.

---

## 5–10. Key interaction specs (frozen for the tech-design doc)

> Wireframe references: A's doc has the richest moment-by-moment mockups (gutter rail, bubble, table
> Tab model, `#tag` list, hybrid results, Cmd+K). C's doc has the screen map + Markdown round-trip
> contracts. Where they agree, the spec below is the contract; where A is more detailed on *feel*, we
> adopt A's detail on top of C's machinery.

### 5. Slash menu (the day-one win)

- **Trigger (unchanged):** `/` at line start or after whitespace, no space between `/` and caret —
  keep `findSlashTrigger()` verbatim. `/` mid-word (e.g. `a/b`, "and/or") never triggers.
- **Open / position:** floating panel at `coordsAtPos(range.from)`, with the existing above/below flip
  and click-outside close. Reuses `SlashCommandPortal` untouched structurally.
- **Filter:** **fuzzy**, not `startsWith` (upgrade from A: `/cl`→Callout, `/ck`→Checklist must work).
  Grouped: Basic / Lists / Blocks / Reference.
- **Navigate:** capture-phase `↑/↓` move, `↵`/click insert, `Esc` or `⌫`-on-empty-`/` closes, hover
  re-selects, `onMouseDown preventDefault` keeps focus in the editor — all already the pattern in
  `SlashCommandMenu.tsx`.
- **Insert:** `editor.chain().focus().deleteRange(range).<blockCommand>().run()` — the `/query` text is
  deleted (range from the extension), the block lands in its place, caret placed *inside* it (first
  table cell, inside the heading, etc.). **Byte-clean: never leave a trailing space or blank line.**
- **Preserved entries:** "Task reference" (today's task-search sub-panel) and "Link to note" (the `[[`
  flow) survive as menu items — no existing capability is lost.

### 6. Block handle (grip + inserter) and Table UX

**Grip / inserter (left gutter, progressive disclosure — A's feel rules on C's package):**

- After a short hover (~80–120 ms, to avoid flicker on fast pointer sweeps) the `⠿` grip and `＋`
  inserter fade into the gutter of *that block only*, at a fixed left x. They never shift text or
  change layout (they occupy the existing gutter), so typing rhythm is undisturbed.
- `＋` click → opens the slash menu anchored to insert a block *below* the hovered one (one menu, two
  entry points).
- `⠿` click → selects the whole block + opens the block-actions menu (Turn into / Duplicate /
  Delete / Move up·down). "Turn into" calls the **same** transforms as slash + bubble. **"Color" is cut
  from v1** — it has no byte-clean Markdown representation and adds menu noise for zero P0 value.
- `⠿` press-drag → block lifts and a **2 px snap line** marks the nearest gap; drop reorders; `Esc`
  mid-drag cancels and returns the block. Drop must produce clean Markdown (no blank-line litter).

**Table UX (off-the-shelf engine, A's Tab model as the contract):**

- `/table` (or `＋`→Table) inserts a 3×3 with a header row, caret in the first body cell.
- Keyboard model: `Tab` → next cell (wraps to next row's first cell); `Shift+Tab` → previous;
  `↑/↓` → cell above/below; **`Tab` on the last cell appends a new row** and lands in its first cell;
  `Enter` inside a cell → **hard line break (`<br>`)** within the cell (a *soft* break is not
  representable in a GFM cell — tech §6.1).
- Row/column controls on hover (`⋯` column menu / `⋮` row menu): insert above/below or left/right, move,
  delete, **align** (left/center/right, serialized via a cell `align` attr by the owned serializer).
  Cell/multi-cell selection swaps the bubble toolbar to table ops. **No "toggle header off"** — the first
  row is always a header (tech §6.1 forbids header-less tables so the GFM pipe path is always takeable).
- **Tab precedence rule (the one correctness hazard — frozen decision):** the table extension claims
  `Tab`/`Shift+Tab` **only when the selection is inside a table**; outside a table, the existing
  `handleKeyDown` list-indent/detach + ArrowUp logic in `NotesEditor.tsx` is untouched. The tech-design
  doc must wire this precedence explicitly and cover it with a regression test (list-Tab and table-Tab
  in the same document).
- **Round-trip:** standard GFM pipe table via an **owned serializer** (tech §6.1 — the shipped
  tiptap-markdown one drops alignment and HTML-blobs header-less tables); **cell content constrained to
  inline + hard breaks (`<br>`)** (no block children — no nested lists inside a cell) to guarantee
  zero-diff round-trips. This matches what Notion-grade tables need anyway.

### 7. Tag UX (`#`)

- **Trigger:** `#` at line start or after whitespace, **immediately followed by a letter** — `#1` in
  "issue #123" and a lone `# ` heading shortcut do **not** open the tag list (disambiguated by
  requiring a letter + line context). Third instance of the `[[`/`/` trigger shape.
- **Autocomplete:** existing vault tags ranked **by frequency** (steers reuse → `#q3-planning` not
  `#Q3Planning`); a "+ Create `#…`" row is always last. `↵`/click commits; `#word␣` (space) creates a
  new tag inline — no dialog.
- **Render vs. disk:** commits to a styled inline **chip**; on disk it is **literal `#tag` text** (the
  frozen Markdown form) — render-only, nothing added to the file, so it round-trips byte-clean and stays
  greppable by the string index.
- **Backspace into a committed chip** selects the whole chip first (one more `⌫` deletes it) — chips
  never half-delete into broken text.
- **Click a chip** → tag view: every note with that tag, newest first, served from the **tag index**
  (P1), not an O(n) scan. Tag rename/merge are index ops (P1).

### 8. Search UX (hybrid, labeled by why)

- **One box, one ranked, de-duplicated list; both modes always run** (no toggle buried in settings).
- **String/substring:** literal hits, must feel instant; served from a derived index (P1), not the
  current O(n) full-vault re-read.
- **Semantic:** meaning-based recall via the engine that **already indexes the notes vault**
  (`memoryNotesSearch` over `getNotesStore`); the work is UI exposure + blending, not building an index.
- **Trust legend (B's mechanism — the anti-"it didn't find my note" guarantee):** every result is
  badged by *why* it matched — `●` exact text · `◐` text + meaning · `○` meaning-only — and the matched
  span is highlighted in the snippet. **Ranking policy frozen: any string/substring hit ranks above a
  purely-`○` semantic hit. Always. Exact matches are never buried.**
- Filters compose with the IA axes (tag / folder / edited) so search is the union surface, not a fourth
  silo (P1 polish).

### 9. Cmd+K (global front door) — **P1 (early-pull candidate; tech §9.3)**

> **Scope reconciled:** Cmd+K is **P1**, not P0 (see banner at top + tech §9.3). The interaction spec
> below is frozen and ready; it sequences after the P0 editor unless the user explicitly confirms pulling
> it forward. The day-one P0 wins (slash-block menu + expose-existing semantic search) do not depend on it.

- **Scope:** opens centered over **any page in the app** (app-level key handler, not an editor
  extension) — capture and recall are ambient, not stuck on `/notes`.
- **First modes:** two modes — *Jump to note* (fuzzy subsequence title match, recents on empty query)
  and *Create / Quick-capture* (`↵` creates the typed title; `⌘↵` opens a focused empty note with **0
  required decisions** — no forced folder/tag/title; lands in a sensible default).
- **Layered in:** first-character mode routing (B) — plain text = Jump + hybrid Search; `#` = tag
  filter; `>` = block/page Actions (mirroring the in-editor slash verbs so muscle memory transfers);
  `+` = capture.
- **Keyboard contract (airtight — a "no-bug" surface):** `↑/↓` move, `↵` open/run, `⌘↵` create,
  `Esc` close. **If closing mid-capture with text, offer "discard?" — never silently drop a note.**
  Focus returns to the editor caret exactly where it was. The search overlay and Cmd+K are the **same
  component** in two default modes — one thing to build, test, and keep bug-free.

### 10. Cross-cutting "no-jank" contract (non-negotiable, from the PRD + A)

- **No cursor jump on save:** every new block routes through the normal `onUpdate` save path so the
  `isSourceRef` loop guard + cursor/scroll restore in `NotesEditor.tsx` keeps protecting it. New blocks
  must not bypass it.
- **Byte-clean Markdown:** inserting/reordering/turning-into never leaves stray blank lines or escapes.
  The `TightTaskList` saga is the cautionary tale; tables/callouts/tags are held to the same round-trip
  acceptance corpus (PRD Risk #2 — a P0 gate).
- **Smooth on large notes:** hover-rail and bubble are pure DOM overlays driven by current selection/
  hover; they do not re-render the doc, so typing latency is unaffected.
- **Markdown contracts frozen per block:** standard blocks ride prosemirror-markdown serializers;
  Callout = `> [!note]` (custom serialize/parse rule); Tag = literal `#tag`; **tables ride an OWNED GFM
  serializer (tech §6.1) — cells = inline + hard breaks only, first row always header.**

---

## 11. Grafts from the runners-up (explicit ideas pulled into the winner)

**From A — Editing-Feel-First (the gesture/feel layer):**

1. **Markdown shortcuts stay on as the expert path**, producing the *same* blocks/clean Markdown as the
   slash path — so Riya (Markdown) and Marco (WYSIWYG) never fork the data.
2. **Fuzzy slash filtering** (not `startsWith`), so `/cl`→Callout, `/ck`→Checklist.
3. **Gutter-rail feel contracts**: ~80–120 ms hover delay, fixed-x affordances, 2 px snap line on drag,
   `Esc`-cancels-drag, grace zone so moving onto the rail doesn't dismiss it.
4. **Table "Tab is the nervous system" model** (wrap to next row; Tab-on-last-cell appends a row;
   `↑/↓` row-to-row; `Enter` = in-cell **hard break (`<br>`)** — a soft break is not GFM-representable,
   tech §6.1) — the precise keyboard contract for the bought table.
5. **The explicit Tab-precedence rule** between table cell-nav and the existing list-indent/detach logic,
   named as the one correctness hazard to wire and test.
6. **`#tag` disambiguation + chip-backspace** rules (require a letter; whole-chip select before delete).
7. **The hard-won-invariants checklist** (`isSourceRef`, `tryJoinPreviousListAndSink`,
   `detachListItemChildren`, ArrowUp fix) treated as a regression suite before new blocks land.

**From B — Find-First Workspace (the IA/durability backbone):**

8. **Cmd+K as a *global* front door** reachable from any page (not just `/notes`) — Jump+Capture.
   **Reconciled to P1 (early-pull candidate, tech §9.3)**; this doc's original "pull to P0" argument was
   overruled by a Bar Raiser as inverting the PRD's ordering.
9. **First-character mode routing** for Cmd+K (plain = jump+search, `#` = tag, `>` = actions,
   `+` = capture) — one reflex instead of three separate palettes.
10. **The "why it matched" trust legend** (`● ◐ ○`) + the frozen *exact-wins-ties* ranking policy as
    the anti-"it didn't find my note" mechanism — search trust lives in the IA, not in opaque scoring.
11. **Stable note identity + one rebuildable SQLite sidecar** (id↔path, forward links → reverse
    backlinks, tags, FTS) as the *single systemic* root-cause fix that retires three O(n) hot paths
    (search, backlinks, move) and the basename-collision bug class — P1, pulled to P0 if rename
    breakage blocks power-users.
12. **Discard-guard on Cmd+K close mid-capture** — never silently drop a note.
13. **Butler advantage: a relations dock** surfacing backlinks + linked Walnut tasks (live status via
    the event bus) + semantic memory neighbors beside the note — notes become first-class in the
    task/memory graph. **Deferred / post-v1 (P1+) — out of this effort's v1 (tech §18).** It is a
    roadmap item, not a permanent non-goal, but it does not ship in v1.
14. **Shared verb vocabulary** (insert / move / turn-into / delete) across slash menu, grip menu, bubble,
    and Cmd+K `>` actions — one mental model = "super easy to use."

---

## 12. Rejected ideas (and why)

| Rejected | From | Why rejected for v1 |
|---|---|---|
| **Make IA/shell the spine; ship Cmd+K + 3-zone layout + sidecars first** | B (as the lead) | Over-rotates on the layer *around* the editor. The PRD's #1 priority and Risk #1 are about the editor itself; leading with the shell risks "great navigation, weak editor." We keep B's *backbone* but mount it on C's editor-first spine. |
| **Hand-build table cell-selection, drag-reorder, and floating toolbar** | A (implied by its feel-first framing) | Largest new-bug surface against the #1 priority, on exactly the ProseMirror surfaces our existing list code proves are easy to get subtly wrong. C buys these; we hand-tune feel on top. Bring-in-house only if an upstream package blocks the editing-quality bar. |
| **Community block-suite mega-package** | C explicitly resists; restated here | Couples us to one vendor's opinionated schema + Markdown serialization → round-trip risk + lock-in. We add only first-party `@tiptap/*` extensions + 2 tiny custom nodes. |
| **Columns / multi-column blocks** | A non-goal at v1; PRD P1+ | Breadth that's cheap to add *after* the gesture layer is solid; not part of the "few flawless blocks" v1 bet. |
| **Frontmatter / properties node** | PRD P1 | Useful, but not on the editing-experience-first critical path; queues behind the P0 editor + identity. |
| **Synced blocks / toggle lists** | A non-goal at v1 | Extra block types that don't advance the core feel bar; deferred. |
| **Identity by whole-vault `[[name]]` regex rewrite on rename** | current code / naive fix | The root-cause-vs-symptom trap: same-name collisions, churny edits. Rejected in favor of stable identity + index mapping (one systemic fix, not three patches). |
| **Search mode toggle in settings** | implied alternative | The PRD wants BOTH modes together, always. A buried toggle re-introduces an either/or. Both run; results are labeled and exact-wins-ties. |
| **Canvas / whiteboard, graph view, real-time multiplayer, proprietary storage-as-master** | PRD hard non-goals | Out of scope; Markdown on disk stays the source of truth; every index is a rebuildable sidecar. |

---

## 13. Shipping order (smallest-first, each step independently valuable)

Adopts C's sequence, with the identity/index backbone landing right after the editor feels right
(PRD P1). **Cmd+K Jump+Capture is reconciled to P1 (early-pull candidate, tech §9.3) — it is no longer
sequenced alongside Step 0; it lands with/after the search overlay (Step 4) unless the user confirms an
early pull-in.**

```
  Step 0  Slash-menu content swap → real insert-block menu (heading/list/quote/code/divider/todo).
          Reuses the whole existing slash engine. Ships a Notion feel day one, before tables/tags.
                                   │
  Step 1  BubbleMenu (selection toolbar)  +  drag-handle grip/＋   (off-the-shelf; pure UI).
                                   │
  Step 2  Tables (off-the-shelf family) → /Table, Tab nav, row/col ops, pipe-table round-trip,
          and the frozen Tab-precedence rule + regression test.
                                   │
  Step 3  #tag node + autocomplete (clone the [[ pattern)  +  Callout node + frozen serializer.
          The only new serialization — gated behind the 0-diff round-trip acceptance corpus.
                                   │
  Step 4  Hybrid search overlay (string + semantic, ●◐○ labeled, exact-wins-ties). The SAME component
          becomes Cmd+K (P1 — Jump + Quick-capture, then `#`/`>` modes), if/when Cmd+K is pulled in.
                                   │
  Step 5 (P1)  Stable identity + SQLite sidecar (id↔path, links/backlinks, tags, FTS) → index-backed
          search/backlinks/move; tag browse/rename/merge.
          (Relations dock = deferred / post-v1, tech §18 — NOT part of this effort's v1.)
```

Each step leaves the editor in a working, shippable state — we can stop and ship at any boundary with
no half-built rewrite in the tree.
