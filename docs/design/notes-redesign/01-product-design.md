# Notes / PKM Redesign — Product Design (PRD)

> **Status:** Design phase. No implementation in this document — architecture, scenarios, data models, API contracts, and pseudocode only.
> **Doc series:** `01-product-design.md` (this doc) → later docs will cover technical design, data model, and rollout.
> **Scope rule:** The editing experience is the core of the core. Every tradeoff in this document resolves in favor of editing quality.

---

## Executive Summary

- **Problem.** Our note-taking is a single-pane Markdown textarea-class experience. It can render Markdown live, but it has no Notion-style block editing (no slash *insert-block* menu, no drag handles, no tables, no tags, no callouts). Meanwhile search, backlinks, and rename are all O(n) full-vault file scans with no index, and notes are not surfaced through the semantic search engine that already powers memory. Result: capture is clumsy and recall is weak — the two things a notes app must nail.
- **What we'll build.** A Notion-class **block editor** as the centerpiece — slash menu that *inserts blocks*, hover drag-handle, full text styles, **tables**, **tags/labels**, callouts/dividers/code/quote — on top of the editor we already have (we extend it, we do not rebuild it). Plus a **hybrid search** that runs **string/substring AND semantic** search together, by wiring notes into the embedding engine that already indexes memory. Markdown files stay the source of truth; any index is a rebuildable sidecar.
- **Simplest first step.** Two small, independently shippable wins: (1) flip the slash menu from "search tasks only" to a Notion-style insert-block menu, and (2) make the notes search endpoint *also* call the existing semantic engine (the notes embedding store and filesystem watcher already exist — they are simply not exposed in the notes search UI). Each ships value on day one without the full redesign.
- **User-visible outcome.** You type `/`, pick "Table," and get a real editable table. You select text and a toolbar appears. You add `#tags`. Three weeks later you find that note by typing a vague half-remembered phrase — and also by an exact substring — and both work, together, ranked sensibly.
- **Definition of done (the user's words).** "All the good features and no bug," "really really good," "super easy to use." We hold ourselves to a no-data-loss, no-jank editing bar, verified end-to-end.

---

## 1. North Star

> **A note editor so good you reach for it instinctively — block-based, direct-manipulation, zero-friction capture — and a vault so well-indexed that anything you ever wrote is one vague phrase away.**

The editor is the product. Search, organization, and AI integration are what make the editor's output *durable and findable* — but if the act of writing, structuring, and styling a note is not delightful, nothing else matters. We optimize for the felt quality of typing, selecting, dragging, and inserting before we optimize anything else.

---

## 2. Personas

### P1 — The Obsidian power-user ("Riya")
Lives in Markdown, keeps a large vault, relies on `[[wiki-links]]` and backlinks, renames and reorganizes constantly, and cares that her files stay plain Markdown on disk (git-friendly, portable, hers forever). Her pain today: rename rewrites links by fragile whole-vault regex on note *basename*, so same-name notes collide; backlinks and search re-read every file on every query. She will judge us on **link integrity, backlink correctness, and that we never lock her data into a proprietary blob.**

### P2 — The Notion-style user ("Marco")
Thinks in **blocks**: he expects `/` to summon an insert menu, expects to drag a paragraph above another, expects tables he can tab through, callouts for emphasis, and inline styling without leaving the keyboard. He does not want to learn Markdown syntax — he wants WYSIWYG. He will judge us on **whether the editor feels like Notion**: slash menu, drag handle, tables, tags, and "it just works."

### P3: The newcomer / chat-only user ("Sam")
Came for the Personal AI (tasks + sessions), not for a PKM tool. Sam writes the occasional meeting note or brain-dump and wants it captured in two seconds and findable later without thinking about folders, tags, or syntax. Sam will judge us on **time-to-first-note and whether search "just finds it"** even when he half-remembers what he wrote. Sam should never see a wall of options; defaults must be right.

> **Design tension we resolve explicitly:** Riya wants source-of-truth Markdown and stable identity; Marco wants rich WYSIWYG blocks; Sam wants invisibility. We satisfy all three by keeping **Markdown on disk as the contract**, layering **block-level UX on top**, and making **rich features progressively disclosed** (slash menu and hover affordances appear on demand, never clutter the empty page).

---

## 3. End-to-End Customer Scenarios

Each scenario is a full journey. Scenarios marked ⭐ exercise **both** search modes together.

### Scenario A — Capture a meeting note with a table and tags ⭐
Marco hits a global quick-capture shortcut, an editor opens focused on an empty note. He types a title, then `/` → "Table," fills a 3-column attendee/role/action grid by tabbing between cells, adds a `/` callout for the decision, and types `#standup #q3-planning` inline; the tags autocomplete from existing tags. He never touches a save button. **Three weeks later** he half-remembers it as "that planning sync where we split the data work" — he types that vague phrase into notes search and it surfaces near the top (semantic). He also recalls one exact attendee's name and types it — that same note appears via substring match. Both modes find it; the result list shows *why* (matched phrase vs. matched text). **Done = table is editable, tags capture + autocomplete, and the note is retrievable by both a fuzzy idea and an exact string.** *(v1 scope note: tags render as chips with reuse-steering autocomplete in v1; **clicking a chip to browse** all notes carrying it is the P1 tag-browse view — see §6.)*

### Scenario B — Power-user reorganizes the vault without breaking links ⭐
Riya renames `Project Apollo.md` → `Apollo Launch.md` and drags it into a different folder. Every `[[Project Apollo]]` reference across her vault continues to resolve — not by a brittle text rewrite, but because links resolve through a **stable note identity** and the link index updates incrementally. She opens a third note and its **Backlinks** panel is correct and instant (served from the index, not a fresh full-vault scan). She later searches `"retro action items"` — gets results ranked across the whole vault even though no single file contains that exact trigram, plus exact-substring hits highlighted. **Done = rename never orphans a link, backlinks are instant and correct, search blends meaning + literal text.**

### Scenario C — Newcomer brain-dump, found later by vibe ⭐
Sam types a stream-of-consciousness note after a call: no headings, no tags, no folder chosen (it lands in a sensible default). Two weeks later Sam types "the thing about the noisy neighbor and the lease" — a phrase that appears *nowhere* verbatim — and the note is the top result (pure semantic recall). Sam clicks it and reads it back. **Done = zero-structure capture is still fully recoverable by meaning alone; the newcomer never had to tag or file anything.**

### Scenario D — Restructure a rough note into a clean doc with blocks
A note grew into a messy outline. The user hovers a paragraph, grabs the **drag handle**, and reorders three blocks by dragging. They select a run of text and a **floating toolbar** lets them bold it, make it a heading, or turn it into a quote. They convert a loose list of items into a checklist via the slash menu, and a code snippet into a fenced code block with a language label. The Markdown on disk updates to match, byte-clean (no spurious blank lines, no escaped characters). **Done = direct-manipulation block editing produces clean, diff-friendly Markdown.**

### Scenario E — Tag-driven review across notes *(P1 — needs the tag index/browse/rename, which is P1; v1 ships chip + autocomplete only)*
The user clicks a `#q3-planning` tag inside a note. A tag view lists every note carrying that tag (served from the tag index, not a scan), newest first, with snippets. They jump between them to assemble a weekly review. They rename the tag `#q3-planning` → `#q3` once and it updates everywhere consistently. **Done = tags are first-class, browsable, and renamable without manual find-replace.**

### Scenario F — Quick switcher / quick capture from anywhere
From any screen the user invokes a quick switcher, types a few characters of a note title (fuzzy), and jumps straight into it for editing — or, if nothing matches, creates a new note inline with that title. The same surface offers "capture a new note" so a fleeting thought lands instantly. **Done = getting *into* the right note (or a new one) is sub-second and keyboard-only.**

---

## 4. Current State vs. Target (grounded in the code)

### What already exists — we EXTEND, never rebuild
| Capability | Where it lives today | Status |
|---|---|---|
| Block WYSIWYG via TipTap/ProseMirror | `web/src/components/notes/NotesEditor.tsx` | ✅ foundation present |
| Live Markdown as storage format | `tiptap-markdown` (`html:true`, transform paste/copy) | ✅ keep as contract |
| Task lists, nested tasks, per-line Tab indent/outdent, ArrowUp fix | `TightTaskList`, custom `handleKeyDown` | ✅ keep |
| Images (inline, base64, clipboard paste, drag-drop upload) | `Image` ext + `handlePaste`/`handleDrop` | ✅ keep |
| Links: autolink, paste-to-link, internal task SPA routing, external new-tab | `TaskAwareLink` | ✅ keep |
| Wiki-links `[[ ]]` with autocomplete | `WikiLinkExtension` (optional) | ✅ keep, but fix identity (see debt) |
| Slash menu mechanism | `SlashCommandExtension` | ⚠️ exists but **only searches tasks** — repurpose to insert blocks |
| Markdown vault on disk, CRUD, optimistic-lock save, move, folder | `src/web/routes/notes-v2.ts` | ✅ keep |
| Semantic engine for memory | `src/core/memory-search.ts` + `qmd-store.ts` | ✅ reuse for notes |
| **Notes semantic store + recursive watcher** | `getNotesStore()` in `qmd-store.ts`; `qmd-watcher.ts` already watches `NOTES_DIR` and runs `update()`+`embed()` on every `.md` change; `memoryNotesSearch` already has `note_*` source weights | ✅ **largely wired already** — the gap is UI exposure, not the index |

### What's missing — the P0 gap (the user's asks map here)
- **Insert-block slash menu** (headings, table, quote, code, divider, callout, todo, bullet, etc.) — today's slash menu only does task search.
- **Tables** — no table extension installed; needs full Notion-style create + cell edit + tab navigation + add/remove row/column.
- **Tags / labels** — no tag node/mark, no tag autocomplete, no tag index, no tag browse view.
- **Block-level affordances** — no hover **drag handle** ("grip"), no block reorder by drag, no floating selection toolbar.
- **Semantic search exposed in the notes UI** — the engine indexes notes, but the notes search endpoint is substring-only and never calls it.
- **Quick switcher / quick capture** for notes.
- Callouts, dividers, multi-column blocks (column blocks are P1+).

### Known tech debt — fix the ROOT CAUSE, not the symptom
| Debt | Root cause | Root-cause fix (design intent) |
|---|---|---|
| Search re-reads every file each query | No index; O(n) scan in `/search` | Serve string search from a derived index; serve meaning from the existing embedding store. Files stay source of truth; index is a rebuildable sidecar. |
| Backlinks re-scan every file each query | No link index; O(n) regex over whole vault | Maintain an **incremental link/backlink index** updated on save/move. |
| Rename is fragile | Links resolve by **basename**; rename rewrites `[[name]]` by whole-vault regex → same-name collisions, brittle edits | Give every note a **stable identity**; resolve links and update the index by identity, not by string-replacing names across the vault. |

> **Source-of-truth principle (non-negotiable):** The Markdown vault on disk is the master. Every index (string, link/backlink, tag, embeddings) is a **rebuildable sidecar** — deletable and reconstructable from the files at any time. We never make an index the system of record.

---

## 5. Search Model — BOTH, Together (explicit per user)

The user wants **both** search modes working **together**, not as an either/or toggle buried in settings.

```
                ┌──────────────── Notes Search ────────────────┐
   user query → │                                              │
                │   (1) STRING / SUBSTRING        (2) SEMANTIC  │
                │   exact text, fast,          meaning-based,   │
                │   served from a derived      via the existing │
                │   index (not O(n) scan)      embedding engine │
                │            │                        │         │
                │            └──────── merge & rank ──┘         │
                │   results labeled by WHY they matched         │
                │   (exact text vs. related meaning)            │
                └──────────────────────────────────────────────┘
```

- **String/substring:** literal matches a user typed and expects to find verbatim. Must feel instant and be served from a derived index, not a full-vault re-read.
- **Semantic:** meaning-based recall for vague/half-remembered phrasing — reuse the same engine that already powers memory and that **already indexes the notes vault**. The work is to **surface** it in the notes search UI and blend it with string results.
- **Blending:** a single result list, de-duplicated by note, where each hit shows *why* it matched (exact text hit vs. related-by-meaning) so the user trusts the ranking. Exact matches should never be buried beneath fuzzy ones.

> This directly satisfies: "BOTH must work together — embedded/semantic search AND string/substring search."

---

## 6. Scope & Prioritization

### P0 — Must-have for v1 (editing-experience-first)
*The bar: a writer who has used Notion feels at home; a writer who has used Obsidian keeps their Markdown and link integrity.*

1. **Notion-style slash insert-block menu** — `/` opens a block picker: H1/H2/H3, bullet list, numbered list, to-do/checklist, quote, divider, code block, callout, table, image. Filterable by typing; keyboard-navigable. (Repurpose the existing slash mechanism; preserve the task-reference path as one menu entry.)
2. **Tables (Notion-style)** — insert a table; edit cells; Tab/Shift-Tab between cells; add/remove rows & columns; header row. Round-trips cleanly to/from Markdown tables on disk.
3. **All basic text styles** — bold, italic, strikethrough, inline code, headings, blockquote, ordered/unordered lists, checklists, links. Available via slash menu, a **floating selection toolbar**, and Markdown shortcuts.
4. **Tags / labels (v1 = capture + reuse)** — inline `#tag` as a styled chip, with autocomplete that steers reuse from existing tags (frequency-ranked). *In plain English: in v1 you can type `#tag`, it renders as a chip, and typing `#` suggests tags you already use so you don't fork `#q3` vs `#Q3`.* **Clickable-to-browse, a dedicated tag-browse view, the tag index, and consistent tag rename/merge are P1** (see §6) — they ride the same structural sidecar as backlinks/identity. This split is the authoritative scope; the technical design (§15) reconciles it identically.
5. **Block affordances** — hover **drag handle** to select/reorder a block; drag-to-reorder; a "+" affordance to insert a block. Direct manipulation that produces clean Markdown.
6. **Callout + divider blocks** — first-class callout (icon + colored container) and horizontal divider, round-tripping to a defined Markdown representation.
7. **Hybrid notes search (BOTH modes)** — notes search returns string **and** semantic results in one ranked, labeled list. Semantic side reuses the existing engine/notes store; string side served from a derived index (not O(n) scan).
8. **Editing-quality bar (cross-cutting, P0):** no data loss, no save/sync flicker, byte-clean Markdown output (no spurious blank lines or stray escapes), cursor/scroll preserved across external syncs, large-note typing stays smooth.

### P1 — Next
- **Stable note identity + incremental link/backlink index** (root-cause fix for rename + O(n) backlinks). *Rationale for P1 not P0: the editing surface is the user's #1 priority; identity/index is the durability backbone we land right after the editor feels right. May be pulled into P0 if rename breakage blocks power-users in testing.*
- **Quick switcher / quick capture** for notes (fuzzy title jump + inline new-note + capture-from-anywhere).
- **Tag browse + index + rename/merge** — the **tag index** (backed by the structural sidecar), clickable chips that open a dedicated **tag-browse view** listing notes by tag, and consistent tag rename/merge as index ops (not vault find-replace). *This is the P1 half of feature #4: the v1 chip + autocomplete are P0; making tags clickable/browsable/renamable lands here, with identity/index.*
- **Frontmatter / properties** — structured note metadata (e.g. tags, status, dates) editable in a properties area, stored as YAML frontmatter.
- **Multi-column / column blocks** — side-by-side block layout.
- **Search UX polish** — filters (by tag/folder/date), result previews, recent/most-relevant ordering, keyboard-driven result navigation.
- **Nested/path-aware tags** and tag suggestions.

### Explicit NON-GOALS (now) — per user, "not too important for now"
- ❌ **Canvas / whiteboard** (freeform spatial canvas)
- ❌ **Graph view** (force-directed link graph)
- ❌ **Real-time multiplayer / collaborative editing** (presence, cursors, CRDT/OT sync)
- ❌ Proprietary storage formats — **Markdown on disk remains the source of truth**; we will not introduce a database-as-master for note content.
- ❌ Public sharing / publishing, comments/annotations, version-diff UI (out of scope for this effort).

---

## 7. Success Metrics (measurable)

**Editing experience (the #1 metric set):**
- **Time-to-first-table:** from `/` to a focused, editable table cell — target **≤ 3 s** and **≤ 2 actions** (open menu → pick Table).
- **Time-to-first-note (newcomer):** from quick-capture invocation to typing in a focused empty note — target **≤ 1.5 s**, **0 required decisions** (no forced folder/tag/title).
- **Block reorder cost:** reordering a block via drag handle — target **≤ 2 actions** (grab → drop), no syntax knowledge required.
- **Markdown round-trip fidelity:** open → edit a block → save → reopen produces **0 spurious diffs** (no added blank lines, no re-escaping) across a fixed corpus of representative notes. Target **100%** clean round-trips on the corpus.
- **Editing jank:** typing latency stays smooth on a large note (define a large-note benchmark); **no dropped input, no save-induced cursor jump**, measured in E2E.

**Search & recall:**
- **Semantic recall:** on a labeled set of "vague phrase → expected note" pairs (phrasing that does NOT appear verbatim), the expected note is in the **top 3** results — target **≥ 80%**.
- **String exactness:** any exact substring that exists in the vault returns its note(s) — target **100%** (correctness, not just ranking), and exact hits are never ranked below purely-semantic hits.
- **Search latency:** notes search returns first results in **≤ 300 ms** on a representative vault (served from indexes, not O(n) scans).
- **Backlink correctness & speed:** backlinks panel matches ground truth **100%** and renders from the index in **≤ 150 ms** (no full-vault scan).

**Integrity (the "no bug" bar):**
- **Rename link integrity:** after rename/move, **0 orphaned links** across the vault on the test corpus.
- **Zero data loss:** no edit is ever lost to a save/sync race; optimistic-lock conflicts are surfaced, never silently dropped.

**Adoption (directional):**
- Increase in notes created/edited per active week after launch; increase in note searches that result in a click-through (search is actually finding things).

---

## 8. Top Risks

1. **Editing regressions while extending the editor (highest risk).** The current editor has hard-won custom logic (tight task lists, per-line Tab detach, ArrowUp nesting fix, save-sync loop guard via `isSourceRef`). Adding tables, drag handles, and new block types can break these subtle invariants. *Mitigation:* treat the existing behaviors as a regression suite; add E2E coverage for each before layering new blocks; land new blocks incrementally behind the existing markdown round-trip guarantee.
2. **Markdown round-trip lossiness.** Tables, callouts, tags, and dividers must serialize to Markdown that survives a load→edit→save cycle with zero spurious diffs. Callouts/tags have no single canonical Markdown form — choosing one badly creates churny diffs or data loss. *Mitigation:* define and freeze a Markdown representation per block in the technical design; round-trip fidelity is a P0 acceptance gate.
3. **Search ranking trust.** Blending string + semantic can bury exact matches under fuzzy ones (or vice-versa), eroding user trust ("it didn't find my note"). *Mitigation:* exact matches are first-class and never out-ranked by purely-semantic hits; label every result by *why* it matched; tune on a labeled eval set, not by feel.
4. **Identity migration for existing vaults.** Introducing stable note identity (P1) must not break existing `[[name]]` links or require users to re-tag/re-link. *Mitigation:* identity is additive and derived; basename links keep resolving during a transition; migration is automatic and reversible (files remain the source of truth).
5. **Index drift / staleness.** Any sidecar index (string, link, tag, embeddings) can drift from the files (external edits, git pulls, the Personal AI writing notes directly). *Mitigation:* indexes are rebuildable from files on demand; a watcher keeps them fresh; correctness tests assert index == vault ground truth. (Embeddings already refresh via the existing recursive watcher. Extend the same discipline to the other indexes.)
6. **Scope creep toward Notion/Obsidian parity.** Tables, columns, properties, tag merges — each invites "one more feature." *Mitigation:* P0 is editing-experience-first and bounded; canvas/graph/multiplayer are hard non-goals; everything else queues behind the editing-quality bar.
7. **Performance on large vaults.** Even with indexes, embedding refresh and tree rendering must stay smooth as the vault grows. *Mitigation:* incremental/debounced index updates; benchmark on a large synthetic vault; avoid any remaining O(n) hot paths in interactive flows.

---

## 9. Out of Scope for THIS document
Technical design (extension architecture, index schema, identity scheme, Markdown serialization contracts, API changes), data-model details, and rollout/migration sequencing are deferred to follow-up docs in `docs/design/notes-redesign/`. This document fixes the **product intent, scope, scenarios, and success bar** — with the editing experience as the explicit, unmovable #1 priority.
