# Notes / PKM Redesign — Backend: Storage, Indexing & Search Design

> **Status:** Design phase. No implementation in this document — architecture, data models, API contracts, and pseudocode only.
> **Doc series:** `01-product-design.md` (PRD) → **`02-search-and-index-design.md` (this doc)** → later docs for editor extensions.
> **Scope rule (inherited):** Markdown files on disk are the source of truth. Every index is a **rebuildable sidecar**, never the system of record. The editing experience is the #1 priority; nothing here may regress save/load fidelity.

---

## Executive Summary

- **Problem.** Notes search, backlinks, and rename are all **O(n) full-vault file scans** — every query re-reads every `.md` file, and rename rewrites `[[name]]` by whole-vault regex. There is no index. Separately, the semantic engine (`@tobilu/qmd`, BM25 + vector) *already indexes notes* via `getNotesStore()` + the recursive watcher, but (a) it is never surfaced in the notes search UI, and (b) it only watches four hard-coded PARA folders (`Areas/Projects/Resources/Archive`), so notes in any other folder are invisible to semantic search.
- **What we'll build.** One small **rebuildable sidecar index** (`notes-index.sqlite`, via `better-sqlite3` — the same pattern as `task-db.ts`/`memory-index.ts`) that holds note **identity, frontmatter, links, tags, and a substring/FTS index**. String search, backlinks, tags, and rename are all served from this sidecar in O(log n). Semantic search keeps using the existing QMD notes store — we just **widen its collection to the whole vault** and **expose it in the notes search API**, blended with string results exactly like `core/search.ts` already blends BM25 + vector for tasks/memory. The sidecar reconciles on file change using the **same debounce + watcher** that already drives QMD.
- **Simplest first step (ships value day one, no schema needed).** In `notes-v2.ts`'s `GET /search`, additionally call the existing `memoryNotesSearch(q, ['note_*'])` and merge its hits with the current substring scan. The semantic index already exists; this one wiring change makes "find by vague phrase" work in the notes UI immediately — before any sidecar lands. **Prerequisite fix in the same step:** change `getNotesStore()` to index the whole vault (one collection rooted at `NOTES_DIR`), so notes outside PARA folders are searchable.
- **Root-cause fix (not a patch).** The three O(n) scans share **one** root cause: *no derived index keyed on stable note identity.* We fix it once — a single sidecar with an incremental reconciler — rather than optimizing each scan separately. Stable note **id** (not basename) becomes the link key, so rename never rewrites the vault and never collides on duplicate names.
- **User-visible outcome.** Search returns in ≤ 300 ms from indexes (not scans), blending exact-substring and meaning-based hits in one labeled list where exact hits are never buried. Backlinks render in ≤ 150 ms and are 100% correct. Rename/move never orphans a link. Tags are browsable instantly. Delete the sidecar at any time and it rebuilds from the files.

---

## 0. Grounding — what the code actually does today (read first-hand)

| Concern | Today | File |
|---|---|---|
| String search | `GET /search?q=` reads **every** `.md` via `getAllMdFiles()` + `indexOf` per query | `src/web/routes/notes-v2.ts:315` |
| Backlinks | `GET /backlinks/*path` re-scans **every** file with `WIKI_LINK_RE`, matches by **basename** | `src/web/routes/notes-v2.ts:348` |
| Rename / move | `POST /move` renames file, then `updateWikiLinksInAll()` regex-rewrites `[[oldName]]`→`[[newName]]` across **every** file | `src/web/routes/notes-v2.ts:235,293` |
| Link identity | `[[target]]` resolves by **basename** → same-name collisions, fragile rename | `src/web/routes/notes-v2.ts:44` |
| Save signal | `PUT /content/*` emits `bus.emit(NOTES_UPDATED, { source: 'notes/<path>', contentHash })` | `src/web/routes/notes-v2.ts:186` |
| Semantic engine | QMD hybrid (BM25 + vector + RRF + rerank); `getNotesStore()` exists, `memoryNotesSearch()` already has `note_*` source weights | `src/core/memory-search.ts`, `src/core/qmd-store.ts:60` |
| Semantic coverage gap | `getNotesStore()` only indexes `Areas/Projects/Resources/Archive` — **arbitrary folders are NOT indexed** | `src/core/qmd-store.ts:66-71` |
| Watcher | `fs.watch(NOTES_DIR,{recursive})` → debounced (5 s) `store.update()`+`embed()` | `src/core/qmd-watcher.ts:69` |
| Concurrency | Cross-process `withFileLock`/`withFileLockSync` (mkdir-atomic, PID-liveness stale detection) | `src/utils/file-lock.ts` |
| Sidecar-DB precedent | `better-sqlite3` already used for tasks/sessions/usage/memory-index | `src/core/task-db.ts`, `src/core/memory-index.ts` |
| QMD programmatic insert | `internal.insertContent/insertDocument/findActiveDocument/deactivateDocument/resolveVirtualPath` + hash-skip | `src/core/qmd-task-sync.ts` |

**Two distinct subsystems, deliberately kept separate (do not merge them):**
1. **Semantic** = QMD (`notes-search.sqlite`). Owns embeddings + BM25 + RRF + rerank. *Already exists.* We widen coverage and expose it.
2. **Structural** = the new sidecar (`notes-index.sqlite`). Owns identity, links/backlinks, tags, frontmatter, and exact-substring/FTS. *New.* This is the root-cause fix for the O(n) scans.

They reconcile from the **same** watcher events but write **different** SQLite files, mirroring the existing "separate DB per store to avoid noisy-neighbor re-embedding" rationale documented in `qmd-store.ts`.

---

## 1. Architecture

```
                          Markdown vault (SOURCE OF TRUTH)
                          ~/.open-walnut/notes/**/*.md
                                     │
              ┌──────────────────────┼───────────────────────┐
        write │ (PUT /content)       │ fs.watch(recursive)    │ external edit / git pull / AI butler
              ▼                      ▼                        ▼
   ┌─────────────────────┐   ┌──────────────────────────────────────────┐
   │  notes-v2 routes     │   │   NotesIndexer (new) — debounced reconcile │
   │  (CRUD/move/folder)  │   │   • parse frontmatter (id, tags, title)    │
   │  emits NOTES_UPDATED ├──▶│   • extract links [[id]] / [[name]]        │
   └─────────────────────┘   │   • upsert into notes-index.sqlite         │
                              │   • mark QMD notes store dirty (existing)  │
                              └───────────────┬────────────────┬──────────┘
                                              │                │
                       ┌──────────────────────▼──┐   ┌─────────▼─────────────────┐
                       │  notes-index.sqlite      │   │  notes-search.sqlite (QMD)│
                       │  STRUCTURAL sidecar      │   │  SEMANTIC store (exists)  │
                       │  notes / links / tags /  │   │  whole-vault collection   │
                       │  notes_fts (substring)   │   │  BM25 + vector + rerank   │
                       └──────────┬───────────────┘   └────────────┬──────────────┘
                                  │ exact / FTS / backlinks / tags  │ meaning-based
                                  └───────────────┬─────────────────┘
                                                  ▼
                              ┌────────────────────────────────────┐
                              │  Unified Notes Search (notes-v2)    │
                              │  GET /search → blend + dedupe by id │
                              │  label each hit: exact | semantic   │
                              └────────────────────────────────────┘
```

**Invariant:** both sidecars are derived. `DELETE notes-index.sqlite && DELETE notes-search.sqlite` followed by a rebuild reproduces identical behavior from the files alone. The files never depend on either DB.

---

## 2. Stable note identity (the keystone — fixes rename + collisions)

### 2.1 The id

Every note carries a **stable, opaque id** stored in its **YAML frontmatter**, e.g.:

```yaml
---
id: n_k7f3p9q2          # stable; never changes on rename/move
title: Apollo Launch    # display title (defaults to H1 / filename if absent)
tags: [standup, q3]     # array of tag slugs (no leading #)
created: 2026-06-08T...
---
```

- `id` format: short collision-resistant slug (e.g. `n_` + base36 of time + 3 random chars), matching the project's existing id style (`qm-…`, `sess-…`, task ids). Generated **once**, on first save of a note that lacks one.
- The id is the **primary key everywhere**: link targets, backlink edges, tag edges, QMD virtual-path mapping. **Basename is display only.**
- Frontmatter is parsed with `js-yaml` (already installed) via a small `parseFrontmatter(md): { data, body }` helper (gray-matter-style, but we own it — no new dep).

> **Why frontmatter, not a separate id-map file?** The id travels *with* the note. Copy the file out of the vault, it keeps its identity. A sidecar map would be a second source of truth that can drift — violating the source-of-truth principle. Frontmatter keeps files self-describing and git-friendly. (This is additive: a note with no frontmatter still works; the indexer treats `id = absent` as "assign on next write".)

### 2.2 Links resolve by id, with a name fallback during migration

Authoring stays human-friendly — users still type `[[Apollo Launch]]`. Resolution order in the indexer:

1. If the link text is an **id** (`[[n_k7f3p9q2]]` or `[[Apollo Launch|n_k7f3p9q2]]` alias form) → resolve by id (exact, no ambiguity).
2. Else treat as **name** → look up `notes.title`/basename in the index. If exactly one match → resolve to that id. If multiple (collision) → record an **ambiguous** edge (surfaced in UI as "ambiguous link", never silently mis-resolved).

The editor's wiki-link autocomplete (already exists) is upgraded to **insert the id form under the hood** (display `[[Apollo Launch]]`, store `[[Apollo Launch|n_k7f3p9q2]]`) so newly authored links are collision-proof and rename-proof from day one. Legacy `[[name]]` links keep resolving via step 2.

### 2.3 Rename / move becomes O(1) — no vault rewrite

Because links key on id:
- **Rename/move only renames the file.** No `updateWikiLinksInAll()`. No whole-vault regex. The id in frontmatter is unchanged, so every existing edge in the index still points at the same note.
- The indexer updates that note's `path` column (one row) and the QMD virtual-path mapping (one document). Backlinks remain correct instantly.
- `updateWikiLinksInAll()` is **deleted** (root-cause removal, not deprecation). For legacy *name-based* links that displayed the old basename, an **optional** cosmetic pass can rewrite the display label — but link *resolution* never depended on it, so it is best-effort and non-blocking.

> This is the "fix the root cause" move: the fragile rewrite existed only because identity was the basename. Give notes real identity and the rewrite problem disappears entirely.

---

## 3. The structural sidecar — `notes-index.sqlite`

`better-sqlite3`, WAL mode, same construction pattern as `task-db.ts`. All schema lives in one migration file; bumping `schema_version` triggers a rebuild (see §7).

### 3.1 Schema (pseudocode DDL)

```sql
-- One row per note. id is the stable identity from frontmatter.
CREATE TABLE notes (
  id           TEXT PRIMARY KEY,        -- stable note id (frontmatter)
  path         TEXT NOT NULL UNIQUE,    -- vault-relative path, fwd slashes ('Projects/Apollo.md')
  title        TEXT NOT NULL,           -- frontmatter.title || first H1 || basename
  content_hash TEXT NOT NULL,           -- sha256 of file bytes (skip-if-unchanged)
  body         TEXT NOT NULL,           -- markdown body WITHOUT frontmatter (for snippets/FTS)
  frontmatter  TEXT,                    -- raw YAML block (round-trip fidelity)
  created      TEXT,                    -- ISO
  modified     TEXT NOT NULL,           -- ISO (file mtime)
  size         INTEGER NOT NULL
);
CREATE INDEX idx_notes_path  ON notes(path);
CREATE INDEX idx_notes_title ON notes(title COLLATE NOCASE);

-- Directed link edges. Resolved by id; unresolved/ambiguous links kept for UI honesty.
CREATE TABLE links (
  src_id       TEXT NOT NULL,           -- note that contains the link
  dst_id       TEXT,                    -- resolved target note id, NULL if unresolved
  dst_name     TEXT,                    -- raw [[name]] text as authored (for display + re-resolve)
  status       TEXT NOT NULL,           -- 'resolved' | 'unresolved' | 'ambiguous'
  context      TEXT,                    -- ±N chars around the link (backlink snippet)
  PRIMARY KEY (src_id, dst_name, context)
);
CREATE INDEX idx_links_dst ON links(dst_id);      -- backlinks: WHERE dst_id = ?
CREATE INDEX idx_links_src ON links(src_id);       -- forward links / cleanup on note change

-- Tag edges. Tag slugs normalized (lowercase, no leading '#').
CREATE TABLE tags (
  note_id      TEXT NOT NULL,
  tag          TEXT NOT NULL,           -- normalized slug, e.g. 'q3-planning'
  PRIMARY KEY (note_id, tag)
);
CREATE INDEX idx_tags_tag ON tags(tag);            -- "notes with tag X": WHERE tag = ?

-- Substring / keyword search over note body + title (FTS5, contentless = small).
CREATE VIRTUAL TABLE notes_fts USING fts5(
  note_id UNINDEXED, title, body,
  tokenize = 'unicode61 remove_diacritics 2'
);

-- Index-level bookkeeping (rebuild detection, status endpoint).
CREATE TABLE index_meta (
  key TEXT PRIMARY KEY, value TEXT      -- 'schema_version', 'last_full_rebuild', 'doc_count'
);
```

**Why FTS5 *and* not just `LIKE`:** the PRD requires "any exact substring that exists in the vault returns its note(s) — 100%". FTS5 gives fast prefix/token matching for the common case; for **true arbitrary-substring** (mid-token, e.g. searching `pollo`), we fall back to an indexed `LIKE %q%` scan over the `notes.body` column **in SQLite** (still one indexed query against in-memory pages, not N file reads). Both run inside the same DB query, so "string search" stays a single round-trip. (FTS5 is built into the `better-sqlite3` SQLite build already in use.)

### 3.2 What the sidecar replaces (1:1 mapping to the O(n) scans)

| Old O(n) scan | New O(log n) query |
|---|---|
| `/search` substring | `SELECT … FROM notes_fts WHERE notes_fts MATCH ?` (+ `LIKE` fallback for mid-token) |
| `/backlinks/*path` | `SELECT src… FROM links WHERE dst_id = (SELECT id FROM notes WHERE path=?)` |
| `/list` (wiki autocomplete) | `SELECT id,title,path FROM notes ORDER BY title` |
| tag browse (new) | `SELECT note_id FROM tags WHERE tag = ?` |
| `updateWikiLinksInAll` (rename) | **removed** — links key on id |

---

## 4. The reconciler — incremental, debounced, rebuildable

Reuse the **exact** pattern from `qmd-watcher.ts` (debounce) and `qmd-task-sync.ts` (hash-skip + programmatic upsert). The structural index updates from the same triggers that already feed QMD.

### 4.1 Triggers (two paths, same handler)

1. **In-process (fast path):** `PUT /content`, `DELETE /content`, `POST /move`, `POST /folder` already emit/should emit `NOTES_UPDATED`. The indexer subscribes to `NOTES_UPDATED` (via `bus`, using the **`interest`** set so it only wakes for note events — same mechanism that fixed event-loop starvation, see `event-bus.ts:161`) and reconciles **just the changed path** synchronously-ish (debounced ~300 ms to coalesce rapid autosaves).
2. **Filesystem (catch-all):** extend the existing `fs.watch(NOTES_DIR, {recursive})` block in `qmd-watcher.ts` to ALSO call `scheduleNotesIndexUpdate.call(filename)`. This catches external edits, git pulls, and the AI butler writing files directly — the cases the in-process path misses. Debounce 1 s (faster than QMD's 5 s embed because structural parsing is cheap; no model involved).

> One watcher, two consumers. We do **not** add a second `fs.watch` — we add a second debounced callback inside the existing one, keeping a single inotify registration.

### 4.2 Per-note reconcile (pseudocode)

```
function reconcileNote(relPath):
  abs = NOTES_DIR/relPath
  if not exists(abs):                       # deletion
      withFileLock(notes-index.sqlite):
        id = SELECT id FROM notes WHERE path = relPath
        DELETE notes/links(src=id)/tags/notes_fts for id
        # NOTE: do NOT delete inbound links; mark them unresolved so backlinks stay honest
        UPDATE links SET dst_id=NULL,status='unresolved' WHERE dst_id=id
      QMD: store.deactivateDocument('notes', virtualPathFor(relPath))   # existing API
      return

  bytes = read(abs); hash = sha256(bytes)
  row = SELECT content_hash FROM notes WHERE path = relPath
  if row and row.content_hash == hash: return            # hash-skip (same as task-sync)

  { data, body } = parseFrontmatter(bytes)
  id = data.id || assignNewId()                          # assign + write back if missing (§4.3)
  title = data.title || firstH1(body) || basename(relPath)
  tags  = normalizeTags(data.tags) ∪ inlineHashtags(body)   # frontmatter ∪ inline #tags
  links = extractLinks(body)                              # [[id]] / [[name|id]] / [[name]]

  withFileLock(notes-index.sqlite):                       # cross-process safe
    UPSERT notes(id, relPath, title, hash, body, frontmatter, created, modified, size)
    DELETE links WHERE src_id = id ; INSERT resolved/unresolved edges (resolve names → ids)
    DELETE tags  WHERE note_id = id ; INSERT tag rows
    UPSERT notes_fts(note_id, title, body)
    # re-resolve any previously-unresolved inbound links now that this id/title exists
    UPDATE links SET dst_id=id,status='resolved' WHERE dst_name = title AND dst_id IS NULL
  # QMD path is untouched here — qmd-watcher's own debounced update()/embed() handles semantics
```

Key reuse points: **hash-skip** (from `qmd-task-sync.ts`), **`withFileLock`** (from `file-lock.ts`), **debounce** (from `qmd-watcher.ts`), **`interest` filtering** (from `event-bus.ts`). No new concurrency primitive is invented.

### 4.3 id back-write (the one subtle write)

When a note lacks `id`, the indexer must persist a new one **into the file's frontmatter** so identity becomes stable. This is the only case where the indexer writes a `.md` file. It is done carefully:
- Take `withFileLock(<note>.md)` (per-note lock, distinct from the index lock) and re-read under lock; re-check `id` absent (double-check after lock).
- Splice/insert the `id:` line into existing frontmatter, or prepend a new frontmatter block, preserving the rest of the file byte-for-byte (no reformat).
- Write, then emit `NOTES_UPDATED` with the new `contentHash` so optimistic-lock clients refresh their hash (avoids a spurious 409 on the user's next save).
- **Editing-quality guard:** never back-write while the note is being actively edited in a focused client. The route layer knows the last-served `contentHash`; if the file's current hash ≠ what we read, skip the back-write this cycle and retry on the next reconcile. This guarantees the indexer can never clobber an in-flight edit (P0 "zero data loss").

> Alternative considered & rejected: assign id at **save time** in `PUT /content` instead of in the indexer. Rejected because files arriving via git pull / AI-butler writes bypass the route, so the indexer must own id-assignment anyway. Doing it in one place (the reconciler) is the root-cause-correct location. The route MAY *also* stamp an id on create as an optimization, but the reconciler remains the authority.

---

## 5. Semantic index — widen coverage, then expose (mostly already done)

### 5.1 Fix the coverage gap (prerequisite, tiny)

`getNotesStore()` currently maps four PARA collections. Notes in arbitrary folders (which `notes-v2.ts` freely creates) are **never embedded**. Replace the four hard-coded collections with **one whole-vault collection**:

```
collections: {
  vault: { path: NOTES_DIR, pattern: '**/*.md', ignore: ['global-notes.md', '.*/**'] }
}
```

- Update `memory-search.ts` `SOURCE_WEIGHTS`: collapse `note_areas/projects/resources/archive` → a single `note_vault` weight (default 1.0). PARA-specific weighting is lost, but coverage correctness > folder bias (and most vaults are not strict PARA). If folder weighting is later desired, derive it from `path` prefix at rank time, not from QMD collections.
- This is a **one-time re-embed** (model-mismatch logic in `qmd-store.ts:initQmdStores` already handles forced re-embeds; widening the glob just means `update()` discovers more files on next run).

### 5.2 Expose via the existing blend

`memoryNotesSearch(queries, ['note_vault'], limit)` already returns ranked semantic hits with snippets. We reuse it verbatim — same call shape `core/search.ts` uses for memory/tasks. Nothing new in the semantic layer beyond the source-name change.

---

## 6. Unified Notes Search API — BOTH, together

The PRD demands string **and** semantic in one labeled list, exact never buried. Implemented in `notes-v2.ts`'s `GET /search`, mirroring `core/search.ts`'s fan-out + merge.

### 6.1 Endpoint

```
GET /api/notes-v2/search?q=<query>&limit=30&mode=hybrid|string|semantic
→ {
    results: [
      {
        id, path, title,
        snippet,                  // best matching excerpt
        matchType: 'exact' | 'semantic' | 'both',
        score,                    // unified rank score
        stringScore?, semanticScore?,   // for transparency / debugging (uncapped)
        matchedTags?: string[]
      }, ...
    ],
    degraded?: 'semantic-unavailable'   // set if QMD failed; string results still returned
  }
```

`mode` defaults to `hybrid`. `string` and `semantic` allow the UI to offer power-user toggles, but the default surfaces both.

### 6.2 Blend algorithm (pseudocode)

```
async function notesSearch(q, limit):
  # Run both legs in parallel (Promise.allSettled — one failing never zeroes the other)
  [stringHits, semanticHits] = await allSettled([
     stringLeg(q, limit*2),                              # notes-index.sqlite: FTS5 + LIKE fallback
     memoryNotesSearch(q, ['note_vault'], limit*2),      # QMD (existing)
  ])

  byId = map<id, Result>()
  for h in stringHits:    upsert(byId, h.id, {matchType:'exact',    stringScore: h.bm25})
  for h in semanticHits:
     id = idFromQmdPath(h.filepath)                      # resolve QMD virtual path → note id via notes-index
     if byId.has(id): byId[id].matchType = 'both';  byId[id].semanticScore = h.score
     else:            upsert(byId, id, {matchType:'semantic', semanticScore: h.score})

  # Ranking rule (PRD: exact hits NEVER ranked below purely-semantic):
  #   tier 1: matchType ∈ {exact, both}   → ordered by max(stringScore, semanticScore)
  #   tier 2: matchType == semantic        → ordered by semanticScore
  rank = (r) => (r.matchType=='semantic' ? 0 : 1)*BIG + normalize(scores)
  return sort(byId.values, by rank desc).slice(0, limit)

function stringLeg(q):
  # single SQLite round-trip
  SELECT note_id,title, snippet(body,q) FROM notes_fts WHERE notes_fts MATCH escapeFts(q)
  UNION
  SELECT id,title, substrSnippet(body,q) FROM notes WHERE body LIKE '%'||q||'%'   # mid-token safety net
```

- **De-dupe by `id`** (the PRD's "single result list, de-duplicated by note"). A note that matches both legs becomes one row, `matchType:'both'`.
- **Labeling**: `matchType` drives the UI badge ("matched text" vs "related meaning" vs both) so the user trusts the ranking — directly satisfying PRD §5.
- **Graceful degradation**: if QMD throws (model mismatch / cold), string results still return with `degraded:'semantic-unavailable'`; the existing `core/search.ts` already models this fallback discipline and we copy it.
- **id resolution for semantic hits**: QMD returns a virtual/abs path; we map path → id via `notes-index` (`SELECT id FROM notes WHERE path=?`). If a semantic hit's file isn't in the structural index yet (race), fall back to path as the dedupe key.

---

## 7. Tags & frontmatter — storage, parsing, query

### 7.1 Tag sources (union)

A note's tags = `frontmatter.tags[]` **∪** inline `#hashtags` in the body. Both feed the `tags` table. Normalization: lowercase, strip leading `#`, slugify spaces→`-`. (Editor-side, the `#tag` node and frontmatter `tags` property are covered in the editor design doc; here we only define storage + query.)

### 7.2 Frontmatter parsing

- `parseFrontmatter(bytes) → { data: object, body: string }` using `js-yaml` (installed). Tolerant: malformed YAML → treat whole file as body, `data = {}`, log a debug warning, **never** throw (a bad frontmatter block must not break indexing of the rest of the vault — index-drift mitigation, PRD risk #5).
- `body` (frontmatter-stripped) is what gets FTS-indexed and embedded-snippet'd, so searching never matches raw `id:`/`created:` lines.
- Round-trip: the raw frontmatter block is preserved verbatim in `notes.frontmatter` and re-emitted unchanged on the editor's behalf, protecting the P0 "byte-clean Markdown, 0 spurious diffs" gate.

### 7.3 Tag API

```
GET  /api/notes-v2/tags                 → [{ tag, count }, ...]   (all tags, for autocomplete)
GET  /api/notes-v2/tags/:tag/notes      → [{ id, title, path, snippet, modified }]  (newest first)
POST /api/notes-v2/tags/rename          { from, to }
     → rewrites frontmatter `tags` + inline `#from`→`#to` ONLY in notes carrying it
       (targeted by the tag index — NOT a vault scan), then reconciles those notes.
```

Tag rename is **targeted**: `SELECT note_id FROM tags WHERE tag=?` yields the exact files to edit (Scenario E). This is O(notes-with-tag), not O(vault) — the same root-cause discipline as backlinks.

---

## 8. Full API surface (additions / changes to `notes-v2.ts`)

| Method & path | Change | Backed by |
|---|---|---|
| `GET /search?q&mode&limit` | **Rewritten** — hybrid string+semantic, labeled, deduped by id | notes-index FTS + QMD |
| `GET /backlinks/*path` | **Rewritten** — index lookup, returns `id` + resolved status | `links` table |
| `GET /list` | Served from index; now returns `id` per note | `notes` table |
| `GET /tags` | **New** | `tags` table |
| `GET /tags/:tag/notes` | **New** | `tags` + `notes` |
| `POST /tags/rename` | **New** — targeted rewrite | `tags` table |
| `GET /links/*path` | **New** (optional) — forward links of a note | `links` table |
| `GET /index/status` | **New** — `{ docCount, lastRebuild, schemaVersion, embedState, degraded? }` | `index_meta` + QMD `getStatus()` |
| `POST /index/rebuild` | **New** — drop + rebuild structural sidecar (admin/Settings) | reconciler |
| `POST /move` | **Simplified** — file rename only; `updateWikiLinksInAll` **removed** | reconciler updates 1 row |
| `PUT/DELETE/POST /content,/folder` | Unchanged externally; now also fire reconcile via `NOTES_UPDATED` | reconciler |

`GET /index/status` doubles as the health/observability surface (PRD: "index == vault ground truth" assertions hook here in tests).

---

## 9. Data migration & cold rebuild

### 9.1 Existing-vault migration (one-time, automatic, reversible)

1. On server start, `initNotesIndex()` runs **after** `initQmdStores()`. If `notes-index.sqlite` is absent or `index_meta.schema_version` < current → **full rebuild**.
2. Full rebuild = walk the vault once (`getAllMdFiles`, reused), `reconcileNote()` each file. This is the *only* O(n) pass, and it runs once at startup / on explicit rebuild — never per query.
3. During rebuild, notes missing `id` get one **lazily on first subsequent write**, not eagerly — eager back-writing the whole vault at once would create a large git-sync churn and risk clobbering files. Until a note has an id, its links still resolve by name (§2.2), so nothing breaks. (Optionally, an opt-in "stamp all ids now" admin action exists for users who want full id coverage immediately.)
4. **Reversibility:** migration never deletes or rewrites note content (except the careful, guarded id back-write). Deleting both sidecars returns the system to a pure-files state; the only persisted artifact in the files is the additive `id:` frontmatter line, which is harmless and human-ignorable.

### 9.2 Cold rebuild safety

- Build into a **temp DB** (`notes-index.sqlite.rebuilding`) then atomic-rename over the live one (POSIX `rename` is atomic) — readers never see a half-built index.
- Rebuild holds `withFileLock(notes-index.sqlite)` only for the final swap, not the whole walk, so it doesn't block reads for minutes on a large vault.
- QMD's own rebuild (`embed({force})`) is independent and already handled by `qmd-store.ts`; the structural rebuild does not touch embeddings.
- `GET /index/status` reports `rebuilding: true` so the UI can show a subtle "indexing…" state without blocking search (string falls back to a bounded live scan during the brief window; semantic keeps working off QMD).

---

## 10. Concurrency & failure modes

| Scenario | Handling |
|---|---|
| Two processes reconcile same note (server + ephemeral) | `withFileLock(notes-index.sqlite)` (mkdir-atomic, PID-liveness stale detection) serializes writes; hash-skip makes the loser a no-op. Same primitive as tasks/sessions. |
| Indexer back-write races a user save | Per-note `withFileLock(<note>.md)` + re-check hash under lock + skip-if-changed (§4.3). Indexer **never** wins over an in-flight edit. |
| Optimistic-lock 409 after id back-write | Back-write emits `NOTES_UPDATED` with new `contentHash`; client refreshes its expected hash before next PUT. |
| QMD store down / model mismatch | `Promise.allSettled` → string leg still returns; `degraded:'semantic-unavailable'`. Mirrors `core/search.ts`. |
| Malformed frontmatter | `parseFrontmatter` never throws; note indexed as body-only; debug log. One bad note can't break the vault index. |
| External edit / git pull / AI-butler write | Caught by `fs.watch` catch-all leg (§4.1) → reconcile. Both sidecars converge. |
| Index drift (sidecar ≠ files) | Sidecars are rebuildable; `POST /index/rebuild` + startup schema check; correctness tests assert `index == vault`. |
| Ephemeral server isolation | Ephemeral uses its own `OPEN_WALNUT_HOME` temp dir → its own `notes-index.sqlite`; it must NOT touch production's sidecar. Follows the existing ephemeral-isolation gating discipline. |
| FTS query injection / special chars | `escapeFts(q)` sanitizes FTS5 operators; `LIKE` leg uses parameter binding. (Same care as `memory-search.ts` `sanitizeForVec`.) |
| Stale unresolved links | Deleting a note marks inbound edges `unresolved` (not deleted) so backlinks stay truthful; re-creating the id re-resolves them (§4.2). |
| Event-loop starvation from reconcile storms | Debounce coalesces; reconcile is per-changed-path (not full vault); `interest`-filtered bus subscription avoids waking on unrelated events. |

---

## 11. Phasing (maps to PRD P0/P1; each step independently shippable)

1. **Step 0 (day-one win, no schema):** widen `getNotesStore()` to whole-vault (§5.1) + in `GET /search` call `memoryNotesSearch` and merge with the current substring scan (§6, naive merge). Semantic notes search works immediately. *This is the PRD's "simplest first step."*
2. **Step 1 (structural sidecar):** create `notes-index.sqlite` + reconciler + `fs.watch` catch-all; rewrite `/search` string leg, `/backlinks`, `/list` to read the index. O(n) scans gone.
3. **Step 2 (identity):** id frontmatter + id-keyed links + name-fallback; simplify `/move` (delete `updateWikiLinksInAll`). Rename integrity solved.
4. **Step 3 (tags & frontmatter):** tags table, `/tags*` endpoints, frontmatter properties.
5. **Step 4 (polish):** `/index/status`, `/index/rebuild`, temp-DB atomic rebuild, search labeling/ranking tuning on a labeled eval set.

---

## 12. Test plan (root-cause correctness, not feel)

- **Index == vault invariant:** seed a fixture vault → build index → assert every `notes`/`links`/`tags` row matches a direct file scan. Delete sidecar → rebuild → assert identical. (Drift mitigation.)
- **Rename integrity:** create A linking to B by id; rename + move B; assert backlink from A still resolves, 0 vault rewrites, 0 orphans. Repeat with two same-named notes (collision) → assert no mis-resolution.
- **Hybrid search:** labeled "vague phrase → expected note" set (verbatim-absent) → expected note in top 3 (semantic). Exact substring present in vault → returns its note(s) 100% and never below a purely-semantic hit (ranking rule §6.2).
- **Concurrency:** parallel reconcile + user save on the same note → no lost edit, no clobbered id, no 409 storm.
- **Degradation:** kill QMD → string search still returns with `degraded` flag.
- **Latency:** representative vault → string ≤ 300 ms, backlinks ≤ 150 ms (PRD metrics), all served from indexes.
- Hooks run through `startServer({ port: 0, dev: true })`, mocking only embeddings if needed — per `tests/AGENTS.md`.

---

## 13. Explicit non-goals (this doc)

- Editor extension architecture (tables, slash menu, drag handle, tag node, callouts) — separate editor design doc.
- Markdown serialization contracts for callouts/tables/tags — defined in the editor doc; this doc only stores/queries the resulting markdown + frontmatter.
- Graph view, canvas, multiplayer — hard non-goals per PRD.
- Replacing QMD or its embedding model — out of scope; we reuse it as-is and only widen its collection glob.
