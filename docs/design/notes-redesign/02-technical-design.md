# Notes / PKM Redesign — Technical Design (Unified)

> **Status:** Design phase. No implementation in this document — architecture diagrams, data models,
> API contracts, and pseudocode only. No code is written into `src/` or `web/src/`.
> **Role of this doc:** the **single, coherent technical design** that integrates the two deep dives
> (`02-search-and-index-design.md` — backend storage/index/search, and `03-editor-architecture.md` —
> TipTap editor) into one plan that serves the PRD (`01-product-design.md`) and the chosen UX
> (`ux-decision.md`). Where the two deep dives overlap (identity, the on-disk link form, tags,
> the round-trip contract), this doc is the **reconciling authority**: it states the contract once and
> points each half at it.
> **Scope rule (inherited, non-negotiable):** Markdown files on disk are the **source of truth**. Every
> index — string/FTS, link/backlink, tag, embeddings — is a **rebuildable sidecar**, never the system of
> record. The **editing experience is the #1 priority**; no item here may regress save/load fidelity,
> introduce jank, or produce non-byte-clean Markdown.

---

## Executive Summary

- **The technical problem (two halves, one root).** *Front:* the editor is a solid TipTap 3.20.1 base,
  but the slash menu only inserts task references and there are **no tables, tags, callouts, drag handle,
  or bubble menu** — and new blocks threaten the delicate hand-rolled list logic and, worse, the
  **Markdown round-trip** (Markdown is the storage format, so a bad serializer = silent data loss).
  *Back:* search, backlinks, and rename are **O(n) full-vault file scans**, links resolve by **basename**
  (collisions + fragile whole-vault regex rewrite on rename), and the semantic engine that *already
  indexes notes* (QMD) is both **never surfaced in the notes UI** and **only watches four hard-coded PARA
  folders** so notes elsewhere are invisible to it. The two halves share **one** keystone: there is **no
  stable note identity and no derived index keyed on it.**
- **The architecture.** Extend, never rebuild. Editor: evolve the one-entry slash extension into a
  Notion-style block menu, **buy** the battle-tested interactions (`@tiptap/extension-table` family,
  `-bubble-menu`, `-drag-handle-react`), and **build two tiny custom nodes** (`#tag` inline node, `> [!kind]`
  callout) — each riding `tiptap-markdown`'s per-extension serialize/parse hook so there is exactly one
  tested round-trip path per block. Backend: **two deliberately-separate rebuildable SQLite sidecars** —
  the *existing* semantic store (QMD `notes-search.sqlite`, just widened to the whole vault and exposed)
  and a *new* structural sidecar (`notes-index.sqlite`, `better-sqlite3` + FTS5) holding identity, links,
  tags, and substring/FTS — fed by **one** filesystem watcher with two debounced consumers. A **stable,
  opaque `id` in YAML frontmatter** is the keystone both halves share: the editor authors links in the
  **Obsidian-native** form (`[[Title]]` / `[[folder/Title]]`, fully portable — the id lives in frontmatter,
  never in link text, §2.2 revised after a customer walkthrough caught that `[[Title|n_id]]` hijacks
  Obsidian's `|` alias slot); the backend resolves the link, then keys the edge on the **target's** stable
  id, so rename becomes a one-row update and the whole-vault regex (`updateWikiLinksInAll`) is **deleted**.
- **The simplest first step (ships value day one, on each side independently).** *Editor:* swap the
  single-entry `NOTE_SLASH_COMMANDS` array for a real block list + per-block command dispatch — a Notion
  feel with **zero new dependencies and zero round-trip risk** (the slash machinery already exists and is
  proven). *Backend:* in `GET /search`, also call the already-present `memoryNotesSearch(...)` and merge
  it with the current substring scan — *plus* the one-line prerequisite of widening `getNotesStore()` to
  the whole vault so notes outside PARA folders become searchable. Each lands before any sidecar or new
  block exists.
- **The user-visible outcome.** Type `/` for any block; drag the `⠿` grip to reorder; select text for a
  floating format bar; build real tables with `Tab`-driven cell nav; drop `#tags` inline; write callouts —
  and every one saves to clean, portable, git-friendly Markdown that reopens **byte-identical**, with a
  single `Cmd+Z` reversing each user action. Three weeks later you find that note by a vague
  half-remembered phrase **and** by an exact substring, in one labeled list where exact hits are never
  buried. Rename a note and every `[[link]]` still resolves; backlinks render instantly. The AI butler can
  edit a note you have open without stealing your caret: a non-conflicting write defers while you type and
  never loses a character; a true write-write conflict is surfaced (never silently dropped) with an honest,
  bounded loss of at most one debounce window (§6.2). Delete any sidecar and it rebuilds from the files.
  "All the good features and no bug," "super easy to use."
- **What changed in Round 1 (Bar Raiser).** Five things hardened from "assumed solved" to **owned,
  tested contracts**, after first-hand re-verification of the shipped sources: (1) the shipped
  tiptap-markdown table serializer provably emits no alignment markers, escapes no pipes, and falls back
  to raw HTML for header-less tables — so v1 **owns a custom GFM table serializer** and **constrains the
  table UI** (no header-toggle-off) — §6.1; (2) external/AI writes mid-edit are now a **blocking,
  position-mapped, defer-while-dirty** contract, not a full-document `setContent` that teleports the caret
  — §6.2; (3) an explicit **Undo/Redo contract** (one user action = one `Cmd+Z`), folding today's
  multi-dispatch Tab logic into single transactions — §6.3; (4) the **semantic-leg path normalization**
  (absolute QMD path → vault-relative) that otherwise duplicates and mislabels every semantic hit — §9.2;
  (5) the QMD widen no longer rides `store.update()`'s **synchronous whole-vault re-scan** on the save
  hot path — it drives the semantic store **one changed file at a time**, off-loop — §5.1 / §8.2. Scope
  honesty: **Cmd+K, the structural sidecar, and tag browse/rename are reconciled as P1** (early-pull
  candidates, not silently relabeled P0); the v1 inline `#tag` is precisely scoped — §15. The relations
  dock is **explicitly out of v1** — §18.

---

## 0. Grounding — what the code does today (verified first-hand)

Both deep dives are grounded line-by-line; this table is the merged, re-verified set the integration
depends on.

| Concern | Today | Evidence |
|---|---|---|
| Editor core | TipTap **3.20.1** (`@tiptap/*` + `tiptap-markdown@0.9.0`); deps in `web/node_modules` | `web/package.json` (`@tiptap/* ^3.20.1`, `tiptap-markdown ^0.9.0`, `marked ^15`, `dompurify ^3.3`) |
| Editor size | **609 LOC**, single component | `web/src/components/notes/NotesEditor.tsx` |
| Storage format | Markdown; `editor.storage.markdown.getMarkdown()` on save; `Markdown.configure({ html:true })` | `NotesEditor.tsx` |
| Slash menu | **One entry** (`task` → task-search sub-panel) — not a block menu | `slash-commands/types.ts`; `SlashCommandPortal.tsx`; `SlashCommandMenu.tsx` |
| Slash machinery | `findSlashTrigger()` → tracked `range{from,to}` → `{phase:'commands',range,query}` → portal `.deleteRange(range).insertContent(...)` at `coordsAtPos(range.from)` | `SlashCommandExtension.ts`, `SlashCommandPortal.tsx` |
| Wiki-link | `[[` trigger, same detect→range→autocomplete shape; commits **plain `[[name]]` text**; resolves by **basename** | `wiki-link/WikiLinkExtension.ts`, `WikiLinkAutocomplete.tsx`; `WIKI_LINK_RE` at `notes-v2.ts:44` |
| Bubble-menu | **Already present** at `@tiptap/extension-bubble-menu@3.20.1` (in `web/node_modules`) | `web/node_modules/@tiptap/extension-bubble-menu/` (re-verified Round 1) |
| Tables / tags / callouts / drag-handle | **Not installed** — only `@tiptap/extension-table*` family + `-drag-handle-react` are missing (bubble-menu is **not** in this list, contra a prior draft) | `web/package.json` (no table/drag entries) |
| Round-trip engine | `tiptap-markdown` = `markdown-it@14.1.1` (parse) + `prosemirror-markdown` (serialize); resolves per-extension specs via `getMarkdownSpec(ext)={...default,...ext.storage.markdown}` | `tiptap-markdown/src/util/extensions.js`, `src/serialize/MarkdownSerializer.js` |
| **Tables do NOT round-trip for free** | `tiptap-markdown`'s `isMarkdownSerializable(node)` (re-read Round 1) returns **false** — silently emitting raw `<table>` HTML — when **any first-row cell is not `tableHeader`**, any cell has `colspan/rowspan`, or any cell `childCount>1`. When it *does* emit pipes it **hardcodes the delimiter row to `---`** (no `:--`/`:-:`/`--:` alignment) and **does not escape `\|` in cell text**. So the shipped serializer loses alignment on every save and HTML-blobs any header-less table → **v1 owns a custom table serializer** (§6.1) | `tiptap-markdown/src/extensions/nodes/table.js` (`isMarkdownSerializable`, `Array.from(...).map(() => '---')`) |
| Read-only render path | Separate parser: **`marked` + DOMPurify** (`notes-markdown.ts`/`markdown.ts`) — NOT TipTap | `notes-markdown.ts` |
| String search | `GET /search?q=` reads **every** `.md` via `getAllMdFiles()` + `indexOf` per query | `notes-v2.ts:315,417` |
| Backlinks | `GET /backlinks/*path` re-scans **every** file with `WIKI_LINK_RE`, matches by **basename** | `notes-v2.ts:348,355` |
| Rename / move | `POST /move` renames file then `updateWikiLinksInAll()` regex-rewrites `[[oldName]]`→`[[newName]]` across **every** file | `notes-v2.ts:235,282,293` |
| Save signal | `PUT /content/*` emits `bus.emit(NOTES_UPDATED, {source, contentHash})` (optimistic-lock) | `notes-v2.ts` |
| Semantic engine | QMD hybrid (BM25 + vector + RRF + rerank); `getNotesStore()` exists; `memoryNotesSearch()` has `note_*` source weights | `memory-search.ts`, `qmd-store.ts:60` |
| **Semantic coverage gap** | `getNotesStore()` indexes only `Areas/Projects/Resources/Archive` — arbitrary folders are **never embedded** | `qmd-store.ts:66-70` |
| Watcher | `fs.watch(NOTES_DIR,{recursive})` → debounced (~5 s) `store.update()`+`embed()` | `qmd-watcher.ts` |
| Concurrency primitive | Cross-process `withFileLock`/`withFileLockSync` (mkdir-atomic, PID-liveness stale detect) | `src/utils/file-lock.ts` |
| Sidecar-DB precedent | `better-sqlite3` (`^12.6.2`) already used for tasks/sessions/usage/memory-index; `js-yaml` (`^4.1.0`) installed | `task-db.ts`, `memory-index.ts`; `package.json` |
| QMD programmatic insert | `insertContent/insertDocument/findActiveDocument/deactivateDocument/resolveVirtualPath` + hash-skip | `qmd-task-sync.ts` |

**Two parsers, one contract (editor side).** The editor (`markdown-it`) and the read-only viewer
(`marked`) are independent. Every new construct must round-trip through **both** — TipTap for editing
fidelity, `marked` for the rendered view (search snippets, backlinks panel, mobile). This is a named risk
(§7).

**Two sidecars, deliberately separate (backend side).** Semantic (QMD, `notes-search.sqlite`) and
Structural (new, `notes-index.sqlite`) reconcile from the *same* watcher events but write *different*
files — mirroring QMD's existing "separate DB per store to avoid noisy-neighbor re-embedding" rationale.
Do **not** merge them.

---

## 1. Architecture — Before vs. After

### 1.1 BEFORE (today)

```
┌──────────────────────────── EDITOR (web/src/components/notes) ───────────────────────────┐
│  NotesEditor.tsx (609 LOC)  — TipTap 3.20.1                                                │
│   StarterKit · TightTaskList · TaskItem · Placeholder · Image · TaskAwareLink             │
│   Markdown(tiptap-markdown, html:true)  · custom handleKeyDown (Tab/ArrowUp)              │
│   SlashCommandExtension ─▶ ONE entry: "task" (task search only)  ✗ no block menu          │
│   WikiLinkExtension ─▶ inserts plain  [[name]]   (resolves by BASENAME)                    │
│   ✗ no table  ✗ no #tag  ✗ no callout  ✗ no drag-handle  ✗ no bubble menu                  │
└───────────────────────────────────────────┬───────────────────────────────────────────────┘
                                             │  getMarkdown()  /  PUT /content
                                             ▼
                         Markdown vault  ~/.open-walnut/notes/**/*.md   (SOURCE OF TRUTH)
                                             │
        ┌────────────────────────────────────┼─────────────────────────────────────────────┐
        ▼ (every query re-reads EVERY file)   ▼ (every query re-scans EVERY file)            ▼
 GET /search  ── O(n) getAllMdFiles+indexOf   GET /backlinks ── O(n) WIKI_LINK_RE by basename │
 POST /move  ── rename + updateWikiLinksInAll() regex-rewrite [[name]] across WHOLE VAULT     │
                                                                                              │
   QMD getNotesStore()  ── indexes ONLY Areas/Projects/Resources/Archive  ✗ other folders     │
        (semantic engine EXISTS but is NEVER surfaced in the notes search UI)  ◀──────────────┘
```

Pain: capture is clumsy (no blocks), recall is weak (no semantic in UI), and three O(n) scans + a fragile
basename rename will not scale and break links.

### 1.2 AFTER (target)

```
┌──────────────────────────── EDITOR (extend, no rewrite) ─────────────────────────────────┐
│  NotesEditor.tsx — TipTap 3.x (bump @tiptap/* to one matching minor)                      │
│   KEEP: StarterKit · TightTaskList · TaskItem · Placeholder · Image · TaskAwareLink ·     │
│         Markdown · custom handleKeyDown · isSourceRef save-sync guard                      │
│   EVOLVE (1 file): SlashCommandExtension ─▶ Notion BLOCK MENU (H1–H3/list/todo/quote/     │
│                    divider/code/callout/table/image + preserved Task/Note-link entries)   │
│   EVOLVE: WikiLinkExtension ─▶ inserts Obsidian-native [[Title]] / [[folder/Title]] (§2.2) │
│   BUY:  Table family · BubbleMenu (selection toolbar) · DragHandle (⠿ grip + ＋)          │
│   BUILD: TagNode (#tag inline atom) · Callout (> [!kind])                                  │
│   WRAP: frontmatter strip-on-load / reattach-on-save (NOT an editor node)                  │
│   ── all insert/turn-into/move go through ONE shared block-transforms module ──            │
└───────────────────────────────────────────┬───────────────────────────────────────────────┘
                                             │  byte-clean Markdown (per-extension serializer)
                                             ▼
                         Markdown vault  ~/.open-walnut/notes/**/*.md   (SOURCE OF TRUTH)
                            id in YAML frontmatter = stable identity
                                             │
        ┌──────────────────┬─────────────────┴───────────┬────────────────────────────────┐
  write │ (PUT /content)   │  fs.watch(recursive) — ONE   │  external edit / git pull / AI │
        ▼ NOTES_UPDATED     │  registration, TWO consumers │  butler write                  ▼
 ┌──────────────────┐       ▼                              ▼                    (caught by watcher)
 │ notes-v2 routes  │  ┌─────────────────────────┐   ┌─────────────────────────────┐
 │ CRUD/move/folder │  │ NotesIndexer (NEW)       │   │ QMD widen+embed (EXISTING)  │
 └────────┬─────────┘  │ debounce ~1s; hash-skip; │   │ debounce ~5s; update+embed  │
          │            │ parse frontmatter+links+ │   │ ONE whole-vault collection  │
          └───────────▶│ tags; withFileLock       │   └──────────────┬──────────────┘
                       └──────────┬───────────────┘                  │
                                  ▼                                   ▼
                  ┌───────────────────────────┐        ┌───────────────────────────┐
                  │  notes-index.sqlite (NEW)  │        │ notes-search.sqlite (QMD) │
                  │  STRUCTURAL sidecar        │        │ SEMANTIC store (exists)   │
                  │  notes · links · tags ·    │        │ whole-vault collection    │
                  │  notes_fts (substring/FTS) │        │ BM25 + vector + rerank    │
                  └───────────┬────────────────┘        └────────────┬──────────────┘
                exact/FTS/backlinks/tags (O(log n))      meaning-based │
                              └───────────────┬───────────────────────┘
                                              ▼
                       ┌──────────────────────────────────────────────┐
                       │  Unified Notes Search  (notes-v2 GET /search) │
                       │  run BOTH legs in parallel → dedupe by id →   │
                       │  label  ● exact / ◐ both / ○ semantic →       │
                       │  rank: exact NEVER below purely-semantic      │
                       └──────────────────────┬───────────────────────┘
                                              ▼
                        Cmd+K front door (any page) · Search · Backlinks panel · Tag views
```

**Global invariant.** `DELETE notes-index.sqlite && DELETE notes-search.sqlite` followed by a rebuild
reproduces identical behavior from the files alone. The files never depend on either DB. The only
persisted artifact added to the files is the additive `id:` frontmatter line (harmless, human-ignorable).

---

## 2. The shared keystone — stable note identity (reconciled across both halves)

Both deep dives depend on one fact: **every note carries a stable, opaque `id` in its YAML frontmatter.**
This section states the single contract; §3 (editor) and §4–5 (backend) consume it without redefining it.

### 2.1 The id

```yaml
---
id: n_k7f3p9q2          # stable; never changes on rename/move
title: Apollo Launch    # display title (defaults to first H1 / filename if absent)
tags: [standup, q3]     # array of tag slugs (no leading '#')
created: 2026-06-08T...
---
```

- **Format:** `n_` + base36(time) + 3 random chars — matches the project's existing id style (`qm-…`,
  `sess-…`, task ids). Generated **once**, when a note lacking one is first reconciled.
- **Primary key everywhere:** link targets, backlink edges, tag edges, QMD virtual-path mapping. Basename
  is **display only**.
- **Parsed** with `js-yaml` (already installed) via a small owned helper `parseFrontmatter(bytes) → {data, body}`
  (gray-matter-style; no new dependency). Tolerant: malformed YAML → whole file treated as body,
  `data={}`, debug-log, **never throws** (one bad note can't break the vault index).

> **Why frontmatter, not a sidecar id-map?** The id travels *with* the note (copy the file out, it keeps
> its identity). A separate map would be a second source of truth that can drift — violating the
> source-of-truth principle. This is additive: a note with no frontmatter still works; the indexer treats
> `id absent` as "assign on next write."

### 2.2 The on-disk link form — Obsidian-portable by default (REVISED after customer walkthrough)

This is the single point the two deep dives most needed reconciling, **and the one a customer walkthrough
showed the earlier draft got wrong.**

**The collision the earlier draft missed (BLOCKING for persona P1 — the Obsidian power user).** The earlier
draft stored links on disk as `[[Title|n_id]]`, treating `|n_id` as a private invisible alias. But **`|` is
already load-bearing in Obsidian**: `[[Apollo Launch|n_k7f3p9q2]]` means *"link to the note titled Apollo
Launch, but DISPLAY the text `n_k7f3p9q2`."* So the moment persona P1 opens her vault in **real Obsidian**
(which she will — portability is her entire reason for choosing a Markdown tool), every Walnut-authored link
renders the **opaque id as its visible label** and resolves by title, not id. That breaks the PRD's explicit
"portable, hers forever" promise to P1. The `|` alias slot is **not** ours to repurpose.

**Decision (frozen default): store links in the Obsidian-native form, derive rename-proofness from the
TARGET's frontmatter id (not from the link text).** Rename-proofness comes from the *target note* carrying a
stable `id` in its frontmatter (§2.1) — so renaming the file never changes identity. The *link text* does
**not** need to embed the id to survive a rename, as long as resolution keys on a stable target. The contract:

| Stage | Behavior | Owner |
|---|---|---|
| **Author** | `[[` autocomplete inserts **plain, Obsidian-native** `[[Title]]` (or, when the user picks a specific note among same-named ones, the Obsidian-native **path form** `[[folder/Title]]` to disambiguate — still 100% Obsidian-portable). **No `\|n_id` is ever written into the alias slot.** A user-chosen display alias uses Obsidian's real semantics: `[[Title\|shown text]]`. | Editor (`WikiLinkExtension`) — §3.5 |
| **Display** | Renders the friendly `Title` (or the user's real alias) exactly as Obsidian would. | Editor — §3.5 |
| **Disk** | Literal `[[Title]]` / `[[folder/Title]]` / `[[Title\|alias]]` — **byte-identical to what Obsidian writes and reads.** Round-trip is trivial (plain text). | both |
| **Resolve** | Indexer resolves by **path** when the link is a path form (exact, collision-free), else by **title/basename**; it then maps the resolved note → its stable frontmatter `id` and stores the edge **keyed on the target's id** (so the edge survives the target's rename). Multiple title matches with no path qualifier → **`ambiguous`** edge (never silently mis-resolved; §4.3 UX). | Backend — §4.2/§4.3 |
| **View (read-only)** | `marked` pipeline renders `[[Title]]` / `[[folder/Title]]` / `[[Title\|alias]]` as a note link (resolve via index) — same as Obsidian. | Editor viewer — §7 |

**What this trades, stated honestly.** The earlier `[[Title|n_id]]` form was "collision-proof **from the link
text alone**." The Obsidian-native form is collision-proof **only when the author disambiguates** (path form
`[[folder/Title]]`, which Obsidian also uses) — a bare `[[Title]]` to one of two same-named notes is genuinely
ambiguous and is recorded as an `ambiguous` edge (§4.3) for the user to resolve, exactly as Obsidian itself
surfaces it. **Rename-proofness is preserved** (target id in frontmatter). This is the right trade for P1: full
portability is non-negotiable for her; same-name ambiguity is rare, already handled honestly by §4.3, and is
the *same* behavior her current tool has. **The id lives in frontmatter only** — never in link text.

> **This is flagged as an UNRESOLVED DECISION (§19) for the human owner** because it changes the cross-cutting
> link contract both deep dives were written against. The recommended default above (Obsidian-native links +
> id-in-frontmatter resolution) is the one that honors the PRD's portability promise to P1. The alternative —
> if a future maintainer values text-level collision-proofness over Obsidian portability — would be a
> **non-rendering** id carrier (e.g. an HTML comment `[[Title]]<!--n_id-->` or a frontmatter-only link table),
> NOT the `|` alias slot. The `|n_id` form is rejected outright as Obsidian-breaking.

Net effect: newly authored links are **fully Obsidian-portable** and rename-proof (via the target's
frontmatter id); legacy `[[name]]` links keep resolving during migration; rename never rewrites the vault.

### 2.3 Rename / move becomes O(1)

Because links key on id: **rename/move only renames the file.** No `updateWikiLinksInAll()`, no
whole-vault regex. The id in frontmatter is unchanged, so every edge in the index still points at the same
note. The indexer updates that note's `path` column (one row) + the QMD virtual-path mapping (one
document). `updateWikiLinksInAll()` is **deleted** (root-cause removal). An *optional* cosmetic pass may
rewrite the displayed label of legacy name-based links, but resolution never depended on it, so it is
best-effort and non-blocking.

> This is the fix-the-root-cause move: the fragile rewrite existed **only** because identity was the
> basename. Give notes real identity and the rewrite problem disappears entirely — retiring one bug class
> across both halves.

---

## 3. Editor architecture (extend, no rewrite)

### 3.1 Extension map

```
            EXISTING (keep verbatim)        EVOLVE (1 file each)           ADD (additive)
            ─────────────────────────       ────────────────────          ──────────────────────────
            StarterKit                      SlashCommandExtension ──▶  Block-menu command registry
            TightTaskList                     (trigger unchanged;        (one list → many entries,
            TaskItem                           swap command list +        each = an editor.chain())
            Placeholder                        add dispatch)          Table family (-table/-row/-cell/
            Image                                                       -header)                [BUY]
            Markdown (tiptap-markdown)      WikiLinkExtension ─────▶  BubbleMenu (-bubble-menu)  [BUY]
            TaskAwareLink                     (insert [[Title]],       DragHandle (-drag-handle-  [BUY]
                                               Obsidian-native §2.2)
            custom handleKeyDown                                        react) — ⠿ grip + ＋
            isSourceRef save-sync guard                              TagNode (#tag inline atom) [BUILD]
                                                                     Callout (> [!kind] block)  [BUILD]
                                                                     Frontmatter wrapper (NOT a node)
```

**Design principle (frozen): one transform, three surfaces.** Slash menu, bubble "Turn into", and grip
block-menu all call the **same** node-conversion commands via a single tiny `block-transforms` module
(`turnInto / insertBlock / moveBlock / duplicateBlock / deleteBlock`). One tested path, one mental model,
one set of round-trip tests.

### 3.2 Packages, versions, configs

All new `@tiptap/*` packages publish on the **same 3.x major** as the installed base (3.26.0 available; we
run 3.20.1). **Decision (resolves editor open-decision #1): bump the whole `@tiptap/*` set to one matching
minor (e.g. 3.26.x) in a single `npm install`** to avoid peer-dep skew; `tiptap-markdown@0.9.0` is
compatible with TipTap 3.x. Install into **`web/`** (deps live in `web/node_modules`).

- **Table:** `@tiptap/extension-table` + `-table-row` + `-table-cell` + `-table-header`, `resizable: true`,
  **plus `align` cell attribute (`left|center|right`)**. **Cell content constrained to inline + hard-break
  only** (no block children, no merged cells in v1). **First row is ALWAYS all-`tableHeader`** — the schema
  forbids a header-less table and the UX **drops "toggle header off"** from the column menu (v1 = Notion
  *minus* the header-toggle; documented in §6.1 and §15). These two constraints together are what make the
  pipe path *always* takeable. **The shipped tiptap-markdown table serializer is NOT used** — we register
  our own (§6.1) because the shipped one loses alignment and HTML-blobs header-less tables (§0).
- **BubbleMenu:** `@tiptap/extension-bubble-menu` is **already installed at 3.20.1** (re-verified Round 1) —
  this is **wire-only, not a new dependency**. `shouldShow` = non-empty text selection, swaps to table ops
  when the selection is inside a table. Buttons call existing marks + the shared transforms — **no second
  conversion path.** Pure DOM overlay (no doc re-render).
- **DragHandle:** `@tiptap/extension-drag-handle-react` — a **single global widget** positioned by the
  hovered block. **Recommendation: BUY, do NOT hand-roll** a ProseMirror plugin / per-block NodeView:
  drag-reorder + gutter affordances are exactly the surface where the existing hand-rolled list code
  (`detachListItemChildren`, `tryJoinPreviousListAndSink`) proves subtle position-math bugs breed, and a
  NodeView would force every block to participate, fighting StarterKit + the task-list logic. The widget
  doesn't wrap nodes, so it composes cleanly.
  - **Gutter-room layout spike (required before E1 lands — addresses Round 1).** The editor renders in
    **two** narrow surfaces — `/notes` and the home/popup slide-out (`.notes-popup-body` /
    `.global-notes-body`) — and Walnut's own rule is "notes show in two places." The grip is a fixed-x
    gutter widget; a narrow popup may have **no left-gutter room**, so it could overlap text or clip at the
    container edge. **Acceptance:** verify gutter room in **both** surfaces; if a surface has none, the
    **defined fallback** is *grip overlays just inside the content's left padding* (never clips, never
    shifts text), and if even that is too tight the grip is **disabled in that surface** (Markdown
    shortcuts + slash menu remain the insert path there). Also **measure**, do not assert, the "no doc
    re-render" claim: a typing-latency probe on the large-note benchmark (§13.2) must show the widget adds
    no per-keystroke cost; if it does, wrap/throttle its position updates.
- **TagNode:** custom atomic **inline `Node`** (not a Mark) — gives whole-chip backspace-select natively;
  disk form is literal `#tag` text. (§3.4)
- **Callout:** custom **block `Node`** serializing to `> [!kind]` admonition — the single most-custom
  serializer; test effort concentrates here. (§3.4)
- **Divider + all basic styles:** **reuse, zero new code** — StarterKit `HorizontalRule` (`---`), and
  bold/italic/strike/inline-code/H1–H3/bullet/ordered/blockquote/checklist/links via StarterKit +
  `TightTaskList` + `TaskAwareLink`. Markdown shortcuts (`# `, `- `, `> `, ` ``` `, `[] `) **stay on** as
  the expert path producing the *same* nodes as the slash path — data never forks between a Markdown
  typist and a WYSIWYG clicker.

### 3.3 Slash menu — the day-one win (evolve, don't replace)

The trigger, range tracking, `coordsAtPos` positioning, above/below flip, click-outside, and
capture-phase keyboard nav **already exist and are correct.** Three additive changes:

1. **Replace the command list** (`slash-commands/types.ts`): the single `task` entry → a grouped block
   catalog (Basic / Lists / Blocks / Reference). **Extend `NoteSlashCommand`** (today `{name, description,
   icon, action}`) with `{ aliases: string[], group }` so the catalog can be filtered and rendered grouped.
2. **Add dispatch** (`SlashCommandPortal.tsx`): if the chosen command has `run`, call
   `cmd.run(editor, rangeRef.current)` then `onClose()`; the two **Reference** entries (Task reference,
   Link to note) keep their existing sub-panel behavior. Insertion is byte-clean:
   `editor.chain().focus().deleteRange(range).<blockCommand>().run()` removes the `/query` text, the block
   lands in its place, caret goes *inside* it — never a trailing space or blank line. **One transaction**
   per insert (§6.3) so it is a single `Cmd+Z`.
3. **Fuzzy filter** (`SlashCommandMenu.tsx`): replace `startsWith` with subsequence match over
   `name`+`aliases` so `/cl`→Callout, `/ck`→Checklist. Render **group headers** (Basic/Lists/Blocks/
   Reference) and **scroll the active item into view** on `↑/↓` (the fixed panel will overflow once the
   catalog grows to ~12 block types — today's single-entry panel never needed this). Keyboard nav,
   `onMouseDown preventDefault` focus-keep, and the IME/composition guard (§13.2) stay; empty state stays
   verbatim.

**Trigger policy — split by command class (corrected Round 2 + customer walkthroughs).** Today
`findSlashTrigger()` fires for **any** `/` preceded by whitespace, so typing `see foo /bar` opens the menu
mid-sentence. A naive tightening ("`/` only opens the menu at the start of an empty/whitespace-only block")
fixes block-insert safety but **silently removes a shipped capability**: inserting a **Task reference** or
**Link to note** *inline, mid-sentence* (e.g. "met with /[task]…"), which works today and which all three
customer personas reached for (a blanket "nothing happens mid-line" reads as **broken**, not safe).
**Decision — the trigger always opens, but what it OFFERS depends on context:**

- **`/` at the start of an empty / whitespace-only textblock** → the **full** catalog (block-level inserts:
  table/heading/divider/callout/code/lists/todo **plus** the inline Reference entries). The `deleteRange +
  insertBlock` path is guaranteed to land in a clean, empty block.
- **`/` after non-whitespace text in a non-empty block** → the menu **still opens**, but shows **only the
  INLINE-eligible subset** — *Task reference*, *Link to note*, and any inline transform — and, where it makes
  sense, "turn this block into…" entries. **Block-level inserts are hidden/disabled here** (they would split
  the paragraph), so the only actions offered are ones that are safe mid-block. This preserves the shipped
  inline-reference capability AND keeps block inserts from mangling a paragraph.
- (`/` mid-word like `a/b`, "and/or" — already never triggers; keep that.)

This matches Notion (where `/` is both an insert verb and a mid-line "turn into") more faithfully than a
blanket block-only gate. *Tested (§16):* (a) `/table` invoked **mid-paragraph** must **not** be offered /
must not split the paragraph; **and** (b) **`/[task-ref]` mid-sentence still works** (the inline subset is
offered) — a regression test against silently dropping the shipped capability.

The `＋` inserter (from DragHandle) opens this **same** menu with the **full** catalog, anchored to insert
below the hovered block — one menu, two entry points. Because `＋` always targets a fresh block position,
block-level inserts there are always clean regardless of the hovered block's content.

### 3.4 The two custom nodes (the only new serialization)

**`#tag` (atomic inline Node).** Renders as a styled chip; on disk it is **literal `#tag` text**
(greppable by the string index, plain text to `marked`). Trigger = `#` at line start or after whitespace
**immediately followed by a letter** (disambiguates `#1` in "issue #123" and the `# ` heading shortcut),
cloning the proven `WikiLinkExtension` plugin shape — not a new mechanism. Autocomplete = vault tags ranked
**by frequency** from `GET /api/notes-v2/tags` (§5), with a "+ Create `#…`" row always last. Backspace into
a committed chip selects the whole chip first (atom node gives this for free). Serializer:
`state.write('#'+name)`; parser: a `markdown-it` inline rule that fires only on `#`+letter and **not** at
heading-start (heading `# ` keeps winning).

**Tag disambiguation + selection spec (frozen — addresses Round 1).** The "`#`+letter after whitespace"
rule is necessary but not sufficient; these edge cases are defined and tested (§16):
- **`#` immediately after a non-space letter** (`C#`, `F#`, `objective-c#`) → **NOT a tag** (the trigger
  requires `#` at start-of-textblock or preceded by whitespace; a letter directly before `#` fails it).
  These stay literal text on disk and render as plain text.
- **`#` inside a URL / link** (e.g. `https://x/page#section`, or any `#frag` inside a `[...](...)` /
  autolink) → **NOT a tag** (URL/link tokenization owns those positions before the tag inline rule runs;
  the rule must run *after* link tokenization, like `WikiLink`).
- **Trailing-line chip** (`… #done` at end of a line, then save) → serializes as `#done` then the block's
  normal newline; re-parse re-nodifies it. No trailing space is added.
- **Copy a chip** → the clipboard receives **`#tag` plain text** (the atom's `renderText`/markdown serialize
  must produce `#tag`, not empty), so pasting into any app yields the literal tag.
- **Selecting across a chip boundary** (half-in/half-out) → the atom is included or excluded **whole**
  (atoms have no internal offsets); copy still yields `#tag` for the included atom.
- **Idempotency (round-trip gate, §6/§16):** `text → chip(parse) → serialize → text'` must be **stable** —
  no doubled `##`, no lost `#`, no chip duplication. This is the parse↔serialize agreement the finding
  flags: the markdown-it inline rule (parse) and `state.write('#'+name)` (serialize) are tested as an
  inverse pair on a fixture containing tags mid-sentence, at line end, adjacent to `C#`, and inside a link.

**Callout (block Node).** Disk form **frozen**: `> [!kind]\n> body…` (Obsidian/GFM admonition,
portable). Serializer writes `> [!${kind}]` then `wrapBlock('> ', …)` over the body; parser recognizes a
blockquote whose **first line is exactly `[!kind]`** and re-tags it (plain blockquotes stay blockquotes).
**Decision (resolves editor open-decision #3): v1 callout kinds = `note · tip · warning · danger · info`**
— this is the parser's `[!kind]` allow-set and the viewer styling set.

Both ride `tiptap-markdown`'s per-extension hook: `addStorage().markdown.{serialize, parse}`. Mechanism
(re-verified in source Round 1) — **the two directions use two different engines, and the doc states each
explicitly** (the finding correctly notes a prior draft conflated them):
- **Serialize = `prosemirror-markdown`.** `getMarkdownSpec(ext) = {...defaultSpec, ...ext.storage.markdown}`
  merges the node's `serialize(state, node)` into the single `MarkdownSerializerState` pass
  (`write`/`renderInline`/`wrapBlock`/`ensureNewLine`/`closeBlock`). No separate post-processor.
- **Parse = `markdown-it` → HTML → ProseMirror `parseDOM`** (verified in `MarkdownParser.js`). There is
  **no** prosemirror-markdown token reader on the parse side. A custom node's `parse.setup(md)` therefore
  must make markdown-it **emit HTML whose tags match the node's `parseHTML` rules** — *not* a ProseMirror
  token.
- **Callout parse, concretely:** markdown-it renders `> [!note]` as a plain `<blockquote>` with literal
  `[!note]` text (confirmed empirically). So the simplest, lowest-risk callout parse is a **`parse.updateDOM`
  DOM-rewrite**: find a `<blockquote>` whose first child's text is exactly `[!kind]`, strip that marker
  line, and re-tag the element so `parseHTML` adopts it as a callout. This is *the same shape* as the
  read-only viewer's `marked` post-pass (§7), keeping editor and viewer logic parallel — prefer it over a
  bespoke markdown-it block rule. Soft-break-vs-hard-break callout bodies are in the round-trip corpus (§6).
- **Tag parse:** a markdown-it inline rule that runs **after** link tokenization (so `#frag` in URLs is not
  consumed) and emits a `<span data-tag="…">` matching `TagNode.parseHTML`.

### 3.5 Wiki-link authoring — Obsidian-native (consumes §2.2, REVISED)

The `[[` autocomplete already has the target note in hand. It inserts the **Obsidian-native** form
(`[[Title]]`, plain text — trivial round-trip). **When the chosen note shares a basename with another note,
the autocomplete inserts the Obsidian-native PATH form `[[folder/Title]]`** to disambiguate (still 100%
Obsidian-portable — Obsidian resolves path-qualified links). A user-typed display alias uses Obsidian's real
`[[Title|shown]]` semantics. **No `n_id` is ever written into the link text.** "Create new" inserts
`[[Title]]`; the backend assigns the target note's id in frontmatter on first save. The editor stays
**stateless about identity** — it references the frontmatter+sidecar truth (the "don't cache remote truth
locally" principle); rename-proofness comes from the target's frontmatter id, resolved by the indexer, not
from anything baked into the link text.

### 3.6½ Newcomer on-ramp — a minimal P0 capture front door (addresses customer walkthrough)

**The gap (all three customer personas + PRD persona Sam).** The PRD's headline newcomer metric is
**"time-to-first-note ≤ 1.5 s, 0 required decisions"** (`01-product-design.md`), and the obvious vehicle —
Cmd+K Quick-capture — is reconciled to **P1** (§9.3). With Cmd+K gone from the P0 wave, **no always-available
capture/recall surface is specified for a butler user who is not already on `/notes`**, and no `/notes`
empty-state / "new note" affordance is specified anywhere. The newcomer's single most important journey
(make a note fast, from wherever I am) would be undesigned in v1 — a friction at the very first step, before
the editor or search can win them.

**Decision (frozen — v1 P0 ships a minimal capture front door that does NOT require the full Cmd+K surface):**
- **A "New note" affordance on `/notes`** (and the home/popup notes slide-out): a visible button that opens
  a **focused empty note with 0 required decisions** — no forced folder/tag/title, lands in a sensible
  default folder. This is the explicit P0 vehicle for the time-to-first-note metric. (It reuses the existing
  create path; it is **not** a new app-level key surface, so it carries none of Cmd+K's discard-guard /
  mode-routing test cost.)
- **`/notes` empty state** (zero notes, or first-run): shows the "New note" call-to-action and a one-line
  "type to capture; search finds it later" hint — never a wall of options.
- **Cmd+K remains the P1 upgrade**: when (if) it's pulled in (§9.3), it becomes the *ambient* capture
  surface from any page; the P0 "New note" button is the floor that guarantees the newcomer metric without
  it. This keeps the headline journey designed in v1 while honoring the P1 scope call on Cmd+K.

> This is the smallest thing that makes the newcomer's first step real without re-promoting the whole Cmd+K
> surface to P0. If the human owner pulls Cmd+K into P0 (§19), this button stays as the in-page entry point.

### 3.6 Frontmatter wrapper (consumes §2.1)

The id lives in frontmatter and must never be editable body (a stray edit could orphan every backlink).
**On load:** split `{frontmatter, body}`, feed only `body` to `setContent(...)`, stash `frontmatter` in a
ref. **On save:** re-attach the stashed frontmatter verbatim in front of `getMarkdown()` before `PUT`.
This is a **pure string wrapper** around the existing save/load — not a ProseMirror node — so the id
round-trips byte-for-byte and is unreachable by editing. A frontmatter *editing* node is a v1 non-goal.

---

## 4. Structural sidecar — `notes-index.sqlite` (root-cause fix for the O(n) scans)

`better-sqlite3` (installed), WAL mode, same construction pattern as `task-db.ts`. One migration file;
bumping `schema_version` triggers a rebuild (§8).

### 4.1 Schema (DDL)

```sql
-- One row per note. id is the stable identity from frontmatter (§2).
CREATE TABLE notes (
  id           TEXT PRIMARY KEY,        -- stable note id (frontmatter)
  path         TEXT NOT NULL UNIQUE,    -- vault-relative, fwd slashes ('Projects/Apollo.md')
  title        TEXT NOT NULL,           -- frontmatter.title || first H1 || basename
  content_hash TEXT NOT NULL,           -- sha256 of file bytes (skip-if-unchanged)
  body         TEXT NOT NULL,           -- markdown body WITHOUT frontmatter (snippets/FTS)
  frontmatter  TEXT,                    -- raw YAML block (round-trip fidelity)
  created      TEXT,
  modified     TEXT NOT NULL,           -- ISO (file mtime)
  size         INTEGER NOT NULL
);
CREATE INDEX idx_notes_path  ON notes(path);
CREATE INDEX idx_notes_title ON notes(title COLLATE NOCASE);

-- Directed link edges. Resolved by id; unresolved/ambiguous kept for UI honesty.
CREATE TABLE links (
  src_id   TEXT NOT NULL,               -- note containing the link
  dst_id   TEXT,                        -- resolved target id, NULL if unresolved
  dst_name TEXT,                        -- raw [[name]] as authored (display + re-resolve)
  status   TEXT NOT NULL,               -- 'resolved' | 'unresolved' | 'ambiguous'
  context  TEXT,                        -- ±N chars around the link (backlink snippet)
  PRIMARY KEY (src_id, dst_name, context)
);
CREATE INDEX idx_links_dst ON links(dst_id);   -- backlinks: WHERE dst_id = ?
CREATE INDEX idx_links_src ON links(src_id);   -- forward links / cleanup on change

-- Tag edges. Slugs normalized (lowercase, no leading '#', spaces→'-').
CREATE TABLE tags (
  note_id TEXT NOT NULL,
  tag     TEXT NOT NULL,
  PRIMARY KEY (note_id, tag)
);
CREATE INDEX idx_tags_tag ON tags(tag);        -- "notes with tag X": WHERE tag = ?

-- Substring / keyword search over body + title (FTS5).
-- NOTE (corrected Round 1): this is NOT "contentless" — using a plain FTS5 table here duplicates all
-- note text (it lives in both notes.body for the LIKE fallback AND notes_fts.body). v1 ships an
-- external-content FTS5 table to avoid the 2× text duplication: content='notes', content_rowid points
-- at a notes rowid, so FTS stores only the index, not a second copy of the body.
-- FTS5 MAINTENANCE (pinned Round 2 — an external-content FTS5 table is NOT auto-maintained):
--   On UPDATE/DELETE you MUST issue the FTS5 'delete' command WITH THE OLD column values, THEN insert the
--   new ones — a bare re-insert leaves a stale, still-matchable index entry. There is NO per-row "rebuild":
--   INSERT INTO notes_fts(notes_fts) VALUES('rebuild') is a WHOLE-TABLE O(vault) op, reserved for cold
--   rebuild only (§12), NEVER the per-save path. v1 uses the THREE standard external-content triggers below
--   so SQLite keeps the index coherent automatically (alternative: the reconciler reads the pre-update row
--   and issues delete-old/insert-new by hand). On-disk budget is surfaced via GET /index/status.
--
--   CREATE TRIGGER notes_ai AFTER INSERT ON notes BEGIN
--     INSERT INTO notes_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
--   END;
--   CREATE TRIGGER notes_ad AFTER DELETE ON notes BEGIN
--     INSERT INTO notes_fts(notes_fts, rowid, title, body) VALUES('delete', old.rowid, old.title, old.body);
--   END;
--   CREATE TRIGGER notes_au AFTER UPDATE ON notes BEGIN
--     INSERT INTO notes_fts(notes_fts, rowid, title, body) VALUES('delete', old.rowid, old.title, old.body);
--     INSERT INTO notes_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
--   END;
CREATE VIRTUAL TABLE notes_fts USING fts5(
  title, body,
  content = 'notes', content_rowid = 'rowid',   -- external content: no second copy of body
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE index_meta (key TEXT PRIMARY KEY, value TEXT);  -- schema_version, last_full_rebuild, doc_count
```

**Why FTS5 *and* a `LIKE` fallback (with honest complexity labels — corrected Round 1):** the PRD requires
"any exact substring that exists returns its note(s) — 100%." FTS5 gives **sublinear (≈O(log n))**
prefix/token matching for the common case. But FTS5 **cannot** do mid-token substring — `MATCH 'pollo'`
does not find `Apollo` (verified). For true arbitrary mid-token substring we fall back to `LIKE '%q%'` over
`notes.body`. **That `LIKE` leg is NOT O(log n)**: a leading wildcard cannot use any index — `EXPLAIN QUERY
PLAN` shows `SCAN notes`, an **O(n)-rows in-memory scan**. The performance *conclusion* still holds (it
scans in-RAM SQLite pages, not N filesystem reads — measured ~0.05 ms at 20k×2KB rows, ~6000× under the
300 ms budget), but the design states it honestly: **FTS path = O(log n)-ish; LIKE fallback = bounded O(n)
in-DB scan**, acceptable because `n×bytes` in RAM ≪ `n` file reads. **Guardrails:** only fall to `LIKE`
when FTS5 returns too few hits, and **cap scanned rows** so a pathological query can't become a hot path; a
latency regression test runs at 5k/20k rows (§16). If mid-token substring ever becomes slow on a very large
vault, the real O(log n) fix is an FTS5 **`trigram`** tokenizer (noted in §17). FTS5 is built into the
`better-sqlite3` SQLite build already in use.

### 4.2 What it replaces (1:1 with the O(n) scans)

| Old O(n) **file-read** scan | New in-DB query (complexity labeled honestly, §4.1) |
|---|---|
| `/search` substring | `SELECT … FROM notes_fts WHERE notes_fts MATCH ?` (O(log n)-ish) + capped `LIKE` fallback for mid-token (bounded O(n)-rows in-RAM, **not** O(n) file reads) |
| `/backlinks/*path` | `SELECT src… FROM links WHERE dst_id = (SELECT id FROM notes WHERE path=?)` |
| `/list` (wiki autocomplete) | `SELECT id,title,path FROM notes ORDER BY title` (now returns `id` — feeds §3.5) |
| tag browse (new) | `SELECT note_id FROM tags WHERE tag = ?` |
| `updateWikiLinksInAll` (rename) | **removed** — links key on id |

Three scans, **one** root cause (no derived index keyed on identity), fixed **once**.

### 4.3 Link resolution (consumes §2.2)

In the reconciler (REVISED for the Obsidian-native link form, §2.2): if the link is a **path form**
(`[[folder/Title]]`) → resolve by `path` (exact, collision-free). Else treat as a **name** (`[[Title]]`, or
the display part before a real `|alias`) → look up `title`/basename; exactly one match → resolve; multiple →
`status='ambiguous'`; none → `status='unresolved'` (re-resolved later when the target appears). In every
resolved case the edge is then **keyed on the target note's stable frontmatter `id`** (`links.dst_id`), so the
edge survives the target's rename. (Legacy/bare `[[n_id]]` text from the earlier draft, if any exists, still
resolves by id — but the editor no longer authors it.) Deleting a note marks inbound edges `unresolved` (not
deleted) so backlinks stay truthful.

**Ambiguous-edge UX (frozen — addresses Round 1).** During the transition window two id-less notes can
legitimately share a basename, so a name-based link is genuinely ambiguous. The product must neither
silently drop it nor silently duplicate it under both notes:
- **Backlinks panel** renders an ambiguous inbound edge **explicitly** — "links to one of N notes named
  *X*" with the candidates listed — rather than showing nothing or showing it under every candidate. The
  `links` row keeps `status='ambiguous'` and (optionally) a JSON candidate-id list for the panel.
- **Rename** **refuses-or-warns** when it would create a *second* id-less note with an existing basename
  (the only way to manufacture a fresh ambiguity): warn "another note is named *X*; links by name will be
  ambiguous — assign ids?" and offer the one-click "stamp ids" action (§12). Renaming a note that already
  has an id is always safe (links key on id).
- Tested by the "two same-basename id-less notes" case in the rename-integrity suite (§16) — the prior
  test plan only covered the post-id case.

---

## 5. Semantic sidecar — widen coverage, then expose (mostly already done)

### 5.1 Fix the coverage gap (one-time glob widen — but NOT on the save hot path)

`getNotesStore()` maps four PARA collections (`qmd-store.ts:67-70`); notes in arbitrary folders are never
embedded. Replace with **one whole-vault collection** (the config block + the critical hot-path rule are
shown together at the end of this section).

Collapse `memory-search.ts` `SOURCE_WEIGHTS` `note_areas/projects/resources/archive` (`memory-search.ts:26-29`)
→ a single `note_vault` weight. **Two side effects, called out explicitly (corrected Round 1 — these are
behavior changes, not "all 1.0"):** (1) today `note_resources=0.9` and `note_archive=0.5` **down-weight**
those folders — collapsing to one weight **drops that bias**; (2) `archive` has `includeByDefault:false`
today, so a single always-searched `vault` collection **flips Archive from excluded to searched.** Archive
becoming searchable is probably desirable, but it *is* a change — surfaced here, not silent. If
down-weighting archived/resource notes still matters, **derive it from the `path` prefix at rank time** (a
cheap multiplier in the blend), **not** from QMD collections.

**The hot-path trap (BLOCKING in Round 1 — do NOT call `store.update()` on save).** Widening the glob is
*not* "a tiny one-line prerequisite with the QMD path untouched." I re-read the installed QMD source:
`store.update()` → `reindexCollection()` (`@tobilu/qmd/dist/store.js:863`) does, on **every** debounced
change: (1) `fastGlob` the whole collection, (2) **`readFileSync` each file synchronously** (line 892),
(3) SHA-256 each. Measured against the real vault (already **1,566** `.md` files, not the handful the
PARA-only store sees today): **~456 ms of event-loop-blocking work per `update()` pass**, projected ~1.5 s
@5k and ~5.8 s @20k. Today this is masked because `getNotesStore()` only globs four PARA folders; widening
to `**/*.md` **exposes the full cost** and re-introduces the exact event-loop-starvation class this project
was already burned by twice (MEMORY: `event_loop_blockers`, `unbounded_debug_logging_starves_event_loop` —
"all HTTP 15 s timeouts + RSS 12 GB"). `embed()` itself is already incremental (`getPendingEmbeddingDocs`)
— it is `update()`'s scan that is O(n).

**Fix (the pattern already exists in-repo).** The per-path reconciler (§8.2) that feeds
`notes-index.sqlite` **also drives the semantic store one changed file at a time**, using QMD's
programmatic API exactly as `qmd-task-sync.ts` already does — `insertContent`/`insertDocument` (with
SHA-256 hash-skip) on write, `deactivateDocument` on delete, then the **already-incremental** `embed()`.
**`store.update()`'s full glob+read+hash scan is reserved for cold rebuild / startup only** (§12) — the
same "O(n) once, off the query path" pattern §12 already accepts. **Benchmark gate (§16):** per-save
semantic reconcile stays **sub-50 ms and never blocks the loop**, asserted at a synthetic 5k-note vault.

```
collections: {
  vault: { path: NOTES_DIR, pattern: '**/*.md', ignore: ['global-notes.md', '.*/**'] }
}
// One whole-vault collection for COLD rebuild / startup glob only.
// Per-save: reconcileNote() → qmd.insertContent/insertDocument/deactivateDocument(changed file) → embed()
//           (NEVER store.update() on the save path).
```

### 5.2 Expose via the existing blend

`memoryNotesSearch(queries, ['note_vault'], limit)` already returns ranked semantic hits with snippets —
reused **verbatim**, the same call shape `core/search.ts` uses for memory/tasks. Nothing new in the
semantic layer beyond the source-name change.

---

## 6. Editing-integrity contracts — round-trip, table serializer, external-sync, undo/redo

Markdown is the storage format, so a lossy serializer is silent data loss; and the editor is the #1
priority, so a teleporting caret or a half-reversed `Cmd+Z` is just as disqualifying. This section freezes
**four** contracts: the per-block round-trip matrix + acceptance gate (below), the **owned table
serializer** (§6.1), the **external/AI-write merge & cursor-mapping** policy (§6.2), and the **undo/redo
contract** (§6.3). The latter three were "assumed solved" before Round 1; they are now owned and tested.

| Block | Disk form | Round-trip risk | Strategy (frozen) |
|---|---|---|---|
| **Table** | GFM pipe `\| a \| b \|` **with alignment row `\| :-- \| --: \|`** | The **shipped** `tiptap-markdown` serializer (1) HTML-blobs any table whose first row isn't all-`tableHeader` or any cell `childCount>1`/has span, (2) **emits no alignment** (hardcodes `---`), (3) **does not escape `\|`** in cell text → alignment loss + literal-pipe breakage + non-portable HTML islands | **Own the serializer** (§6.1): emit GFM alignment from the cell `align` attr, escape `\|` in cell text. **Constrain the schema/UI**: first row always all-`tableHeader` (no header-toggle-off), inline+hard-break cells, no merged cells. **Assert no table ever serializes to `<table` HTML.** **#1 data-integrity risk; frozen contract.** |
| **`#tag`** | literal `#tag` text | A Mark would split `#` across nodes; markdown-it could swallow `#` as heading at line start; parse↔serialize disagreement could double the `#` | Atomic inline **Node**; serialize `#name`; parse inline rule fires **only** on `#`+letter, **not** at heading-start, **after** link tokenization. Idempotent round-trip + `C#`/`F#`/in-link/trailing-line cases tested (§3.4). Plain text to `marked`. |
| **Callout** | `> [!kind]\n> body` | The only fully-custom serializer; nested body must keep `> `; parser must not capture a plain blockquote | `wrapBlock('> ', …)` body; parse rule requires first line `[!kind]`. Test both directions + a blockquote-that-looks-like-a-callout. |
| **Task list** | `- [ ] ` / `- [x] ` | Historic: "loose" lists re-inserted blank lines (the `TightTaskList` saga) | **Keep `TightTaskList` exactly as is.** No new block may change list tightness. In the regression suite. |
| **Wiki-link** | **Obsidian-native** `[[Title]]` / `[[folder/Title]]` / `[[Title\|alias]]` (§2.2) | Must be byte-identical to what Obsidian reads/writes (portability for persona P1) — **no `n_id` in link text** | Authoring inserts plain Obsidian-native text; `\|` keeps Obsidian's real alias meaning; resolution keys on the target's frontmatter id, not the link text. Round-trip is trivial. |
| **Images** | `![](url)` / `<img>` | `Markdown({html:true})` already needed; base64 paste exists | Unchanged — keep `Image.configure({inline:true, allowBase64:true})` + existing paste/drop. |
| **Frontmatter** | `---\n…\n---` | A stray body edit could corrupt the `id` | **Never an editor node** (§3.6). Stripped on load, re-attached verbatim on save; preserved in `notes.frontmatter` for fidelity. |

**The acceptance gate (frozen P0 quality gate, PRD Risk #2).** A **round-trip corpus** of `.md` files,
**expanded in Round 1** so it tests the cases real users actually hit (the prior corpus only tested
header-full inline tables, which would pass while the product corrupted alignment/header-less tables). The
corpus MUST include, at minimum:
- **Tables:** header-full; a **single-row** table; **left / center / right-aligned** columns; a cell whose
  text contains a **literal `|`**; a cell with inline code containing `|` (**assert the code span survives
  intact** — text after the pipe is not lost, per §6.1); a cell whose **on-disk source already contains an
  escaped `\|`** authored by the user (both plain and inside inline code) — **assert idempotency**:
  load→save reproduces exactly `\|` (no double-escape to `\\|`, no unescape to a raw `|` that would truncate
  the cell); **empty cells** (`| |`); a cell with leading/trailing spaces. (Header-less tables are
  **schema-forbidden** in v1, so the corpus instead **asserts** the UI cannot produce one.)
- **Tags:** `#tag` mid-sentence, at line end, adjacent to `C#`, inside a link.
- **Callout:** soft-break body vs hard-break body; a plain blockquote that merely *looks* like a callout.
- **Combos:** table inside a doc with lists; callout containing a list; mixed headings; code fences
  containing `|`.

**Two-level gate (strengthened Round 1):** (1) **byte-for-byte** `serialize(parse(md)) === md` after one
agreed normalization pass (trailing newline); **and** (2) **node-level** `parse(serialize(doc))` deep-equals
`doc` at the ProseMirror-node level — because byte-equality alone won't catch a table that silently becomes
a *paragraph* if both sides normalize identically. (3) **An explicit assertion that NO table in the corpus
ever serializes to `<table` HTML.** Runs in CI before **any** new block lands, and specifically **before
the table extension ships (E2)**. Same discipline `TightTaskList` earned the hard way.

### 6.1 The owned table serializer (replaces the shipped one — BLOCKING fix)

**Why we cannot use `tiptap-markdown`'s table serializer.** Re-read first-hand in
`tiptap-markdown/src/extensions/nodes/table.js` (§0): `isMarkdownSerializable(node)` returns **false** —
silently falling back to **raw `<table>` HTML** — the instant (a) any first-row cell is not a `tableHeader`
(i.e. the user toggled the header row off, which the UX explicitly offered) **or** (b) any cell
`childCount > 1`/has a span. And even on the happy path it writes the delimiter row as
`Array.from(...).map(() => '---')` (**no alignment**) and `renderInline`s cell text with **no `\|`
escaping**. Net: every alignment a user sets is discarded on the next autosave, a header-less table becomes
a non-portable, non-greppable HTML island, and a literal `|` in a cell breaks re-parse.

**Decision (frozen).** v1 **registers its own table `addStorage().markdown.serialize`** on the table node
(the per-extension hook overrides the shipped spec — verified mechanism, §3.4), and **constrains the schema
+ UI** so the pipe path is the *only* path:
- **Serializer emits GFM alignment** from each column's `align` cell attr: header row `| h1 | h2 |`, then a
  delimiter row of `:--` (left) / `:-:` (center) / `--:` (right) / `---` (none) per column. markdown-it
  **preserves these on parse** (verified: `:--`→`text-align:left`, etc.), so alignment round-trips.
- **Serializer escapes `\|`** for **every literal pipe in cell content, INCLUDING inside inline-code
  spans** — i.e. the escape pass must run inside `renderInline` of code marks, not only on plain text.
  *(Verified empirically on the installed `markdown-it@14.1.1`: a **raw** `|` inside an inline-code span in
  a cell is consumed as a column delimiter and **truncates the cell** — `` `x|y` `` re-parses to
  `<td>`x</td>` with the `y` tail silently lost. The escaped form `` `x\|y` `` round-trips intact to
  `<td><code>x|y</code></td>`.)* The contract is "emit Markdown our own parser provably reads back"; the
  round-trip corpus's **"cell with inline code containing `|`"** fixture must assert the **code span
  survives intact** (text after the pipe is not lost), not merely that "a table re-parses."
- **Schema/UI constraint (resolves the header-toggle gap):** the table schema requires the **first row to
  be all `tableHeader`**, and the column menu **omits "toggle header off"** (the one UX control that would
  produce a header-less table). v1 ships **Notion *minus* the header-toggle** — documented as a conscious
  v1 limitation here and in §15. Cells are **inline + hard-break only**, **no merged cells** → `childCount`
  stays 1 and no span ever appears, so the shipped serializer's HTML-fallback conditions are unreachable
  *and* our own serializer never has to handle them.
- **Viewer parity (§7):** the read-only `marked` path already renders GFM alignment, so the aligned table
  renders identically in snippets/backlinks/mobile.

> **Contingency (Round 1 dependency note):** the whole round-trip strategy rides on `tiptap-markdown@0.9.0`
> — the latest published version, a 0.x effectively frozen and pinned to `markdown-it@14`. **Pin it
> exactly** (not `^0.9.0`) to avoid an unreviewed bump. If a future TipTap major breaks it, the fallback is
> the package's own per-extension `serialize`/`parse` hooks (which we are *already* using for table, tag,
> callout) re-homed onto `prosemirror-markdown` directly — no rewrite. State this so the team isn't
> surprised later.

### 6.2 External / AI-butler writes mid-edit — merge & cursor-mapping (BLOCKING fix)

**The problem (re-verified Round 2 in the REAL state owner `web/src/hooks/useNoteContent.ts`, not just
`NotesEditor.tsx:494-532`).** Two distinct paths apply external content, and they behave **inconsistently**
today — a Round-2 Bar Raiser caught that a prior draft of this section promised a contract the shipped code
contradicts:

1. **The WS/AI path** — `useEvent('notes:updated', …)` on a genuine external/AI write **cancels the pending
   save and calls `reloadContent()` with NO dirty check**, which runs `setContent` (the full-replace +
   absolute-offset-restore branch in `NotesEditor.tsx:494-532`) — i.e. it **already blows the live doc away
   mid-edit**, dropping the caret to a meaningless offset.
2. **The visibility/focus path** — on the *same* hook — **already guards** with
   `if (dirtyRef.current) return; // don't overwrite unsaved user edits`. So the codebase **already has the
   exact "defer-while-dirty" pattern in one path and deliberately omits it on the WS/AI path.**
3. **The 409 save path** — carries an explicit, deliberate comment: *"409 Conflict — agent writes take
   priority over unsaved user edits; at most ~500 ms of typing may be lost due to the debounce window,"* and
   on 409 it calls `reloadContent()` (discards local). So the shipped optimistic-lock design **intentionally
   drops up to one debounce window of the user's typing on a true write-write conflict** (agent-wins).

The earlier draft of this section simultaneously promised "zero lost characters" **and** "keep the existing
optimistic-lock 409 path." Those cannot both be true: the 409 path as shipped discards the local edit. This
section reconciles the conflict explicitly and replaces the impossible absolute with the honest bound.

**Decision (frozen — chosen policy = "user-edits-win-while-dirty for NON-conflicting writes; agent-wins only
on a true write-write conflict, with an honest bound"):**

1. **Defer-while-dirty on ALL external-apply paths (this REVERSES the WS/AI path's current behavior).** If
   the editor is **dirty** or **actively composing/typing** when an external `notes:updated`/PUT arrives,
   **do not apply it immediately.** The **WS/AI handler must gain the same `if (dirtyRef.current) return;`
   defer-guard the visibility path already has** — today it lacks it, which is the bug. Hold the incoming
   content and surface a **non-destructive affordance** (a subtle "note changed on disk — reload" banner).
   Apply automatically once the editor goes **idle and clean** (debounced), or when the user clicks reload.
   The live document is never replaced underneath an in-flight edit.
2. **Position MAPPING, not offset restore.** When an external change *is* applied to a clean doc, map the
   selection **through the change** (compute a ProseMirror **step/diff** old→new, or apply the change as
   ProseMirror steps, then `Transform.mapping.map(pos)`) so the caret survives content shifts above it. Full
   `setContent` + raw-offset restore is **banned** for the external-sync path.
3. **Conflict honesty — the HONEST bound (replaces "zero lost characters").** On a **true write-write
   conflict** (both on-disk and local-dirty diverged → the optimistic-lock 409), the shipped policy is
   **agent-writes-win** and the user may lose **at most one debounce window (~500 ms) of un-flushed typing**.
   We **keep that policy** (it is load-bearing for butler correctness — the agent's write reflects an
   action it just took) but we make the bound **explicit and surfaced**, not silent: on 409, before
   discarding, show the user the conflict (offer "your unsaved change vs. the version on disk") rather than a
   bare silent reload. **Non-conflicting external writes never lose input** (they defer, per part 1). The
   honest contract is therefore: *"a non-conflicting external/AI write never loses a character or moves your
   caret; a true write-write conflict may lose at most one debounce window of un-flushed typing, and is
   surfaced, never silently dropped."*

> **Why not user-wins-on-conflict too?** Making the user always win would silently reverse the long-standing
> "agent writes take priority" decision, which may be load-bearing (the butler's note edit often *is* the
> source of truth for an action it performed). Flipping it is a product call, not a tech-design default —
> logged as an unresolved decision (§19) for the human owner. Until then we keep agent-wins-on-true-conflict
> with the honest, surfaced bound above.

**Test (new E2E, §16) — assert against the CHOSEN policy, not an impossible one:** (a) type continuously
while a **non-conflicting** external `PUT` lands for the same note → assert **zero lost characters** and a
**stable caret** (it deferred); (b) a **dirty** editor receiving a WS `notes:updated` shows the reload
affordance and does **not** self-replace (regression test for the missing WS-path guard); (c) a **true 409
conflict** surfaces the conflict to the user (not a silent discard) and loses **at most one debounce
window** — asserted as the explicit bound, not "zero."

### 6.3 Undo/Redo contract — one user action = one `Cmd+Z` (BLOCKING fix)

None of the three docs specified undo/redo before Round 1, yet the chosen architecture actively endangers
it, and granular-by-accident undo ("undo does half of what I did") is one of the most viscerally un-Notion
failures. Two concrete hazards verified in source:
- **Today's Tab is already 2+ undo steps.** `tryJoinPreviousListAndSink` and `detachListItemChildren` each
  do a **raw `editor.view.dispatch(tr)`** (`NotesEditor.tsx:180, 262`) *separate* from the
  `sinkListItem` command (lines 183-184, 471-473). So a single Tab today is multiple transactions → multiple
  `Cmd+Z`.
- **The shared-transform spine compounds it.** `turnInto`/`insertBlock`/`moveBlock` and the slash insert's
  `deleteRange(range).<cmd>()` are multi-op; the off-the-shelf drag-handle drop may emit several
  transactions; a table row/col op is several steps.

**Decision (frozen): every user-perceived block action is a SINGLE undoable step.** Concretely:
- The `block-transforms` module builds each operation as **one `chain()` / one transaction** (not sequential
  `dispatch`es). Slash insert = one transaction (`deleteRange` + insert composed).
- **Fold the existing Tab logic into one transaction:** `detachListItemChildren` /
  `tryJoinPreviousListAndSink` must be merged into the **same** transaction as the sink (build one `tr`,
  dispatch once) so one Tab = one `Cmd+Z`. This is a small refactor of code that already exists — done as
  part of E1 (before tables/drag layer on).
- **Drag-handle drop** must register as a **single history step**; if the off-the-shelf widget emits
  multiple, **wrap the drop** so history sees one step.
- **Table add/del row+col, tag insert/delete, callout turn-into** each = one step.

**Regression suite (§16):** "one user action = one `Cmd+Z`" asserted for each — slash insert, turn-into,
drag-reorder, table add/del row+col, tag insert/delete, **and the existing list Tab** (which regresses to
2 steps today and must be fixed to 1).

---

## 7. Two-engine viewer consistency (editor `markdown-it` vs read-only `marked`) — named risk

The rendered view (search snippets, backlinks panel, mobile) uses **`marked`** + DOMPurify, a *different*
parser. Every new construct gets a viewer-side decision **in the same change** as its editor node:

| Construct | Editor (markdown-it) | Viewer (marked) today | Fix |
|---|---|---|---|
| Table | pipe → table node | GFM tables on → renders | already consistent |
| `#tag` | chip node | plain `#tag` text | small `notes-markdown.ts` post-pass wraps `#tag` in a styled span (display-only; greppable either way) |
| Callout | callout node | blockquote + literal `[!kind]` | `notes-markdown.ts` post-pass: blockquote whose first line is `[!kind]` → styled callout `div` |
| `[[Title]]` / `[[folder/Title]]` / `[[Title\|alias]]` (Obsidian-native, §2.2) | autocomplete + plain text | same literal | viewer renders the link (path or title → resolve via index; `\|alias` shows the alias, Obsidian semantics) |

**Decision (resolves editor open-decision #4): extend the existing `marked` pipeline with tag/callout
post-passes** (low risk). Unifying both surfaces on one renderer is a larger, separate effort, out of
scope for v1. **Rule:** never ship an editor block whose disk form renders as raw junk in the read-only
view.

**Sanitize ordering (frozen — addresses Round 1; correctness *and* security).** The viewer pipeline is
`marked.parse → notePurify.sanitize` with a tight `ADD_ATTR` allowlist (`markdown.ts:690`). The tag/callout
post-passes **run BEFORE DOMPurify** and emit **only allowlisted structure** — never inject markup after
the sanitize step (that would bypass the trust boundary). The callout `<div>` and tag `<span>` need a
`class` attr (and the callout its `data-kind`), so **extend the `ADD_ATTR` allowlist deliberately**
(`class`, `data-kind`) rather than letting unsanitized HTML through. No raw user HTML ever reaches the
styled span/div; DOMPurify remains the single trust boundary (§13.3).

**Parser-parity corpus (added to CI — addresses Round 1).** Because the editor (`markdown-it`) and viewer
(`marked`) are two parsers, every block needs two implementations kept in lockstep, and subtle GFM
differences (e.g. a `|` inside a cell, alignment) can make a snippet/backlink render differently from the
editor. A **parser-parity corpus** renders the **same** `.md` through both paths and **diffs the semantic
structure for every block type**, run in CI alongside the round-trip corpus (§16). Long-term, unifying on
one renderer is logged as tech-debt (§17) since the divergence cost compounds with every block added.

---

## 8. The reconciler — incremental, debounced, rebuildable (one watcher, two consumers)

Reuse the **exact** patterns already in the codebase: `qmd-watcher.ts` debounce, `qmd-task-sync.ts`
hash-skip + programmatic upsert, `file-lock.ts` cross-process locks, `event-bus.ts` `interest`-set
filtering. **No new concurrency primitive is invented.**

### 8.1 Triggers (two paths, same handler)

1. **In-process (fast path):** `PUT/DELETE /content`, `POST /move`, `POST /folder` emit `NOTES_UPDATED`.
   The indexer subscribes via `bus` using the **`interest`** set (so it only wakes for note events — the
   same mechanism that fixed event-loop starvation, `event-bus.ts`) and reconciles **just the changed
   path**, debounced ~300 ms to coalesce autosaves.
2. **Filesystem (catch-all):** add a **second debounced callback inside the existing**
   `fs.watch(NOTES_DIR,{recursive})` block in `qmd-watcher.ts` → `scheduleNotesIndexUpdate(filename)`,
   debounced ~1 s (faster than QMD's ~5 s embed — structural parsing is cheap, no model). Catches external
   edits, git pulls, and AI-butler writes.

> **One inotify registration, two consumers (structural + semantic).** We do **not** add a second
> `fs.watch`.

**Per-path coalescing — NOT a single global timer (addresses Round 1).** The existing `debounce()` in
`qmd-watcher.ts` is a **single global timer with no per-path keying** — under a burst (git pull / AI-butler
batch writing many files) that would collapse to "reconcile the last file only" or re-fire repeatedly. The
notes reconciler instead uses a **coalescing queue**: a `Set<relPath>` of dirty paths plus one debounce; on
fire it **drains the set and reconciles all queued paths inside a single `better-sqlite3` transaction**
(`db.transaction()`, the pattern `task-db.ts` already uses). The queue is **bounded**; a 500-file pull
becomes **one transaction + one debounced QMD pass**, not 500 interleaved reconciles. (A per-path
`Map<path, timer>` is the simpler alternative if a queue is overkill; either is acceptable, a single global
timer is not.) Tested by a **"reconcile storm"** case — a bulk multi-file write, not just one note (§16).

### 8.2 Per-note reconcile (pseudocode)

```
function reconcileNote(relPath):
  abs = NOTES_DIR/relPath
  if not exists(abs):                                  # deletion
      withFileLock(notes-index.sqlite):
        id = SELECT id FROM notes WHERE path=relPath
        DELETE notes/links(src=id)/tags/notes_fts for id
        UPDATE links SET dst_id=NULL,status='unresolved' WHERE dst_id=id   # keep backlinks honest
      QMD.store.deactivateDocument('notes', virtualPathFor(relPath))       # existing API
      return

  bytes=read(abs); hash=sha256(bytes)
  if (SELECT content_hash FROM notes WHERE path=relPath) == hash: return    # hash-skip (task-sync)

  { data, body } = parseFrontmatter(bytes)
  id    = data.id || assignNewId()                     # assign + careful back-write if missing (§8.3)
  title = data.title || firstH1(body) || basename(relPath)
  tags  = normalizeTags(data.tags) ∪ inlineHashtags(body)
  links = extractLinks(body)                           # [[id]] / [[name|id]] / [[name]]

  withFileLock(notes-index.sqlite):                    # cross-process safe; one db.transaction()
    UPSERT notes(...)        # ↳ the three external-content FTS5 triggers (§4.1) keep notes_fts coherent
                             #   (delete-OLD-then-insert-NEW) automatically — NO manual notes_fts write,
                             #   and NEVER the whole-table VALUES('rebuild') on this per-save path.
    DELETE+INSERT links (resolve names→ids, §4.3); DELETE+INSERT tags
    UPDATE links SET dst_id=id,status='resolved' WHERE dst_name=title AND dst_id IS NULL  # re-resolve inbound

  # SEMANTIC store, driven PER-FILE (NOT store.update() — §5.1 hot-path fix):
  #   EXACT two-call shape qmd-task-sync.ts:62-86 uses (verified against @tobilu/qmd store.js:1486/1493/1507).
  #   content is content-addressable BY HASH (no collection/path arg); the collection↔path↔hash mapping
  #   is a SEPARATE insertDocument/updateDocument call; hash-skip is done by the caller via findActiveDocument.
  docPath = virtualPathFor(relPath)
  existing = QMD.store.internal.findActiveDocument('notes', docPath)
  if existing and existing.hash == qmdBodyHash(body):   # already up to date — skip (mirrors task-sync)
      pass
  else:
      QMD.store.internal.insertContent(qmdBodyHash(body), body, nowIso)          # (hash, content, createdAt)
      if existing:
          QMD.store.internal.updateDocument(existing.id, title, qmdBodyHash(body), nowIso)   # (id, title, hash, modifiedAt)
      else:
          QMD.store.internal.insertDocument('notes', docPath, title, qmdBodyHash(body), createdIso, nowIso)
      QMD.store.embed()                                  # already incremental (getPendingEmbeddingDocs)
```

> **API note (corrected Round 2).** The semantic-store calls above mirror `qmd-task-sync.ts:62-86`
> **exactly**: `insertContent(hash, content, createdAt)` is content-addressable **by hash** — it has **no**
> collection/path arg and **no** `{hashSkip}` option; the collection↔path↔hash mapping is the **separate**
> `insertDocument(collection, path, title, hash, created, modified)` / `updateDocument(id, title, hash,
> modified)` call; and hash-skip is the **caller's** job via `findActiveDocument(collection, path)` then
> comparing `.hash`. (`qmdBodyHash` is QMD's own content hash, distinct from the structural sidecar's
> `content_hash` over the full file bytes.)

> **Why per-file, not `store.update()` (§5.1).** `store.update()` synchronously globs + `readFileSync` +
> hashes the **whole** vault (~456 ms today @1.5k files, ~5.8 s @20k) — calling it on every save would
> starve the event loop. The reconciler touches exactly the one changed file both for the structural index
> **and** the semantic store. `store.update()` is for cold rebuild/startup only (§12). **Both consumers are
> per-changed-path and off-loop; nothing on the save path is O(vault).**

### 8.3 id back-write (the one subtle write — P0 zero-data-loss)

When a note lacks `id`, the indexer persists one into frontmatter (the only case it writes a `.md`):
- `withFileLock(<note>.md)` (per-note lock, distinct from the index lock); re-read under lock; re-check
  `id` absent.
- Splice the `id:` line into existing frontmatter (or prepend a new block), preserving the rest
  **byte-for-byte** (no reformat).
- Write, then emit `NOTES_UPDATED` with the new `contentHash` so optimistic-lock clients refresh their
  expected hash (avoids a spurious 409 on the next save).
- **Editing-quality guard:** never back-write while the note is actively edited — if the file's current
  hash ≠ what we read, **skip this cycle, retry next reconcile.** The indexer can never clobber an
  in-flight edit.

> **Where, not whether.** id assignment lives in the **reconciler**, not `PUT /content`, because files
> arriving via git pull / AI-butler bypass the route. The route stamps an id on create (see below — this is
> promoted from "optional optimization" to the **primary** path so a note is almost never pushed id-less),
> but the reconciler remains the authority for files that bypass the route.

**The git-sync multi-machine hazard (BLOCKING — addresses Round 2).** Walnut's `git-sync` auto-commits the
vault (`git add -A`) on a ~30 s loop and pushes. *Lazy* id assignment in a *git-synced* vault is exactly
where **two independent id generators race**: a note authored on machine A can be committed + pushed by
git-sync **before** A's reconciler stamps an id (the back-write is explicitly deferred while the file is
actively edited, §8.3, so an un-id'd file can win the git-sync race). Machine B pulls the un-id'd note, its
own reconciler assigns a **different** `n_id`, commits, pushes → the same logical note now has **two ids in
two histories**: a git merge conflict on the `id:` line (or two divergent copies). Because edges key on the
**target's** frontmatter id (§2.2), a target note that ends up with two divergent ids splits its inbound
backlinks across both ids — silently breaking the link-integrity the id scheme exists to guarantee. The `n_`
+ base36(time) + random-suffix id is **not deterministic**, so two machines never independently agree.

**Fix (frozen — three layers, defense in depth):**
1. **Stamp at create-time on the authoring machine (primary path).** `POST /content` (create) and the first
   `PUT` of a note **stamp the id synchronously before the file is first written**, so the note is written
   to disk *with* its id and is almost never pushed id-less. This removes the race for the overwhelmingly
   common "I just made this note here" case.
2. **Pause git-sync's `git add -A` for a note until its id back-write settles.** The reconciler's back-write
   path sets a short-lived "id-pending" marker; `git-sync` skips committing a note that is id-pending (the
   existing `compactionInProgress` pause flag in `git-sync.ts` is the precedent for pausing auto-commit).
   This closes the residual window where a reconciler-assigned id (for files that arrived without one) hasn't
   been committed yet.
3. **Define the merge rule for the unavoidable residual collision.** If two ids ever do reach a merge for the
   same logical note (e.g. both machines were offline), the deterministic tie-break is **the earliest-created
   id wins** (compare frontmatter `created`, then lex/`n_` timestamp); the reconciler on next pass
   **re-points** inbound links from the losing id to the winning id (an index op — links key on id, so this
   is a bounded `UPDATE links SET dst_id=winner WHERE dst_id=loser`) and rewrites the losing note's `id:`
   line to the winner. This is logged and reversible (files stay the source of truth).

> **Alternative considered (deterministic id from content) — rejected for v1.** Deriving the id from stable
> content (e.g. hash of `created` + original basename) would make two machines independently mint the **same**
> id and eliminate divergence at the root. Rejected because (a) `created` is itself not reliably stable across
> machines/filesystems, (b) a content-derived id changes the project's established `n_`/`qm-`/`sess-` id
> convention, and (c) layers 1–2 close the race for the realistic cases while layer 3 handles the rest. Logged
> as a possible future hardening in §17 if the residual collision rate is ever non-negligible.

**Test (new — addresses Round 2):** the rename-integrity / identity suite (§16) adds a **"two machines, same
un-id'd note, git pull → merge"** case (today §16 only tests single-machine rename): assert the merge
resolves to one id, inbound links re-point, and no orphaned links result. The doc no longer ships "lazy id on
first reconcile" as if it were single-process.

---

## 9. Unified Notes Search API + Cmd+K front door — BOTH modes, together

### 9.1 Endpoint

```
GET /api/notes-v2/search?q=<query>&limit=30&mode=hybrid|string|semantic
→ {
    results: [ {
      id, path, title, snippet,
      matchType: 'exact' | 'semantic' | 'both',     // ●  /  ○  /  ◐   (UI trust legend)
      score,                                         // unified rank score
      stringScore?, semanticScore?,                  // transparency/debug (uncapped)
      matchedTags?: string[]
    } ],
    degraded?: 'semantic-unavailable'                // QMD down → string still returns
  }
```

`mode` defaults to `hybrid`; `string`/`semantic` exist for power-user toggles but the default surfaces
both. Mirrors `core/search.ts`'s fan-out + merge.

### 9.2 Blend + the frozen ranking rule (pseudocode)

```
async function notesSearch(q, limit):
  [stringHits, semanticHits] = await allSettled([            # one failing never zeroes the other
     stringLeg(q, limit*2),                                  # notes-index.sqlite: FTS5 + LIKE fallback
     memoryNotesSearch(q, ['note_vault'], limit*2),          # QMD (existing, §5)
  ])
  byId = map()
  for h in stringHits:   upsert(byId, h.id, {matchType:'exact', stringScore:h.bm25})
  for h in semanticHits:
     id = idFromQmdPath(h.filepath)                          # see normalization note below
     if byId.has(id): byId[id].matchType='both'; byId[id].semanticScore=h.score
     else:            upsert(byId, id, {matchType:'semantic', semanticScore:h.score})

  # FROZEN ranking (PRD §5 + UX §8): exact NEVER ranked below purely-semantic.
  #   tier 1: matchType ∈ {exact, both} → ordered by max(stringScore, semanticScore)
  #   tier 2: matchType == semantic     → ordered by semanticScore
  rank = r => (r.matchType=='semantic' ? 0 : 1)*BIG + normalize(scores)
  return sort(byId.values, by rank desc).slice(0, limit)
```

- **`idFromQmdPath` path normalization (BLOCKING fix — addresses Round 1).** Verified in
  `memory-search.ts:132,142`: for a file-backed store QMD returns `filepath` = the **absolute** path
  (`resolveVirtualPath(...)`), while `notes-index.sqlite` stores `path` **vault-relative, forward-slash**
  (`Projects/Apollo.md`). Looking up `SELECT id FROM notes WHERE path = <absolute>` **misses every time** →
  every semantic hit falls into the `else` branch keyed by the raw absolute path, so a note matching **both**
  legs appears **twice** (once `exact`-by-id, once `semantic`-by-abs-path) instead of merging to `◐ both`,
  and the frozen "exact never below semantic" labeling silently breaks. **`idFromQmdPath` is the single
  owner of the conversion:** `relPath = path.relative(NOTES_DIR, h.filepath)` normalized to forward slashes
  (and **case-insensitive** match on case-insensitive filesystems), *then* `SELECT id FROM notes WHERE
  path=?`; only if that still misses does it fall back to keying by `relPath`. **Test (new, §16):** a
  fixture where the **same** note is *both* an exact substring hit and a semantic hit → assert **exactly
  one** result row with `matchType:'both'`.
- **De-dupe by `id`** → one row per note; both-leg matches become `matchType:'both'`.
- **Labeling** drives the UX trust legend `● exact · ◐ both · ○ semantic` with the matched span
  highlighted — the anti-"it didn't find my note" mechanism. **Plain-language presentation (addresses Round
  1):** the three glyphs are not self-explanatory to a newcomer, so each result also shows a **short word
  badge** ("exact match" / "related") — or a tooltip — at least until the user has seen it once; the
  matched-span highlight carries most of the trust value for exact hits, with the glyph as secondary. The
  legend is explained inline on first use.
- **Graceful degradation:** QMD throws → string still returns + `degraded:'semantic-unavailable'`
  (mirrors `core/search.ts`).
- **Two-leg eventual-consistency window (stated explicitly — addresses Round 2).** The two legs are fed by
  **two independently-debounced consumers** (§8.1: structural ~300 ms in-proc / ~1 s fs; semantic re-embed is
  async + slower, `bge-m3` backgrounded per §12). So **right after an edit** the FTS row updates in
  ~300 ms–1 s but the embedding may still reflect the **old** content for a while. The de-dupe-by-id assumes
  both legs see the same note version; during the embed lag a freshly-edited note can momentarily appear as
  `● exact` only (when it "should" be `◐ both`) or carry a stale semantic snippet/score. **This is
  acceptable: the string leg is the AUTHORITATIVE "exact" leg and is always fresh** — the labeling reflects
  whichever leg has reconverged, and exact-wins-ties means the note still surfaces correctly. **Test
  constraint (§16):** the hybrid test must **not** assert `◐ both` on a note edited **within the embed-lag
  window** (it would be flaky); assert `both` only after the embed has caught up, or on a note whose content
  predates the test edit. *(Optional hardening, §17: drive the structural FTS update synchronously in the
  same PUT response so the exact leg is never even momentarily behind, leaving the semantic lag as the only
  async leg.)*

### 9.3 Cmd+K (global front door — **P1, early-pull candidate** — scope reconciled in Round 1)

**Scope honesty (addresses Round 1).** The PRD ranks "Quick switcher / quick capture" as **P1**
(`01-product-design.md:144`); the UX decision *proposed* pulling Cmd+K to P0 ("reachability is itself an
editing-experience property"). A Bar Raiser flagged this as scope-rationalization that inverts the user's
explicit ordering and grows the v1 "no-bug" surface (a new app-level key surface, discard-guards, mode
routing, focus-restore). **This doc holds the PRD's line: Cmd+K is labeled P1 (candidate for early pull-in,
pending explicit user confirmation), NOT baked-in P0.** The day-one wins the user actually asked for (E0
slash-block menu, B0 expose-existing semantic search) require none of it. If the user confirms the pull-in,
the design below is ready; until then it sequences after the P0 editor.

When built, the **search overlay and Cmd+K are the same component** in two default modes — one thing to
build, test, and keep bug-free. Scope: an **app-level key handler** (not an editor extension) so it opens
centered over *any* page. First modes: **Jump to note** (fuzzy subsequence title match over `/list`,
recents on empty) and **Create / Quick-capture** (`↵` creates the typed title; `⌘↵` opens a focused empty
note with **0 required decisions** — sensible default folder). Layered later: first-character mode routing
(plain = jump+hybrid search; `#` = tag filter; `>` = block/page actions mirroring slash verbs; `+` =
capture). **Keyboard contract:** `↑/↓` move, `↵` open/run, `⌘↵` create, `Esc` close; **closing mid-capture
with text offers "discard?" — never silently drop a note**; focus returns to the editor caret exactly where
it was.

---

## 10. Tags & frontmatter — storage, parsing, query

- **Tag sources (union):** `frontmatter.tags[]` **∪** inline `#hashtags` in the body, both feeding the
  `tags` table. Normalize: lowercase, strip leading `#`, spaces→`-`.
- **Frontmatter parsing:** `parseFrontmatter` (§2.1) — tolerant, never throws; `body` (frontmatter-stripped)
  is what gets FTS-indexed + embedded so search never matches raw `id:`/`created:` lines; raw block preserved
  verbatim for the byte-clean gate.
- **Tag API:**
  ```
  GET  /api/notes-v2/tags             → [{ tag, count }]              (autocomplete; feeds §3.4)
  GET  /api/notes-v2/tags/:tag/notes  → [{ id, title, path, snippet, modified }]  (newest first)
  POST /api/notes-v2/tags/rename      { from, to }
       → rewrites frontmatter tags + inline #from→#to ONLY in notes carrying it (targeted by the tag
         index — NOT a vault scan), then reconciles those notes.
  ```
  Tag rename is **targeted** (`SELECT note_id FROM tags WHERE tag=?`) — O(notes-with-tag), not O(vault);
  same root-cause discipline as backlinks (Scenario E).

**Decision (resolves editor open-decision #2): `#tag` autocomplete data source.** Ship the TagNode +
manual `#tag` typing in the editor's Step 3; wire **frequency-ranked autocomplete from `GET /tags` once
the structural sidecar lands** (backend Step 3). Until then, the node works with manual typing — the
feature is not blocked on the index.

---

## 11. Full API surface (additions / changes to `notes-v2.ts`)

| Method & path | Change | Backed by |
|---|---|---|
| `GET /search?q&mode&limit` | **Rewritten** — hybrid string+semantic, labeled, deduped by id | notes-index FTS + QMD |
| `GET /backlinks/*path` | **Rewritten** — index lookup, returns `id` + resolved status | `links` table |
| `GET /list` | Served from index; now returns `id` per note (feeds editor §3.5) | `notes` table |
| `GET /tags` · `GET /tags/:tag/notes` · `POST /tags/rename` | **New** (rename is targeted, not a scan) | `tags` (+ `notes`) |
| `GET /links/*path` | **New** (optional) — forward links of a note | `links` table |
| `GET /index/status` | **New** — `{ docCount, lastRebuild, schemaVersion, embedState, embedProgress?, dbSizeBytes, rebuilding?, degraded? }` (health/observability + test hook; `dbSizeBytes` makes sidecar growth monitorable, `embedProgress` surfaces the backgrounded re-embed §12) | `index_meta` + QMD `getStatus()` |
| `POST /index/rebuild` | **New** — drop + rebuild structural sidecar (Settings/admin) | reconciler |
| `POST /move` | **Simplified** — file rename only; `updateWikiLinksInAll` **removed** | reconciler updates 1 row |
| `PUT/DELETE/POST /content,/folder` | Unchanged externally; now also fire reconcile via `NOTES_UPDATED` | reconciler |

---

## 12. Data migration & cold rebuild (automatic, reversible)

1. On server start, `initNotesIndex()` runs **after** `initQmdStores()`. If `notes-index.sqlite` is absent
   or `schema_version` < current → **full rebuild** — but **off-loop and bounded** (see point 2; this is a
   blocking correction from Round 1, because a `schema_version` bump or `POST /index/rebuild` on a large
   vault must not wedge the production boot).
2. **Both rebuilds are off-loop, bounded, and budgeted (corrected Round 1).** Neither the structural walk
   nor the semantic re-embed may block the event loop or run a multi-second synchronous storm at boot:
   - **Structural walk** = `getAllMdFiles` + `reconcileNote()` each file, but **chunked**: yield to the
     event loop every N files (and/or read with `fs.promises` under a small concurrency cap), so it never
     blocks. **Budget: full structural rebuild < ~2 s off-loop @5k notes**, asserted in §16. This is the
     *only* O(n) structural pass — startup / explicit rebuild only, never per query.
   - **One-time semantic widen re-embed** (the first time the vault collection is widened — embeds the
     ~1,400 files outside the old PARA folders through `bge-m3`, a heavy CPU/ML job) is **backgrounded and
     rate-limited, NOT run inline at startup.** It degrades gracefully: string search works immediately,
     semantic builds in the background, and `GET /index/status` reports `embedState`/progress so the UI
     shows "indexing…". **A benchmarked re-embed throughput is recorded** so the first-widen cost is a
     known, monitorable number — not "a one-time re-embed."
   - These two never compete synchronously at boot: the structural pass is chunked off-loop and the embed
     storm is backgrounded + rate-limited.
3. **id assignment — create-time primary, reconciler fallback (NOT naive-lazy; corrected Round 2).** New
   notes are stamped with an id **at create-time on the authoring machine** (`POST /content` / first `PUT`)
   so they are written to disk with their id and almost never pushed id-less (§8.3). Files that arrive
   **without** an id (legacy notes, files synced in from a machine on an older build) get one from the
   **reconciler** on first reconcile. We **do not** eagerly back-write the whole vault at boot — that would
   cause large git-sync churn and risk clobbering files. Until a legacy note is stamped, links resolve by
   name (§2.2), so nothing breaks. **Git-sync interaction (§8.3):** `git add -A` is paused for an id-pending
   note until its back-write settles, and a deterministic earliest-created-wins merge rule handles the
   residual two-machine collision — so lazy assignment is **not** treated as single-process. (Opt-in "stamp
   all ids now" admin action exists for users who want full id coverage immediately; it batches the
   back-write and lets git-sync commit once.)
4. **Cold-rebuild safety:** build into a temp DB (`notes-index.sqlite.rebuilding`), atomic-rename over the
   live one (POSIX `rename`); readers never see a half-built index. Hold `withFileLock` only for the final
   swap, not the whole walk. QMD's own `embed({force})` rebuild is independent. `GET /index/status` reports
   `rebuilding:true` so the UI shows a subtle "indexing…" state without blocking search (string falls back
   to a bounded live scan during the brief window; semantic keeps working off QMD). **"Just rebuild it" is
   therefore operationally safe** — it never wedges the server, which is the whole point of calling the
   sidecars rebuildable.
5. **Reversibility:** migration never deletes/rewrites note content (except the careful guarded id
   back-write). Deleting both sidecars returns the system to pure-files; the only persisted file artifact
   is the additive `id:` line.

---

## 13. Concurrency, performance, security

### 13.1 Concurrency & failure modes

| Scenario | Handling |
|---|---|
| Two processes reconcile the same note (server + ephemeral) | `withFileLock(notes-index.sqlite)` serializes; hash-skip makes the loser a no-op |
| Indexer back-write races a user save | Per-note `withFileLock(<note>.md)` + re-check hash + skip-if-changed (§8.3) — indexer **never** wins over an in-flight edit |
| Optimistic-lock 409 after id back-write | Back-write emits `NOTES_UPDATED` with new `contentHash`; client refreshes expected hash before next PUT |
| QMD down / model mismatch | `Promise.allSettled` → string still returns; `degraded:'semantic-unavailable'` |
| Malformed frontmatter | `parseFrontmatter` never throws; indexed body-only; debug log — one bad note can't break the vault index |
| External edit / git pull / AI-butler write | Caught by the `fs.watch` catch-all leg (§8.1) → reconcile; both sidecars converge |
| Index drift (sidecar ≠ files) | Sidecars rebuildable; `POST /index/rebuild` + startup schema check; tests assert `index == vault` |
| Ephemeral server isolation | Ephemeral uses its own `OPEN_WALNUT_HOME` temp dir → its own `notes-index.sqlite`; must **not** touch production's sidecar (existing ephemeral-isolation discipline) |
| Event-loop starvation from reconcile storms | Per-path coalescing queue + single transaction (§8.1); reconcile is per-changed-path; `interest`-filtered bus subscription avoids waking on unrelated events; semantic store driven per-file, never `store.update()` on save (§5.1) |
| Sidecar disk growth (observability) | `notes_fts` uses **external-content FTS5** (no 2× body copy, §4.1); `GET /index/status` reports **DB size** so growth is monitorable as a function of vault size (not hand-waved "small") |

### 13.2 Performance (PRD targets)

- **String ≤ 300 ms, backlinks ≤ 150 ms** — both served from indexes, never scans.
- **Large-note benchmark (defined concretely — addresses Round 1; the PRD left it TBD).** The fixture is a
  **~5,000-word note with a 20×10 table and ~200 blocks.** E2E asserts: **typing latency stays smooth**
  (no dropped input) and **save latency** within budget on this fixture (§16 "Latency" now covers the
  editor, not just search/backlinks).
- **Editor large-doc smoothness:** hover-rail + bubble are **pure DOM overlays** keyed off
  selection/hover — they do **not** re-render the doc, so typing latency is unaffected (this is **measured**
  on the large-note benchmark, per §3.2's drag-handle probe — not merely asserted). `getMarkdown()` runs on
  the debounced save, not per keystroke. Tables are bounded by the inline-only cell constraint.
- **External-sync apply cost on large docs (addresses Round 1).** §6.2 already bans full `setContent` +
  raw-offset restore for the external-sync path in favor of a **diff/step apply** — that also bounds the
  cost on a large note (a small external change applies a small set of steps, not a whole-doc re-parse). The
  large-note benchmark includes "external PUT lands while editing" to assert this stays smooth.
- **IME / CJK (critical — bilingual user) — guard at the TRIGGER/OPEN path, refilter after commit
  (refined Round 2).** Re-verified: the `e.isComposing || keyCode === 229` guard exists **only in the React
  keydown nav handler** of `SlashCommandMenu.tsx` (arrow/enter), **not** in trigger detection
  (`SlashCommandExtension`/`WikiLinkExtension` `view().update`), and ProseMirror's plugin `update` **can
  fire during composition** for many IMEs — so the prior "fires after composition commits" claim is unsafe.
  But a **blanket `if (view.composing) return;` at the top of `update`** is too blunt: it would freeze an
  **already-open** menu's filter during composition, and because `view.composing` can stay true **briefly
  after** `compositionend` for some IMEs, a hard early-return can also **swallow the first post-commit
  update** that should refilter (filter lands one keystroke late). **Fix (precise):**
  - Guard only the **trigger-detection / open path** on `view.composing` — do **not** newly open the menu or
    change the tracked `{from,to}` range while composing.
  - **Let an already-open menu persist** through composition (don't dismiss it), but **do not refilter** on
    composing updates.
  - **Refilter on the first non-composing update after commit** — re-evaluate on the next `update` where
    `!view.composing`, and also listen for `compositionend` — so the committed CJK text filters
    **immediately**, not one keystroke late.
  - Apply to the `/`, `[[`, **and** `#tag` trigger layers.
  **Test (§16):** exercise `/`, `[[`, AND `#` each followed by a multi-keystroke CJK composition; assert
  **(a)** the menu does **not** open mid-composition, and **(b)** it **does** filter on the committed text
  **immediately** after composition ends (not one keystroke late), with the composed text preserved.
- **Tree panel virtualization for large vaults (addresses Round 1).** `NotesTreePanel` rendering
  1.5k–20k notes is its own O(n) render/scroll hotspot. v1 **virtualizes** the tree (windowed rendering) so
  scroll/typing stay smooth at 20k notes; called out so it isn't discovered late.
- **Reconcile** is incremental + debounced + hash-skipped — never a full-vault pass on a query (§5.1/§8.2:
  the semantic store is driven per-changed-file, never `store.update()` on save).

### 13.3 Security

- **XSS in tables/callouts/tags:** the editor stores **Markdown**, not HTML; the cell/tag/callout disk
  forms are plain text or pipe syntax. The read-only viewer already runs `marked` → **DOMPurify**; the new
  tag/callout viewer post-passes (§7) must emit **sanitized** markup (no raw user HTML into the styled
  span/div). `Markdown({html:true})` permits `<img>` etc. in the editor — the **viewer remains the trust
  boundary** (DOMPurify), unchanged.
- **FTS query injection / special chars:** `escapeFts(q)` sanitizes FTS5 operators; the `LIKE` leg uses
  parameter binding (same care as `memory-search.ts` `sanitizeForVec`).
- **Path traversal:** `/content/*path`, `/move`, `/tags/:tag/notes`, and the reconciler must keep all
  resolved paths **inside `NOTES_DIR`** (reject `..`/absolute escapes, normalize to vault-relative
  fwd-slash). The structural index stores only vault-relative paths; QMD virtual paths resolve within the
  collection root. No endpoint may read/write outside the vault.
- **id back-write** only ever touches files inside `NOTES_DIR`, under per-note lock, byte-preserving.

---

## 14. Phased build plan — editor flawless at every boundary

The two halves ship **largely in parallel**; the only hard cross-dependency is the editor's id-form
authoring (E4/E5) depending on the backend's identity landing (B2). Each step leaves a working, shippable,
byte-clean state — stop anywhere, no half-built rewrite in the tree.

```
EDITOR track (web/src)                          BACKEND track (src)
──────────────────────────────────────         ──────────────────────────────────────
E0  Slash-menu content swap → real block        B0  Widen getNotesStore() to whole-vault
    menu (H1–H3/list/todo/quote/divider/             (§5.1) + GET /search also calls
    code). Reuses entire slash engine.               memoryNotesSearch and merges with the
    ZERO new deps, ZERO round-trip risk.             current substring scan (naive merge).
    Notion feel DAY ONE.                             Semantic notes search works DAY ONE.
        │                                            │  ── both are the PRD "simplest first step" ──
        ▼                                            ▼
E1  BubbleMenu + DragHandle (⠿ grip + ＋),       B1  notes-index.sqlite + reconciler +
    both off-the-shelf, pure UI. Wire the            fs.watch catch-all. Rewrite /search
    shared block-transforms module (one path).       string leg, /backlinks, /list to read
    Regression suite (§13.2 invariants) GREEN        the index. O(n) scans GONE.
    first.                                           │
        │                                            ▼
        ▼                                        B2  Identity: id frontmatter + id-keyed
E2  Tables (@tiptap/extension-table family).         links + name-fallback; simplify /move
    /Table, Tab nav, row/col ops. Enforce            (delete updateWikiLinksInAll). Rename
    inline-only cell constraint. Wire the            integrity solved.  ◀── unblocks E4/E5
    FROZEN Tab-precedence rule (table claims         │
    Tab only inside a table; list-Tab/ArrowUp        ▼
    untouched outside) + its regression test.    B3  Tags table + /tags* endpoints +
    Round-trips via the OWNED table serializer        frontmatter PARSE (tags source only;
    (§6.1) — verify vs round-trip corpus.            NO properties-editing UI — non-goal,
        │                                            §3.6/§18). (unblocks E3 autocomplete)
        │                                            │
        ▼                                            ▼
E3  #tag node + freq autocomplete (clone [[)     B4  Polish: /index/status, /index/rebuild,
    + Callout node + frozen serializer. The          temp-DB atomic rebuild, ranking/labeling
    ONLY new serialization — gated behind the        tuning on a labeled eval set.
    0-diff corpus (§6) AND viewer-parity (§7).
        │
        ▼
E4  Wiki-link authoring: Obsidian-native           ── depends on B2 ──
    [[Title]] / [[folder/Title]] disambiguation;
    resolution keys on target's frontmatter id (§3.5/§2.2).
        │
        ▼
E5  Frontmatter strip/reattach wrapper (§3.6)    ── depends on B2 ──
    so the editor never corrupts identity.
```

**Sequencing rule:** the editor track never blocks on the backend except E4/E5 (identity authoring). E0–E3
deliver a full Notion-style block editor with byte-clean round-trips regardless of backend progress; B0–B1
deliver hybrid search + the end of O(n) scans regardless of editor progress.

**P1 / early-pull lane (NOT in the day-one P0 wave — reconciled in Round 2, see §9.3):**

```
P1a  Hybrid search OVERLAY UI (the visible /notes search box over the B0 backend; ●◐○ labels,
     exact-wins-ties, matched-span highlight, word badges). Sequences with/after B0–B1.
        │
        ▼
P1b  Cmd+K global front door — the SAME overlay component, opened app-level (Jump + Quick-capture,
     then `#`/`>` modes + discard-guard + focus-restore, §9.3). EARLY-PULL CANDIDATE: build only
     after explicit user sign-off (it is the PRD's P1 "quick switcher / quick capture", not P0).
        │
        ▼
P1c  Tag browse view + clickable chips + tag rename/merge (index ops, §10) — the P1 half of the
     tag feature; v1 P0 ships only chip + frequency autocomplete (E3 / §3.4).
```

> **Why Cmd+K is not in the P0 wave (§9.3).** It is a whole app-level key surface (mode routing,
> discard-guards, focus-restore) that materially enlarges the v1 test matrix. The day-one wins the user
> actually asked for (E0 block menu, B0 expose-existing semantic search) require none of it. Pulling it
> forward is a one-line decision for the human owner (see §19 Unresolved decisions) — the spec is ready.

---

## 15. P0 feature → design map (every PRD P0 accounted for)

| PRD P0 feature | Where designed |
|---|---|
| 1. Notion-style slash *insert-block* menu | §3.3 (evolve `SlashCommandExtension`, fuzzy filter, byte-clean insert) — **day-one win E0** |
| 2. Tables (create/edit/Tab/rows/cols/header, MD round-trip) | §3.2 + §6 (BUY `@tiptap/extension-table`; inline-only cell constraint; Tab-precedence rule §3.2/§14-E2) |
| 3. All basic text styles | §3.2 (reuse StarterKit + `TightTaskList` + `TaskAwareLink`; slash + bubble + Markdown shortcuts) |
| 4. Tags / labels (autocomplete, clickable, browsable, renamable) | §3.4 (TagNode) + §10 (tag sources/API, targeted rename) + §4.1 (`tags` table) |
| 5. Block affordances (drag handle, reorder, `＋`) | §3.2 (BUY `@tiptap/extension-drag-handle-react`); feel contracts; clean-Markdown drop via `onUpdate` |
| 6. Callout + divider | §3.4 (Callout custom node, frozen `> [!kind]`) + §3.2 (HorizontalRule) + §7 (viewer parity) |
| 7. Hybrid notes search (BOTH modes) | §9 (parallel legs, dedupe by id, `●◐○` labels, exact-wins-ties) + §4 (string leg) + §5 (semantic leg) |
| 8. Editing-quality bar (no data loss / no flicker / byte-clean / cursor preserved / smooth) | §6 (round-trip gate), §3.6 (frontmatter wrapper), §8.3 (id back-write guard), §13.2 (overlays, IME), §13.3 (security) |

**Tag scope split (reconciled with PRD §6, Round 2).** PRD P0 feature #4 is **chip + frequency
autocomplete** (§3.4) — designed above. **Clickable-to-browse, tag-browse view, tag index, and tag
rename/merge are P1** (§10, §4.1 `tags` table, build-plan P1c) — they ride the structural sidecar (B2/B3).
All three docs now state this split identically.

**P1 items (NOT in the P0 map above — listed so they are not mistaken for P0):**

| PRD/UX P1 feature | Where designed | Build step |
|---|---|---|
| Stable identity + incremental link/backlink + tag + FTS **structural sidecar** | §2 / §4 / §8 | B1–B2 (root-cause fix for rename + O(n) backlinks; pulled forward right after the editor feels right) |
| Tag browse view + clickable chips + tag rename/merge | §10 / §4.1 | B3 + P1c |
| **Cmd+K global front door** — Jump + Quick-capture (+ `#`/`>` modes) | §9.3 | P1b — **early-pull candidate pending explicit user sign-off** (§19) |
| Relations / context dock | **Out of v1** — §18 (deferred / post-v1) | — |

---

## 16. Test plan (root-cause correctness, not feel)

- **Round-trip corpus (editor):** `parse(md)→serialize→md'` byte-identical for every block + nasty combos
  (§6); runs in CI before any new block lands.
- **Hard-won invariants regression suite (editor):** `isSourceRef` loop guard, `tryJoinPreviousListAndSink`,
  `detachListItemChildren`, ArrowUp nesting, `TightTaskList` tightness — green **before** each new
  extension wires (§13.2).
- **Tab-precedence:** list-Tab and table-Tab in the **same** document (§3.2).
- **Slash trigger by command class (§3.3):** `/table` mid-paragraph must NOT split the block / must not be
  offered; **`/[task-ref]` mid-sentence MUST still work** (inline subset offered) — regression test against
  silently dropping the shipped inline-reference capability.
- **IME/CJK (refined Round 2, §13.2):** `/`, `[[`, AND `#` each followed by a multi-keystroke CJK
  composition — assert (a) the menu does **not** open mid-composition, and (b) it **does** filter on the
  committed text **immediately** after `compositionend` (not one keystroke late); composed text preserved.
- **One user action = one `Cmd+Z` (§6.3):** slash insert, turn-into, drag-reorder, table add/del row+col, tag
  insert/delete, and the existing **list Tab** (regresses to 2 steps today, must be 1).
- **External / AI-write mid-edit (§6.2):** (a) non-conflicting external `PUT` while typing → zero lost
  chars + stable caret (deferred); (b) dirty editor + WS `notes:updated` → shows reload affordance, does NOT
  self-replace (regression for the missing WS-path guard); (c) true 409 conflict → surfaced, ≤ one debounce
  window lost (the honest bound, not "zero").
- **Index == vault invariant:** seed fixture vault → build → assert every `notes`/`links`/`tags` row
  matches a direct scan; delete sidecar → rebuild → identical.
- **FTS edit-coherence (external-content FTS5, §4.1):** index a note, then **edit it to remove a word**, then
  re-search the **old** text → assert it **no longer matches** (catches a stale FTS entry from a forgotten
  delete-old-values on UPDATE); and re-search the **new** text → matches.
- **Rename integrity:** A links B; rename + move B → backlink still resolves (edge keyed on B's frontmatter
  id), 0 vault rewrites, 0 orphans; repeat with two same-named notes → `ambiguous` edge, no mis-resolution.
- **Multi-machine identity (new, §8.3):** two machines reconcile the **same un-id'd note**, then git pull /
  merge → assert the merge resolves to **one** id (earliest-created wins), inbound links re-point to the
  winner, and **0 orphaned links** result. (The earlier plan only tested single-machine rename.)
- **Obsidian portability (new, §2.2):** author a link in Walnut → assert the on-disk form is byte-identical
  to what Obsidian writes (`[[Title]]` / `[[folder/Title]]` / a real `[[Title|alias]]`), with **no `n_id` in
  the link text**; a path-form link resolves collision-free.
- **Hybrid search:** labeled "vague phrase → expected note" set (verbatim-absent) → expected note top-3
  (semantic); exact substring present → returns its note(s) 100% and never below a purely-semantic hit.
- **Concurrency:** parallel reconcile + user save on the same note → no lost edit, no clobbered id, no 409
  storm.
- **Degradation:** kill QMD → string search still returns with `degraded`.
- **Newcomer / calm-default acceptance (addresses customer walkthrough):** (a) an **empty note shows no
  chrome** until hover or `/` (grip/inserter/bubble are progressive-disclosure only); (b) `/` opens with a
  **small grouped default set**, not all ~12 block types dumped flat (the fuzzy filter + groups carry
  discovery); (c) the **search trust legend is explained in plain language** — the `●◐○` glyphs always carry
  a **word badge** ("exact match" / "related"), not training-wheels-only, since a low-frequency butler user
  may go weeks between searches and re-encounter them cold; (d) the **`/notes` empty state** surfaces the
  "New note" capture CTA (§3.6½).
- **First-run "still indexing" honesty (customer Sam high-severity):** during the **one-time background
  re-embed** of notes outside the old PARA folders (§12), semantic recall is **partial**. The UI must show a
  non-blocking **"still indexing — semantic results may be incomplete"** state driven by
  `GET /index/status.embedProgress`, so a newcomer searching in that window does not conclude "search doesn't
  find my stuff" (the PRD's named top risk). Test: with embed in progress, a semantic-only match may be
  absent **and** the indexing state is shown; string/exact matches always work immediately.
- **Latency:** representative vault → string ≤ 300 ms, backlinks ≤ 150 ms.
- All E2E hooks run through `startServer({ port: 0, dev: true })`, mocking only the Claude CLI / embeddings
  where needed (per `tests/AGENTS.md`). **No `page.goto()` — real UI clicks (SPA nav).**

---

## 17. Open decisions resolved here + implementation-time judgment + tech-debt

**Resolved in this doc** (the editor deep dive's four open questions): (1) **bump all `@tiptap/*` to one
matching minor** in a single install (§3.2); (2) **`#tag` autocomplete** ships with manual typing in E3,
frequency autocomplete wired when `GET /tags` lands in B3 (§10); (3) **v1 callout kinds =
`note·tip·warning·danger·info`** (§3.4); (4) **extend the existing `marked` pipeline** with tag/callout
post-passes rather than unify renderers (§7).

**Remaining for implementation-time judgment** (not blockers): exact debounce constants (300 ms in-proc /
1 s fs / 5 s QMD are starting points to tune under load); FTS `LIKE`-fallback threshold (when to skip
straight to `LIKE`); whether to expose folder-prefix rank weighting after collapsing PARA collections
(§5.1); and the precise `parseFrontmatter` splice algorithm for the id back-write (§8.3) — all to be
finalized against the round-trip corpus and latency benchmarks during build.

**Logged tech-debt + future hardenings** (out of v1, recorded so they aren't rediscovered): unify the two
renderers (`markdown-it` editor vs `marked` viewer) onto one engine — the parser-parity cost compounds with
every block (§7); an FTS5 **`trigram`** tokenizer if mid-token substring ever gets slow on a very large vault
(§4.1); **drive the structural FTS update synchronously in the PUT response** so the "exact" leg is never
even momentarily behind the semantic leg (§9.2 eventual-consistency window); and a **content-derived
deterministic note id** if the residual two-machine id-collision rate (§8.3) ever proves non-negligible.

**The highest implementation-risk item (flag for an early spike — Round 2 noted):** §6.2's ProseMirror
step/diff **position-mapping** (computing a diff between the old and new docs and mapping the selection
through it) is non-trivial and has **no off-the-shelf TipTap primitive**. The design is sound, but
**"defer-while-dirty" (§6.2 part 1) carries most of the safety**, while the step-mapping (part 2) is the part
most likely to need iteration — spike it early in the E-track rather than discovering its sharp edges late.

---

## 18. Explicit non-goals (this effort)

Canvas / whiteboard, graph view, real-time multiplayer/collaboration, proprietary storage-as-master,
columns/multi-column blocks, a frontmatter *editing* node, synced/toggle blocks, public sharing, and
replacing QMD or its embedding model — all out of scope (PRD §6, UX §12). The **relations / context dock**
(backlinks + linked tasks + memory neighbors beside the editor) is **deferred / post-v1 (P1+)** — a roadmap
item, **not** a permanent non-goal like canvas/graph, but out of this effort's v1 (reconciled with
`ux-decision.md`, Round 2). **Markdown on disk stays the source of truth; every index is a rebuildable
sidecar.**

**Acknowledged-but-deferred Obsidian-parity recall features (customer walkthrough — listed so they are not
mistaken for oversights):** **unlinked mentions** (surfacing notes that mention a title without a `[[link]]`),
**hover-preview/peek** of a linked/backlinked note, and **nested / path-aware tags** (`#project/q3`). These
are real Obsidian table-stakes for persona P1 and are genuine **post-v1** items (nested tags are PRD P1; the
other two queue behind the identity/index backbone). v1 ships resolved backlinks (from the index) + flat
tags; these three are the explicit next increments toward Obsidian-class recall, not part of v1.

---

## 19. Unresolved decisions — for the human owner to confirm

These are **not** implementation details; they are product/scope calls the design surfaces rather than
silently makes. Each has a recommended default the doc already builds against, but the owner should confirm.

1. **Cmd+K — pull into P0, or keep P1?** The PRD lists quick-switcher/quick-capture as **P1**; this doc holds
   that line (§9.3) and ships a minimal in-page "New note" capture front door at P0 (§3.6½) so the newcomer
   metric is met without it. The spec for full app-level Cmd+K (Jump/Capture + modes + discard-guard) is
   ready (§9.3 / build-plan P1b). **Decision needed:** confirm P1 (recommended), or explicitly pull Cmd+K
   into the P0 wave (accepting the larger v1 key-surface test matrix). *All three customer personas wanted it
   day-one; the PRD ordered it P1 — only the owner can break that tie.*
2. **On-disk wiki-link form — Obsidian-native (recommended) vs text-level collision-proof?** §2.2 (revised
   after a customer walkthrough) defaults to **Obsidian-native links** (`[[Title]]` / `[[folder/Title]]`,
   fully portable; id in frontmatter; resolution keyed on the target's id). This honors the PRD's portability
   promise to persona P1 but makes a bare `[[Title]]` to two same-named notes an `ambiguous` edge (handled by
   §4.3, exactly as Obsidian does). The `[[Title|n_id]]` form is **rejected** (it hijacks Obsidian's alias
   slot). **Decision needed:** confirm Obsidian-native (recommended), or — if text-level collision-proofness
   is valued above portability — choose a **non-rendering** id carrier (HTML comment / frontmatter link table),
   never the `|` slot.
3. **Conflict policy on a true write-write conflict (§6.2 part 3).** The shipped optimistic-lock policy is
   **agent-writes-win**, losing at most one debounce window of un-flushed typing. This doc **keeps** that
   (with the loss now surfaced, not silent) because it may be load-bearing for butler correctness.
   **Decision needed:** confirm agent-wins-on-true-conflict (recommended; non-conflicting writes already never
   lose input), or flip to user-wins-while-dirty (which reverses the long-standing policy — call out why).

---

## Revision log — Round 2 (Bar Raiser) + customer walkthrough

This pass closed the residual gaps Round 2 verification and three customer personas (Obsidian power-user,
Notion power-user, newcomer "Sam") surfaced. Each item below is a **material** change; cosmetic edits omitted.

**Blocking fixes applied:**

1. **On-disk link form changed from `[[Title|n_id]]` → Obsidian-native (§2.2, §3.5, §4.3, §6, §7).** The
   Obsidian power-user walkthrough caught that `|n_id` **hijacks Obsidian's alias slot** — opened in real
   Obsidian, every Walnut link would render the opaque id as its label and resolve by title, breaking the
   PRD's portability promise to persona P1. Now links are stored exactly as Obsidian writes them
   (`[[Title]]` / `[[folder/Title]]` / real `[[Title|alias]]`); the id lives in frontmatter only;
   rename-proofness comes from the **target's** frontmatter id, resolved by the indexer. Logged as
   Unresolved Decision #2.
2. **§6.2 external/AI-write contract reconciled against the REAL state owner `useNoteContent.ts`.** Round 2
   found the prior "zero lost characters" claim contradicts the shipped 409 path (which deliberately drops
   ~one debounce window, agent-wins) and that the WS/AI reload path lacks the dirty-guard the visibility path
   already has. Replaced the impossible absolute with an **honest, surfaced bound**: non-conflicting writes
   defer-while-dirty and never lose input; a true write-write conflict loses ≤ one debounce window and is
   surfaced (not silent). WS-path dirty-guard mandated. Conflict policy logged as Unresolved Decision #3.
3. **Migration id divergence across git-synced machines (§8.3, §12).** Round 2 found *lazy* id assignment in
   a *git-synced* vault lets two machines mint different ids for the same note → merge conflicts + split
   backlinks. Fixed with defense-in-depth: **create-time stamping (primary)**, **pause `git add -A` while an
   id is pending**, and a **deterministic earliest-created-wins merge rule** that re-points links. New
   multi-machine test in §16.
4. **Cmd+K P0/P1 self-contradiction eliminated (§9.3 already P1; fixed §14 build row + §15 P0 map).** The
   "authority" doc said P1 in prose but P0 in its build sequence/scope ledger. Now P1 everywhere, in an
   explicit P1/early-pull lane; logged as Unresolved Decision #1. **ux-decision.md and 01-product-design.md
   reconciled to match** (Cmd+K P1, tag-scope split, relations dock deferred, table header/break) so all
   three docs agree.

**Non-blocking fixes applied:**

5. **§8.2 QMD API signature corrected** to the real two-call shape (`insertContent(hash, content, createdAt)`
   + separate `insertDocument`/`updateDocument`, hash-skip via `findActiveDocument`), verified against
   `qmd-task-sync.ts:62-86` and `@tobilu/qmd` `store.js`.
6. **§6.1 inline-code pipe claim corrected** (empirically re-ran `markdown-it@14.1.1`): a raw `|` inside an
   inline-code span **truncates the cell** — the serializer must emit `\|` even inside code marks; corpus
   asserts the code span survives intact. Added a user-authored-`\|` idempotency fixture.
7. **FTS5 external-content maintenance pinned (§4.1, §8.2)** — the three standard AFTER INSERT/UPDATE/DELETE
   triggers (delete-OLD-values then insert-new); whole-table `'rebuild'` reserved for cold rebuild only. New
   FTS edit-coherence test (§16).
8. **§9.2 two-leg eventual-consistency window stated** (string leg authoritative + always fresh; semantic
   may lag during embed); §16 hybrid test must not assert `◐ both` within the embed-lag window.
9. **Slash trigger split by command class (§3.3)** — block-level inserts require an empty block; **inline
   Reference entries (Task ref / Link to note) still fire mid-sentence** (the prior blanket gate silently
   removed a shipped capability; flagged by Round 2 AND all three personas as "reads as broken"). New test.
10. **IME composing guard refined (§13.2)** — guard the open/trigger path on `view.composing`, persist an
    open menu, refilter on first post-`compositionend` update (a blanket top-of-`update` return froze the
    filter / swallowed the first committed keystroke).
11. **Newcomer on-ramp added (§3.6½) + calm-default acceptance + "still indexing" honesty (§16).** The Sam
    walkthrough found no P0 capture front door for a butler user not on `/notes` (Cmd+K is P1). Added a
    minimal P0 **"New note"** affordance + empty-state, the calm-default acceptance check, and a first-run
    "semantic results may be incomplete" state.
12. **"frontmatter properties" leak removed from build step B3** (→ frontmatter PARSE only; properties-editing
    UI is a non-goal). **"Color" block-action cut** from ux-decision.md (no byte-clean Markdown form).
13. **Acknowledged-but-deferred Obsidian recall features listed (§18):** unlinked mentions, hover-preview,
    nested/path tags — real post-v1 items, now explicit rather than absent.
14. **§19 Unresolved decisions added** for the human owner (Cmd+K P-level, link form, conflict policy);
    highest implementation-risk item (§6.2 step-mapping) flagged for an early spike in §17.

**Positively verified by Round 2 (no change needed):** the owned table serializer targets a real shipped
defect (header-less → HTML, no alignment, no pipe-escape); the §6.2 ban targets the real `setContent`+offset
code; one Tab = multiple transactions today (§6.3 real); the absolute-vs-relative semantic path bug (§9.2);
the synchronous `readFileSync`-per-file in `reindexCollection` (§5.1, real vault = 1,566 `.md`); the §0
inventory (bubble-menu present at 3.20.1; table + drag-handle absent); the missing IME guard; the slash papercut;
and the migration tolerance of `[[name|id]]`. Internal-leak scan of all docs clean.

**Doc-set consistency:** the three contradictions Round 2 flagged between the "reconciling authority"
(02-technical-design.md) and its inputs (01-product-design.md, ux-decision.md) — Cmd+K P-level, relations
dock in/out, table header-toggle/break — are now resolved **in all three docs identically**, with a
supersession banner at the top of ux-decision.md. Reading order + authority stated in
`00-executive-summary.md` (no file renumber, to preserve the existing by-name cross-references).
