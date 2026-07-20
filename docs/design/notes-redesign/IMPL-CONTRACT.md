# Notes Redesign — IMPLEMENTATION CONTRACT (single source of truth for the build)

> **Role:** This is the cross-team contract the Backend (BE) and Frontend (FE) pods build against so neither
> has to guess the other's interface. It is derived from (and subordinate to) the approved design:
> `00-executive-summary.md`, `02-technical-design.md` (AUTHORITATIVE), `01-product-design.md`,
> `ux-decision.md`, `03-editor-architecture.md`, `02-search-and-index-design.md`.
> Where this doc and `02-technical-design.md` disagree, the tech design wins — report the drift.
>
> **Owner decisions baked in (final):** Cmd+K is **P0** (build now). On-disk links are **Obsidian-native**
> `[[Title]]` / `[[folder/Title]]`; id lives **only** in YAML frontmatter; `[[Title|id]]` is **rejected**.
> Write-write conflict = **agent-writes-win**, loss bounded to one debounce window and **surfaced** (add the
> WS-path dirty-guard in `useNoteContent.ts`).
>
> **Repo rule:** PUBLIC open-source. All code/comments/text ENGLISH; no internal names. Files < ~500 LOC.
> Markdown stays byte-clean across round-trip (the #1 bug source).

---

## 0. The contract in one screen

- **Identity:** every note gets a stable `id` in YAML frontmatter, **stamped at create time** by the BE.
  Links are authored/stored Obsidian-native (`[[Title]]` / `[[folder/Title]]`); the index resolves a link to
  the **target note's frontmatter id** and keys the edge on that id. The id NEVER appears in link text.
- **Backend serves structure from a rebuildable sidecar** (`notes-index.sqlite`): `GET /search` (hybrid,
  deduped-by-id, labeled), `GET /backlinks` (id-keyed), `GET /list` (now returns `id`), `GET /tags`,
  `GET /index/status`, `POST /index/rebuild`, simplified `POST /move` (no link rewrite). Files stay source of
  truth; the sidecar reconciles on change.
- **Frontend extends the existing TipTap editor**: Notion slash insert-block menu, tables (owned GFM
  serializer), bubble toolbar, drag-handle, `#tag` chip, callout/divider, Cmd+K front door, hybrid search UI.
- **The ONE hard cross-dependency:** FE link authoring + frontmatter wrapper (FE-E4/E5) depend on BE identity
  landing (BE-B2). Everything else ships in parallel.
- **Two contracts both sides MUST agree on byte-for-byte:** the **REST shapes** (§1) and the **on-disk
  Markdown serialization** for tables / `#tags` / callouts / dividers / wiki-links (§3).

---

## 1. REST API surface — full notes API after this work

Base path: `/api/notes-v2` (router `src/web/routes/notes-v2.ts`, mounted by the existing server — do NOT
touch `server.ts`). All paths are vault-relative, forward-slash, `.md` optional on input, kept inside
`NOTES_DIR` (reject `..`/absolute escapes). `*path` is an Express-5 wildcard (already handled by
`getWildcardPath`). All endpoints continue to use `computeContentHash` for the optimistic-lock hash.

Legend: **U** = unchanged · **C** = changed/rewritten · **N** = new.

### 1.1 Endpoint table

| # | Method & path | State | Purpose |
|---|---|---|---|
| 1 | `GET /` | U | File tree (`{ tree: TreeNode[] }`) |
| 2 | `GET /content/*path` | C | Read note — now also returns `id` (when known) |
| 3 | `PUT /content/*path` | C | Create/update note — **stamps `id` in frontmatter at create time** |
| 4 | `DELETE /content/*path` | C | Delete note (fires reconcile) |
| 5 | `POST /move` | C | **Rename/move only — `updateWikiLinksInAll` REMOVED** (id-keyed links survive) |
| 6 | `POST /folder` | U | Create folder |
| 7 | `GET /list` | C | Flat note list for `[[` autocomplete — **now returns `id` per note** |
| 8 | `GET /search?q&mode&limit` | C | **Hybrid** string+semantic, deduped-by-id, labeled |
| 9 | `GET /backlinks/*path` | C | Index-backed, id-keyed, returns `status` |
| 10 | `GET /links/*path` | N | Forward links of a note (optional, for relations/debug) |
| 11 | `GET /tags` | N | All tags, **frequency-ranked** (autocomplete source) |
| 12 | `GET /tags/:tag/notes` | N | Notes carrying a tag, newest first (P1 browse; ship endpoint now) |
| 13 | `POST /tags/rename` | N | Targeted tag rewrite (P1; ship behind tag index) |
| 14 | `GET /index/status` | N | Index health/observability + test hook |
| 15 | `POST /index/rebuild` | N | Drop + rebuild structural sidecar (admin/Settings) |
| 16 | `POST /image` (existing global notes path) | U | Image upload (already exists; not in scope) |

> Note on the existing image route: image upload is `POST /api/notes-v2/image` per the build brief; it already
> exists and is **out of scope**. Do not modify `src/web/routes/local-image.ts` (DO-NOT-TOUCH).

### 1.2 Request / response shapes (the wire contract)

**Shared types**

```ts
type Iso = string;            // ISO-8601
type MatchType = 'exact' | 'semantic' | 'both';   // ● exact / ○ semantic / ◐ both
type LinkStatus = 'resolved' | 'unresolved' | 'ambiguous';

interface TreeNode { name: string; path: string; type: 'file' | 'folder'; children?: TreeNode[] }
```

**2. `GET /content/*path`**
```ts
// 200
{
  content: string;            // full file bytes INCLUDING frontmatter (unchanged contract)
  updatedAt: Iso;
  contentHash: string;
  id?: string;                // NEW: stable note id if assigned (from frontmatter / index)
}
// 404 { error: 'Note not found' }
```

**3. `PUT /content/*path`** — body `{ content: string; expectedHash?: string }`
```ts
// 200
{ ok: true; updatedAt: Iso; contentHash: string; id?: string }   // id: NEW, the stamped/known id
// 409 { error: 'Content was modified externally'; currentHash: string }   // optimistic-lock (UNCHANGED)
// 413 { error: 'Content too large (max <N> bytes)' }
// 400 { error: 'content (string) is required' | 'invalid path' | 'path required' }
```
- **Identity contract:** if the submitted `content` has no frontmatter `id` AND this is a create (or the
  on-disk file lacks one), the BE **stamps a new `id` into the frontmatter before writing to disk**, and the
  bytes written (and hence `contentHash`) reflect the stamped content. The response `id` + `contentHash`
  let the FE refresh its expected hash without a spurious 409. Existing frontmatter is preserved
  byte-for-byte except for the spliced `id:` line (§2.4).
- Still emits `bus.emit(NOTES_UPDATED, { source: 'notes/<path-without-.md>', contentHash }, ['web-ui'])` —
  the source format is a shared contract with `useNoteContent.ts`; do NOT change it.

**4. `DELETE /content/*path`** → `{ ok: true }` / 404. (Reconciler marks inbound links `unresolved`.)

**5. `POST /move`** — body `{ from: string; to: string }`
```ts
// 200 { ok: true }
// 404 { error: 'Source note not found' }   // 409 { error: 'Destination note already exists' }
// 400 { error: 'from and to (strings) are required' | 'invalid path' }
```
- **`updateWikiLinksInAll()` is DELETED.** Move = file rename + one-row `path` update in the index + one QMD
  virtual-path remap. Links survive because they key on the target's frontmatter id.

**7. `GET /list`**
```ts
{ notes: Array<{ id: string; title: string; path: string; name: string }> }
// `name` kept for back-compat (basename, no .md); `title` = display title; `id` is NEW and feeds [[ authoring.
```

**8. `GET /search?q=<query>&limit=<30>&mode=<hybrid|string|semantic>`** — `mode` defaults to `hybrid`.
```ts
{
  results: Array<{
    id: string;               // stable note id (dedupe key). Falls back to relPath if not yet indexed.
    path: string;             // vault-relative, fwd-slash
    title: string;
    snippet: string;          // best matching excerpt; matched span wrapped for highlight (see note)
    matchType: MatchType;     // 'exact' | 'semantic' | 'both'
    score: number;            // unified rank score
    stringScore?: number;     // transparency/debug (uncapped)
    semanticScore?: number;   // transparency/debug (uncapped)
    matchedTags?: string[];
  }>;
  degraded?: 'semantic-unavailable';   // set when QMD leg failed; string results still returned
}
```
- **Dedupe by `id`** → exactly one row per note. A note hit by both legs is `matchType:'both'`.
- **Ranking (FROZEN):** exact/both NEVER below purely-semantic. tier1 `{exact,both}` by
  `max(stringScore,semanticScore)`, tier2 `semantic` by `semanticScore`.
- **Snippet highlight contract:** the matched span is delimited so the FE can highlight it. **BE emits the
  span wrapped in `<mark>…</mark>`**; FE renders snippets through the existing `marked`→DOMPurify viewer and
  the DOMPurify allowlist already permits `<mark>` is NOT guaranteed — **FE MUST add `mark` to `ADD_TAGS`** in
  the notes viewer post-pass (§4). (Alternative if the pods prefer offsets: `snippetMatch?: {start,len}` — but
  default to `<mark>` since the viewer already parses HTML.) Pick `<mark>` unless both pods agree otherwise.
- **Empty/whitespace `q`** → `{ results: [] }` (unchanged).
- **Semantic path normalization (BLOCKING):** the semantic leg (`memoryNotesSearch`) returns an **absolute**
  `filepath`; the index stores **vault-relative**. BE owns `idFromQmdPath(filepath)` =
  `path.relative(NOTES_DIR, filepath)` → fwd-slash → case-insensitive `SELECT id FROM notes WHERE path=?`,
  falling back to the relPath as the dedupe key only if unindexed. Getting this wrong double-lists every
  both-leg note.
- **Eventual-consistency note:** string leg is authoritative + always fresh (~300 ms–1 s); semantic may lag
  during embed. FE must not assume a freshly-edited note is `◐ both` immediately.

**9. `GET /backlinks/*path`**
```ts
{
  backlinks: Array<{
    id: string;               // source note id
    path: string;             // source note path
    title: string;
    name: string;             // basename (back-compat)
    snippet: string;          // ±context around the link
    status: LinkStatus;       // 'resolved' | 'ambiguous'  (ambiguous edges are shown, not hidden)
    candidates?: string[];    // when status==='ambiguous': candidate target ids/paths (UI lists them)
  }>;
}
```
- Served from `SELECT … FROM links WHERE dst_id = (SELECT id FROM notes WHERE path=?)`. Ambiguous inbound
  edges are returned explicitly (FE renders "links to one of N notes named X").

**10. `GET /links/*path`** (optional)
```ts
{ links: Array<{ dstId: string | null; dstName: string; status: LinkStatus; title?: string; path?: string }> }
```

**11. `GET /tags`** — frequency-ranked
```ts
{ tags: Array<{ tag: string; count: number }> }   // sorted by count desc; tag = normalized slug, no '#'
```

**12. `GET /tags/:tag/notes`**
```ts
{ notes: Array<{ id: string; title: string; path: string; snippet: string; modified: Iso }> }  // newest first
```

**13. `POST /tags/rename`** — body `{ from: string; to: string }`
```ts
{ ok: true; updated: number }   // targeted rewrite of frontmatter tags + inline #from→#to in carrying notes only
// 400 on missing/invalid args
```

**14. `GET /index/status`**
```ts
{
  docCount: number;
  lastRebuild: Iso | null;
  schemaVersion: number;
  embedState: 'idle' | 'embedding' | 'unavailable';
  embedProgress?: { done: number; total: number };   // surfaces the one-time widen re-embed (§5)
  dbSizeBytes: number;
  rebuilding?: boolean;
  degraded?: 'semantic-unavailable';
}
```

**15. `POST /index/rebuild`** → `{ ok: true; rebuilding: true }` (off-loop, bounded, atomic temp-DB swap).

> FE API client (`web/src/api/notes-v2.ts`) MUST be extended with: `id`/`title` on `NoteListItem` and
> `SearchResult`/`BacklinkResult`; new `matchType`/`score`/`status` fields; and new functions
> `searchNotesHybrid`, `fetchTags`, `fetchTagNotes`, `renameTag`, `fetchIndexStatus`, `rebuildIndex`,
> `fetchForwardLinks`. Keep the existing function names working (back-compat) where the brief depends on them.

---

## 2. Note IDENTITY contract (the keystone — BE owns, FE consumes)

### 2.1 The id
```yaml
---
id: n_k7f3p9q2          # stable, opaque; NEVER changes on rename/move
title: Apollo Launch    # display title (defaults to first H1, then basename)
tags: [standup, q3]     # array of slugs, NO leading '#'
created: 2026-06-08T...
---
```
- **Format:** `n_` + base36(time) + 3 random chars (matches `qm-…`/`sess-…`/task id style).
- **Assigned AT CREATE TIME** by the BE in `PUT /content` (first write) — NOT lazily — to avoid the
  git-sync multi-machine divergence hazard (§8.3 of tech). The reconciler is the **fallback** authority for
  files that arrive without an id (git pull / external/AI write).
- **Primary key everywhere:** link targets, backlink edges, tag edges, QMD virtual-path mapping. Basename is
  **display only**.
- **Parsed** with a tolerant owned helper `parseFrontmatter(bytes) → { data, body }` (js-yaml, already
  installed; gray-matter-style). Malformed YAML → treat whole file as body, `data={}`, debug-log, **never
  throw** (one bad note can't break the vault index).

### 2.2 How `[[Title]]` resolves to an id (Obsidian-native; FROZEN)
1. **Path form `[[folder/Title]]`** → resolve by `path` (exact, collision-free).
2. **Name form `[[Title]]`** (or display part before a real `|alias`) → look up `title`/basename:
   - exactly one match → `status='resolved'`, edge keyed on that note's frontmatter `id`.
   - multiple matches → `status='ambiguous'` (record candidates; never silently mis-resolve).
   - none → `status='unresolved'` (re-resolved when the target appears).
- **The `ambiguous` edge rule:** a bare `[[Title]]` pointing at two same-named notes is ambiguous exactly as
  in Obsidian. It is recorded (`status='ambiguous'`, optional candidate id list) and surfaced in the
  backlinks panel ("links to one of N notes named X"). **Rename refuses-or-warns** when it would create a
  *second* id-less note with an existing basename (the only way to manufacture fresh ambiguity).
- **Rename-proofness** comes from the **target's** frontmatter id, not from anything in the link text.

### 2.3 NEVER `[[Title|id]]`
The `|` slot is Obsidian's real display-alias slot. A user-chosen alias uses it with Obsidian semantics
(`[[Title|shown text]]`). The id is NEVER written into link text. Authoring inserts plain
`[[Title]]` / `[[folder/Title]]`.

### 2.4 Frontmatter wrapper (FE) + id back-write (BE)
- **FE (E5):** on load, split `{frontmatter, body}`; feed only `body` to `setContent`; stash `frontmatter`
  in a ref; on save, re-attach `frontmatter` verbatim in front of `getMarkdown()` before `PUT`. Frontmatter
  is **never** an editor node. This guarantees the `id` line round-trips byte-for-byte and is unreachable by
  editing.
- **BE id back-write (reconciler, for files lacking an id):** `withFileLock(<note>.md)`, re-read under lock,
  re-check id absent, splice the `id:` line preserving the rest **byte-for-byte**, write, emit
  `NOTES_UPDATED` with the new `contentHash`. **Never back-write while the file's current hash ≠ what we
  read** (skip, retry next cycle) — the indexer can never clobber an in-flight edit.

---

## 3. Markdown SERIALIZATION contract (what bytes land on disk)

Both the editor serializer (FE, `tiptap-markdown` per-extension `addStorage().markdown`) and the backend
parser/indexer (BE, `parseFrontmatter` + link/tag extraction + `marked` viewer) MUST agree on these exact
byte forms. The **round-trip corpus** (§6) is the joint acceptance gate.

### 3.1 Tables — OWNED GFM serializer (FE owns serialize; BE/viewer parse GFM)
- **Disk form:** standard GFM pipe table **with an alignment row**:
```
| Name | Role | Action |
| :-- | :-: | --: |
| Ana | Lead | ship |
```
- Header row delimiter encodes per-column `align`: `:--` left · `:-:` center · `--:` right · `---` none.
- **Escape `\|` for every literal pipe in cell content, INCLUDING inside inline-code spans**
  (a raw `|` in `` `x|y` `` truncates the cell on re-parse — verified). Escaped `` `x\|y` `` round-trips.
- **Schema/UI constraints that make the pipe path always takeable:** first row ALWAYS all-`tableHeader`
  (no "toggle header off"); cells = **inline + hard-break (`<br>`) only** (no block children, no nested
  lists); **no merged cells** (no colspan/rowspan). These guarantee `childCount===1` so the shipped
  HTML-fallback path is unreachable.
- **HARD INVARIANT:** **no table ever serializes to `<table>` HTML.** The shipped tiptap-markdown table
  serializer is NOT used — FE registers its own.
- **Viewer (BE/`marked`):** GFM alignment renders natively — already consistent.

### 3.2 `#tags` — literal text
- **Disk form:** literal `#tag` text (e.g. `… discussed #standup #q3-planning`). Nothing extra written;
  greppable; plain text to `marked`.
- **FE node:** atomic inline `Node` (chip); serialize `state.write('#'+name)`; parse = markdown-it inline
  rule firing only on `#`+letter, NOT at heading-start, AFTER link tokenization.
- **Not-a-tag cases (tested):** `C#`/`F#` (letter directly before `#`), `#frag` inside a URL/link,
  `#123` (digit after `#`). Idempotent round-trip (no doubled `##`, no lost `#`).
- **Tag slug normalization (BE + FE must match):** lowercase, strip leading `#`, spaces→`-`. Tag sources =
  `frontmatter.tags[]` ∪ inline `#hashtags`.
- **Viewer:** a `notes-markdown.ts` post-pass (BEFORE DOMPurify) wraps `#tag` in `<span class="notes-tag">`.

### 3.3 Callouts — `> [!kind]` admonition
- **Disk form (FROZEN):**
```
> [!warning]
> body line one
> body line two
```
- **Kinds (FROZEN allow-set):** `note · tip · warning · danger · info`. An unknown `[!xxx]` stays a plain
  blockquote.
- **FE node:** block `Node`; serialize `state.write('> [!'+kind+']')` + `wrapBlock('> ', …)` over body;
  parse recognizes a blockquote whose **first line is exactly `[!kind]`** and re-tags it (plain blockquotes
  stay blockquotes). DOM-rewrite (`parse.updateDOM`) is the recommended low-risk parse path.
- **Viewer:** `notes-markdown.ts` post-pass turns a `[!kind]`-leading blockquote into
  `<div class="notes-callout" data-kind="…">`; **extend the DOMPurify `ADD_ATTR` allowlist with `class` and
  `data-kind`** (and `mark` in `ADD_TAGS` for search highlight). DOMPurify remains the single trust boundary.

### 3.4 Divider — `---`
- StarterKit `HorizontalRule`, disk form `---` on its own line. Zero new serialization. (Note for the
  parser: a `---` line is a divider, distinct from the frontmatter fence which is the leading `---\n…\n---`
  block handled by `parseFrontmatter` before body parsing.)

### 3.5 Wiki-links — Obsidian-native (consumes §2.2)
- **Disk form:** `[[Title]]` / `[[folder/Title]]` / a real `[[Title|alias]]`. Plain text → trivial
  round-trip. **No `n_id` in link text, ever.**
- BE wiki-link extraction regex must accept the path form and the real-alias form (display part before `|`),
  feeding §2.2 resolution. (Today's `WIKI_LINK_RE` already captures `[[target]]`/`[[target|label]]`.)

---

## 4. File-ownership map (honors DO-NOT-TOUCH; how Cmd+K mounts)

### 4.1 DO NOT TOUCH (other sessions own — strict)
`web/src/utils/markdown.ts`, `web/src/styles/globals.css`, `web/src/components/common/FileContentView.tsx`,
`src/web/routes/local-image.ts`, ROOT `package.json`, `src/core/event-bus.ts`, `src/core/event-types.ts`,
`src/web/server.ts`, `src/web/ws/handler.ts`, `src/providers/*`, `src/core/session-*`,
`web/src/hooks/useChat.ts`, `web/src/pages/MainPage.tsx`, `web/src/api/ws.ts`.

### 4.2 New CSS (REQUIRED — never use globals.css)
Create **`web/src/components/notes/notes-editor.css`**, imported by `NotesEditor.tsx` (and any new notes
component that needs styling: bubble menu, drag-handle, tag chip, callout, search overlay, Cmd+K).
**All new notes styling lives here.** Never edit `globals.css`.

### 4.3 Cmd+K mount (without touching forbidden files)
Cmd+K is P0. Mount it from a **NOTES-OWNED** component with a global keydown listener — do NOT edit
`MainPage.tsx` / `server.ts` / `App.tsx`.
- **Mount point:** `web/src/pages/NotesPage.tsx` (notes-owned, NOT on the DO-NOT-TOUCH list) renders a new
  `web/src/components/notes/CommandPalette.tsx`. The palette registers `window.addEventListener('keydown', …)`
  on mount (guard `(e.metaKey||e.ctrlKey) && e.key==='k'`, `preventDefault`), opens a centered overlay
  (React portal to `document.body`), and is the **same component** used for the `/notes` hybrid search box
  (two default modes: Jump+Capture, and search). Cleans up the listener on unmount.
- **Scope caveat (report it):** mounting on `NotesPage` makes Cmd+K active only while the `/notes` route is
  mounted. The brief forbids editing `MainPage.tsx`/`App.tsx`. If true app-wide Cmd+K (from any page) is
  required, that is a shared-file change — **do not make it silently; surface it in `sharedFileTouches` for
  review.** Default build = NotesPage-scoped P0 palette (meets jump-to-note + quick-capture + hybrid search
  + New-note on `/notes`).

### 4.4 FE ownership (extend/create — all under `web/src/`)
- **Extend:** `components/notes/NotesEditor.tsx` (wire new extensions; import `notes-editor.css`),
  `components/notes/slash-commands/{types.ts, SlashCommandExtension.ts, SlashCommandPortal.tsx,
  SlashCommandMenu.tsx}` (block catalog + dispatch + fuzzy + trigger-by-class),
  `components/notes/wiki-link/{WikiLinkExtension.ts, WikiLinkAutocomplete.tsx}` (Obsidian-native authoring),
  `components/notes/notes-markdown.ts` (tag/callout viewer post-passes + `mark`/`class`/`data-kind` allowlist),
  `components/notes/NotesTreePanel.tsx` (virtualize for large vaults; non-drag reorder affordance for the
  narrow popup surface — customer-flagged), `components/notes/BacklinksPanel.tsx` (id-keyed + ambiguous),
  `pages/NotesPage.tsx` (mount palette; empty-state New-note CTA),
  `hooks/useNoteContent.ts` (**add the WS-path dirty-guard** — §6 below),
  `hooks/{useBacklinks.ts, useNotesTree.ts}`, `api/notes-v2.ts` (new shapes/functions).
- **Create:** `notes-editor.css`; `CommandPalette.tsx`; the new TipTap nodes/extensions under
  `components/notes/` (table serializer module, `TagNode`, `Callout`, `block-transforms` module, bubble-menu
  + drag-handle wiring); search-overlay UI component(s) (may be folded into `CommandPalette`).
- **Frontend logging:** `import { log } from '@/utils/log'` — never raw `console.log`; full IDs, never
  truncated.

### 4.5 BE ownership (extend/create — all under `src/`)
- **Extend:** `web/routes/notes-v2.ts` (rewrite search/backlinks/list/move; add tags/index endpoints; stamp
  id on `PUT`), `core/memory-search.ts` (collapse `note_*` SOURCE_WEIGHTS → `note_vault`; the `note_archive`
  exclusion + resource down-weight change is a behavior change — surface it), `core/qmd-store.ts`
  (`getNotesStore()` → one whole-vault collection), `core/qmd-watcher.ts` (add a SECOND debounced consumer
  inside the existing `fs.watch` — do NOT add a second watcher).
- **Create:** `core/notes-index.ts` (the `notes-index.sqlite` store — `better-sqlite3`, WAL, schema +
  migrations, FTS5 external-content + the 3 triggers; pattern = `task-db.ts`/`memory-index.ts`),
  `core/notes-indexer.ts` (the reconciler: `parseFrontmatter`, link/tag extraction, per-path coalescing
  queue + single transaction, per-file QMD drive via `insertContent`/`insertDocument`/`updateDocument`/
  `deactivateDocument`, id back-write), `core/parse-frontmatter.ts` (tolerant js-yaml helper).
- **Reuse (do NOT reinvent):** `src/utils/file-lock.ts` (`withFileLock`), the `bus` `interest` set
  subscription pattern, `qmd-task-sync.ts` two-call upsert + hash-skip shape, `computeContentHash`.

### 4.6 If a shared/forbidden file MUST change
Make the **minimal additive change only** and report it LOUDLY in `sharedFileTouches`. Expected candidates to
watch: none required for the P0 path (router is already mounted; events already emitted). The most likely
pressure points are app-wide Cmd+K (App.tsx) and any new event name (event-types.ts) — avoid both; the
palette is NotesPage-scoped and reconcile rides the existing `NOTES_UPDATED` event.

---

## 5. WORK BREAKDOWN

### 5.1 Backend work items (`src/`)
- **B0 (day-one, no schema):** widen `getNotesStore()` to one whole-vault collection
  (`{ path: NOTES_DIR, pattern: '**/*.md', ignore: ['global-notes.md', '.*/**'] }`); collapse `note_*`
  weights → `note_vault`; in `GET /search` also call `memoryNotesSearch(q, ['note_vault'], …)` and naive-merge
  with the existing substring scan. **Surface the behavior change** (Archive flips from excluded→searched;
  resource/archive down-weight dropped). **Do NOT call `store.update()` on the save hot path.**
- **B1 (structural sidecar):** create `notes-index.sqlite` (schema §4.1 of tech: `notes`/`links`/`tags`/
  `notes_fts` external-content + 3 triggers + `index_meta`) + reconciler + the `fs.watch` catch-all second
  consumer (per-path coalescing queue, single `db.transaction()`). Rewrite `GET /search` string leg,
  `GET /backlinks`, `GET /list` to read the index. **O(n) scans gone.** Add `escapeFts` + capped `LIKE`
  fallback for mid-token substring.
- **B2 (identity — UNBLOCKS FE-E4/E5):** stamp `id` in frontmatter at create-time in `PUT /content`;
  reconciler fallback id-assignment for id-less files (guarded back-write); id-keyed link resolution +
  ambiguous/unresolved edges + name fallback; **delete `updateWikiLinksInAll`**; simplify `POST /move` to
  file-rename + one-row update. git-sync hazard mitigations (create-time stamp primary; pause `git add -A`
  while id pending; earliest-created-wins merge rule).
- **B3 (tags + frontmatter parse):** `tags` table fed by `frontmatter.tags[]` ∪ inline `#hashtags`;
  `GET /tags` (freq-ranked), `GET /tags/:tag/notes`, `POST /tags/rename` (targeted). Frontmatter PARSE only —
  **no properties-editing UI** (non-goal). Unblocks FE `#tag` autocomplete.
- **B4 (polish):** `GET /index/status`, `POST /index/rebuild`, atomic temp-DB rebuild (off-loop, bounded,
  chunked walk), one-time widen re-embed backgrounded + rate-limited with `embedProgress`, ranking/labeling
  tuning. `<mark>` snippet wrapping in search results.
- **Cross-cutting BE:** path-traversal guards on every new endpoint; `Promise.allSettled` graceful
  degradation; `withFileLock` on sidecar writes; ephemeral-server isolation (own `OPEN_WALNUT_HOME`).

### 5.2 Frontend work items (`web/src/`)
- **E0 (day-one):** swap `NOTE_SLASH_COMMANDS` (single `task` entry) → grouped block catalog
  (Basic/Lists/Blocks/Reference); extend `NoteSlashCommand` with `{ aliases, group, run }`; add `run`
  dispatch in `SlashCommandPortal` (keep Task-ref + Link-to-note sub-panels); fuzzy filter + group headers +
  scroll-active-into-view in `SlashCommandMenu`; trigger split by command class (block inserts only in
  empty/whitespace block; inline Reference entries still fire mid-sentence). One transaction per insert.
- **E1 (bubble + drag-handle + transforms):** wire `@tiptap/extension-bubble-menu` (already installed) and
  `@tiptap/extension-drag-handle-react`; build the shared `block-transforms` module (one path for slash +
  bubble + grip); **fold the existing Tab logic into ONE transaction** (one Tab = one Cmd+Z); gutter-room
  spike in BOTH surfaces (`/notes` + popup) with the defined fallback; non-drag reorder affordance for the
  narrow popup. Regression suite GREEN first (`isSourceRef`, `tryJoinPreviousListAndSink`,
  `detachListItemChildren`, ArrowUp, `TightTaskList`).
- **E2 (tables):** `@tiptap/extension-table` family; **OWNED GFM serializer** (§3.1) registered via the table
  node's `addStorage().markdown`; inline+hard-break cells, forced header, no merged cells; Tab/Shift+Tab nav,
  add/remove rows+cols; **frozen Tab-precedence** (table claims Tab only inside a table; list-Tab/ArrowUp
  untouched outside). Verify against round-trip corpus (no `<table>` HTML ever).
- **E3 (`#tag` + callout):** `TagNode` (clone `[[` trigger shape) + frequency autocomplete from `GET /tags`
  (manual typing works before B3); `Callout` node + frozen `> [!kind]` serializer/parser; viewer post-passes
  in `notes-markdown.ts`. Gated behind round-trip corpus + viewer-parity.
- **E4 (link authoring — depends on B2):** `[[` autocomplete inserts Obsidian-native `[[Title]]`, or
  `[[folder/Title]]` when disambiguating same-named notes; real `|alias` semantics; "Create new" inserts
  `[[Title]]` (BE assigns id on first save). NO id in link text.
- **E5 (frontmatter wrapper — depends on B2):** strip-on-load / reattach-on-save string wrapper in the
  editor's load/save path so the `id` line round-trips byte-for-byte and is unreachable by editing.
- **Cmd+K + search UI (P0):** `CommandPalette.tsx` mounted from `NotesPage` (§4.3): jump-to-note (fuzzy over
  `/list`, recents on empty), quick-capture (`↵` create typed title; `⌘↵` focused empty note, 0 decisions),
  hybrid search fronted in the same overlay (●/◐/○ glyph + word badge "exact match"/"related", matched-span
  highlight, exact-never-below-semantic), discard-guard on close-mid-capture, focus-restore. **`/notes`
  empty state** with a "New note" CTA + one-line hint (newcomer on-ramp). IME/CJK guard on `/`, `[[`, `#`
  trigger/open paths.
- **Cross-cutting FE:** import `notes-editor.css`; structured `log`; full IDs; virtualize `NotesTreePanel`.

---

## 6. INTEGRATION POINTS (where FE depends on BE) + the ONE hard cross-dependency

| Integration point | FE side | BE side | Coupling |
|---|---|---|---|
| **Note identity (HARD DEP)** | E4 link authoring + E5 frontmatter wrapper need a stable `id` that survives rename | B2 stamps `id` at create + id-keyed resolution + reconciler back-write | **The one hard cross-dependency.** FE-E4/E5 BLOCK on BE-B2. Both sides agree on the §2 identity contract + §3.5 link disk form. |
| Hybrid search payload | Cmd+K/search overlay renders `results[]` (matchType/score/snippet `<mark>`) | `GET /search` shape §1.2 #8 | Agree on the response shape + `<mark>` highlight + dedupe-by-id BEFORE FE renders. |
| Backlinks | `BacklinksPanel` renders id-keyed list + ambiguous candidates | `GET /backlinks` shape §1.2 #9 | Agree on `status`/`candidates`. |
| Tag autocomplete | `TagNode` autocomplete from freq-ranked tags | `GET /tags` shape §1.2 #11 | FE manual `#tag` works before B3; autocomplete wires when `/tags` lands. |
| `[[` autocomplete data | `WikiLinkAutocomplete` needs `id`+`title`+`path` per note | `GET /list` now returns `id` | FE path-form disambiguation uses `path`; id is for nothing in link text — purely so FE can show the right target. |
| External/AI write while editing | `useNoteContent.ts` WS handler | `PUT` + `NOTES_UPDATED` event (unchanged source format) | See §6.1 below — FE adds the dirty-guard; BE conflict policy is agent-wins, surfaced. |
| Index status / first-run honesty | "still indexing — semantic may be incomplete" banner | `GET /index/status.embedProgress` | FE polls/show during one-time widen re-embed. |

### 6.1 Write-write conflict + the missing dirty-guard (owner decision baked in)
- **Policy (FROZEN):** agent-writes-win on a TRUE write-write conflict (optimistic-lock 409). Loss bounded to
  one debounce window (~500 ms) and **SURFACED**, not silent.
- **FE must add the missing WS-path dirty-guard in `web/src/hooks/useNoteContent.ts`:** the `notes:updated`
  WS handler currently cancels the pending save and calls `reloadContent()` with NO dirty check (it blows the
  live doc away mid-edit). It MUST gain the same `if (dirtyRef.current) return;` defer-guard the
  visibility/focus path already has (line ~71), holding the incoming content and surfacing a non-destructive
  "note changed on disk — reload" affordance; apply automatically once idle+clean, or on user click.
- **On true 409:** before discarding, surface the conflict to the user (don't silent-reload).
- **When applying an external change to a CLEAN doc:** map the selection through the change (position
  mapping), NOT a full `setContent` + raw-offset restore. (Highest-risk item — spike early.)
- **Non-conflicting external writes never lose input** (they defer).

---

## 7. SEQUENCING

The two tracks ship **largely in parallel**. The only hard gate is **BE-B2 → FE-E4/E5**.

```
BE:  B0 ──▶ B1 ──▶ B2 ──▶ B3 ──▶ B4
            (O(n) scans gone)  └─ unblocks FE-E4/E5
FE:  E0 ──▶ E1 ──▶ E2 ──▶ E3 ──▶ E4 ──▶ E5
     (Notion feel)        └─ only new serialization   └─ depend on B2
     Cmd+K + search UI: build alongside E0/E1; hybrid results need B0 (works), full polish needs B1.
```

- **Day-one (independent):** BE-B0 (semantic search works) + FE-E0 (block menu) — the PRD "simplest first
  step", each ships before any sidecar or new block exists.
- **E0–E3 deliver a full Notion-style block editor with byte-clean round-trips regardless of backend
  progress.** B0–B1 deliver hybrid search + end of O(n) scans regardless of editor progress.
- **E4/E5 are the only FE items that wait on the backend (B2 identity).**
- **Cmd+K (P0):** the overlay can land with E0/E1; its search results improve as B0→B1 land; jump/capture/
  New-note do not depend on the backend beyond `GET /list` (already exists, gains `id`).
- **Gate before any new block lands (FE):** the hard-won-invariants regression suite + the byte-clean
  round-trip corpus must be GREEN; tables ship only after the corpus asserts no `<table>` HTML.

### 7.1 Joint acceptance gates (both pods)
- **Round-trip corpus** (tables incl. alignment/escaped-`\|`/inline-code-pipe/empty cells; `#tag` mid-
  sentence/line-end/adjacent-`C#`/in-link; callout soft vs hard break + blockquote-that-looks-like-callout;
  combos): `serialize(parse(md))===md` byte-for-byte AND node-level `parse(serialize(doc))` deep-equals; AND
  no `<table>` HTML. Run in CI before any new block.
- **Index == vault invariant**, **rename integrity** (id-keyed, 0 orphans, ambiguous case), **hybrid
  search** (exact 100% + never-below-semantic), **FTS edit-coherence** (stale-entry on UPDATE),
  **external/AI-write mid-edit** (defer-while-dirty + surfaced 409), **one action = one Cmd+Z**, **IME/CJK**,
  **latency** (string ≤300 ms, backlinks ≤150 ms). All E2E via `startServer({ port: 0, dev: true })`, mock
  only the Claude CLI / embeddings, real UI clicks (no `page.goto()`).

---

## 8. Reuse map (don't reinvent — patterns already in-repo)
- **Sidecar DB:** `src/core/task-db.ts`, `src/core/memory-index.ts` (`better-sqlite3`, WAL, migration on
  `schema_version`).
- **QMD per-file upsert + hash-skip:** `src/core/qmd-task-sync.ts:60-90` (`findActiveDocument` →
  `insertContent(hash, content, createdAt)` → `insertDocument`/`updateDocument`; embed incremental).
- **Watcher debounce:** `src/core/qmd-watcher.ts` (add a second consumer, not a second watcher).
- **Cross-process locks:** `src/utils/file-lock.ts` (`withFileLock`/`withFileLockSync`).
- **Event bus `interest` set:** subscribe to `NOTES_UPDATED` filtered (the mechanism that fixed event-loop
  starvation) — `src/core/event-bus.ts` (read-only; do NOT modify).
- **Hybrid blend precedent:** `src/core/search.ts` + `src/core/memory-search.ts` (`memoryNotesSearch`,
  `Promise.allSettled`, `degraded` fallback).
- **FE trigger/portal pattern:** `slash-commands/SlashCommandExtension.ts` + `wiki-link/WikiLinkExtension.ts`
  are the proven detect→range→autocomplete shape; the `#tag` node is the third instance — clone, don't
  invent.
