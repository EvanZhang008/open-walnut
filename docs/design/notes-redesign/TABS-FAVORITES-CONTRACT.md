# Notes: Multi-Tab Editing (#6) + Note Favorites (#5) — BUILD CONTRACT

> **Role:** Cross-pod contract for the two Obsidian-parity features the owner asked for. Backend (BE) owns the
> favorites `notes` dimension; Frontend (FE) owns the tab strip, tab state, and the bookmarks-in-tree UX. This
> doc is the single source of truth so neither side guesses the other's interface.
>
> **Reuse mandate (non-negotiable):** REUSE the existing favorites system (`src/web/routes/favorites.ts` +
> `web/src/api/favorites.ts` + `web/src/hooks/useFavorites.ts`). Do NOT build a parallel one. The Notion-class
> editor (TipTap, slash blocks, tables, tags, callouts, bubble menu, drag-reorder, `![[embed]]`, hybrid search,
> Cmd+K, id-keyed links) is already shipped — these two features are additive.
>
> **Repo rule:** PUBLIC open-source. All code/comments/text ENGLISH; no internal names/employer/usernames. No
> `console.log` (use `import { log } from '@/utils/log'`). Files < ~500 LOC. Match surrounding style.
>
> **Hard constraint — do not regress the just-fixed persistence:** every doc mutation goes through
> `editor.chain()/commands` (never raw `view.dispatch`); no `externalUpdateRef` resurrection / hook-level
> sticky external-flag. `useNoteContent` is the ONLY save path — tabs must not introduce a second one.

---

## 0. The contract in one screen

- **One `useNoteContent`, driven by the ACTIVE tab.** The tab model lives entirely in `NotesPage.tsx`. The
  active tab's `path` is fed to the *existing* single `useNoteContent(activePath)`. Switching tabs = changing
  that prop = the hook's existing load-effect flush (`useNoteContent.ts:184-193`) fires the outgoing note's
  pending save. **No per-tab hook instances. No new save path.** This is what guarantees we don't drop the
  drag/typing persistence fix.
- **Tabs persist** to `localStorage` under `open-walnut-notes-tabs` (mirrors the existing
  `open-walnut-notes-tree-width` pattern) so the workspace restores across reload.
- **`?path=` stays in sync with the active tab** (replace, not push — same as today).
- **Favorites gains a `notes` dimension** the same way categories/projects work: `GET /api/favorites` returns
  `notes: string[]`; `POST /api/favorites/notes` `{path}` add; `DELETE /api/favorites/notes` `{path}` remove;
  each emits `CONFIG_CHANGED { key: 'favorites' }`. One additive type change in `src/core/types.ts`.
- **Bookmarks render as a collapsible "Bookmarks" group at the TOP of the notes tree** (matches Obsidian's
  left-sidebar Bookmarks). A bookmark toggle lives in the editor title bar. Clicking a bookmark opens it (in
  the active tab, per the standard open rule).
- **The ONE cross-pod dependency:** FE consumes the BE `notes` field on `GET /api/favorites`. Everything else
  ships in parallel.

---

## 1. #6 — Multi-tab editing (FE-owned, stateful refactor of `NotesPage.tsx`)

### 1.1 The open-tabs state model (shape + where it lives)

All tab state lives in **`web/src/pages/NotesPage.tsx`** (no new context, no store). It replaces today's
`selectedPath` + `attachmentPath` pair with an ordered tab list + an active-tab pointer.

```ts
// In NotesPage.tsx
type TabKind = 'note' | 'attachment';

interface OpenTab {
  /** Vault-relative path WITH .md for notes (e.g. "PARA/foo.md"); attachment path for attachments. */
  path: string;
  /** 'note' → markdown editor (useNoteContent); 'attachment' → AttachmentPreview. Decided at open time. */
  kind: TabKind;
}

const [tabs, setTabs] = useState<OpenTab[]>(/* hydrate from localStorage — see §1.4 */);
const [activePath, setActivePath] = useState<string | null>(/* hydrate; falls back to first tab or ?path= */);
```

**Identity / dedupe key = `path`.** A note is "already open" iff some `tabs[i].path === path`. A note and an
attachment never collide because attachment paths are not `.md`. `path` (not array index) keys React rows so
reordering/closing never mis-renders.

**Derived, not stored:**
- `activeTab = tabs.find(t => t.path === activePath) ?? null`
- The title shown on a tab = basename of `path` without `.md` (reuse `NotesEditorPanel`'s `displayName`
  derivation: `path.replace(/\.md$/, '').split('/').pop()`). Do NOT fetch titles per tab — keep it cheap; the
  basename is the Obsidian-style tab label.

**Why no per-tab content state:** content/dirty/save all stay inside the single `useNoteContent(activePath)`.
Tabs are just *which paths are open* + *which one is active*. Inactive tabs hold no live editor — switching to
one re-loads it (cheap; the editor is keyed by path and remounts, exactly as a note-switch does today).

### 1.2 Active tab → `useNoteContent` + `?path=` wiring

Today: `useNoteContent(selectedPath)`. After: drive it with the active **note** tab's path.

```ts
// activePath is null when no tabs, or when the active tab is an attachment.
const activeNotePath = activeTab?.kind === 'note' ? activeTab.path : null;
const { content, loading, updatedAt, saveStatus, onEditorUpdate,
        pendingExternal, applyExternalChange, dismissExternalChange } = useNoteContent(activeNotePath);
```

- When the active tab is an **attachment**, `activeNotePath` is `null` → `useNoteContent` clears (its existing
  `if (!notePath)` branch) and the editor pane renders `<AttachmentPreview notePath={activeTab.path} />`
  instead. This reuses today's attachment-preview behavior verbatim — attachments simply live in a tab now.
- **URL sync (active tab → `?path=`):** an effect mirrors the active tab into the URL, exactly as
  `handleSelect` does today (`setSearchParams({ path }, { replace: true })` for notes;
  `{ attachment: path }` for attachments; `{}` when no tabs). Use `replace`, never push — we are not adding
  browser history entries per tab switch (matches current behavior; avoids back-button surprises).
- **URL → initial tab (deep link):** on first mount, if `?path=` / `?attachment=` is present and the tree has
  loaded, open it as the sole tab and make it active (see §1.4 hydration order). This preserves the existing
  deep-link / pop-out (`openPopout('note', { path })`) entry points unchanged.

### 1.3 Open / activate / close / already-open semantics

| Action | Trigger | Behavior |
|---|---|---|
| **Open (replace active)** | Single-click a note/attachment in the tree | If already open in a tab → **activate** that tab (no duplicate). Else, **replace the active tab's path** in place (Obsidian default: single-click reuses the current tab). If there is no active tab, open a new one. |
| **Open in NEW tab** | ⌘-click (metaKey) a tree row, OR context-menu "Open in new tab", OR Cmd+K jump-to-note | If already open → activate it. Else append a new tab after the active one and activate it. |
| **Activate** | Click a tab in the strip | Set `activePath = tab.path`. (Outgoing note's pending save flushes via the hook prop-change — §1.5.) |
| **Close** | Click the tab's × (or middle-click, optional) | Remove that tab. If it was active: activate the **right neighbor**, else the left neighbor; if it was the last tab → `activePath = null` (empty state). Closing a non-active tab leaves the active one untouched. |
| **New / empty** | '+' button on the strip | Opens the empty state (no path) and surfaces Cmd+K (the existing quick-switcher/quick-capture). Implementation: append a transient "empty" affordance OR simply clear `activePath` to show `NotesEmptyState` + open the palette. Pick whichever keeps NotesPage < 500 LOC; the visible contract is "+ gives me a fresh place to pick/create a note". A brand-new note created via quick-capture opens per the standard open rule (replace active / new tab). |

**Default open rule for ALL programmatic opens** (tree single-click, Cmd+K, bookmark click, create, rename
follow, pop-out return) funnels through ONE helper:

```ts
// Single source of truth for opening — keeps semantics identical everywhere.
function openInTab(path: string, kind: TabKind, opts?: { newTab?: boolean }): void
```

- If `path` already open → activate it (ignore `newTab`).
- Else if `opts.newTab` → insert after active + activate.
- Else → replace active tab's `{path, kind}` in place (or create the first tab).
- Always call `pushRecent(path)` for note opens (feeds Cmd+K recents, as `handleSelect` does today).

This replaces today's `handleSelect` / `handlePreviewAttachment` bodies (they become thin wrappers:
`handleSelect = (p) => openInTab(p, 'note')`, `handlePreviewAttachment = (p) => openInTab(p, 'attachment')`)
so `NotesTreePanel`, `CommandPalette`, `BacklinksPanel`, wiki-link clicks, and pop-out keep their existing
`onSelect`/`onNavigate` props unchanged. ⌘-click / "Open in new tab" pass `{ newTab: true }`.

### 1.4 Persistence (localStorage) + hydration order

```ts
const LS_TABS_KEY = 'open-walnut-notes-tabs';   // sibling of LS_WIDTH_KEY = 'open-walnut-notes-tree-width'

interface PersistedTabs { tabs: OpenTab[]; activePath: string | null; }
```

- **Write:** an effect persists `{ tabs, activePath }` whenever either changes (same shape as the width
  effect at `NotesPage.tsx:86-88`). Wrap in `try/catch` (quota/disabled storage), like `readWidth`.
- **Read (hydrate):** lazy initializer parses `LS_TABS_KEY`; validate it's an array of `{path,kind}` and drop
  malformed entries (defensive — mirrors `readRecents` filtering). 
- **Hydration precedence on first mount** (deterministic — resolve in this order, first match wins):
  1. A `?path=` / `?attachment=` URL param (deep link / pop-out) → that becomes the sole active tab. (Deep
     links win so a shared/bookmarked URL always lands on the intended note even if localStorage has tabs.)
  2. Else persisted `{tabs, activePath}` from `LS_TABS_KEY` → restore the workspace; if `activePath` is not in
     `tabs`, fall back to `tabs[0]?.path ?? null`.
  3. Else empty (no tabs → `NotesEmptyState`).
- The existing "auto-select from URL once tree loads" effect (`NotesPage.tsx:176-186`) is replaced by this
  precedence logic but keeps the same guard (wait for `tree.length > 0` before opening, so a path that no
  longer exists can be reconciled — see §1.6).

### 1.5 Tab switch MUST flush the outgoing note's pending save (no regression)

This is the critical correctness requirement. The mechanism is **already built** — we must not bypass it.

- `useNoteContent` is keyed on its `notePath` arg. Its load-effect (`useNoteContent.ts:154-230`) captures
  `prevPath`, and **before** loading the new note it flushes a pending save for the old note
  (`useNoteContent.ts:184-193`): it cancels the debounce timer and fires `saveNoteContent(prevPath, …)`
  synchronously with the preserved frontmatter + content hash.
- Therefore: **switching the active tab = changing `activeNotePath` = the hook flushes the outgoing note for
  free.** No new flush code in NotesPage. Do NOT add a separate save-on-switch in the tab handler — that would
  be a *second* save path and risks the double-write / lost-edit class of bug we just fixed.
- **Closing the active tab** also changes `activeNotePath` (to the neighbor or `null`), so the same hook flush
  covers close. Closing the *last* tab sets `activeNotePath = null` → the hook's `!notePath` branch runs after
  flushing (its load-effect still captures `prevPath` and flushes first).
- **Switching to/within attachment tabs:** `activeNotePath` goes `null`, so any dirty note flushes via the
  same path before the editor unmounts. Switching back re-loads from disk (converged).
- **Unmount safety net:** the hook's unmount flush (`useNoteContent.ts:330-353`) still covers full-page
  navigation away from `/notes`. Persisted tabs restore on return; the just-flushed note re-loads clean.

**Invariant FE must preserve:** there is exactly one `useNoteContent` instance on the page at all times, and
the only thing that changes is the `notePath` argument. If a future refactor wants per-tab live editors, it
must re-prove this flush story — flag it loudly; it is out of scope here.

### 1.6 Edge cases (FE)

- **Deleted note that is open in a tab:** on delete (`handleDeleteNote`), remove every tab whose `path` equals
  the deleted path; if it was active, activate a neighbor / empty (same neighbor rule as close). Today's code
  already clears `selectedPath` on delete — extend it to the tab list.
- **Renamed/moved note open in a tab:** on rename (`handleRenameNote`), rewrite the matching tab's `path` from
  → to (preserve its position + active state). Today's code re-selects on rename — extend it to update the tab
  in place so the flush-on-switch isn't triggered spuriously.
- **Stale persisted tab (path no longer in vault):** keep it in the strip but let the editor show the existing
  "Failed to load note" empty state (`NotesEditorPanel` already renders this when `content === null`). Do NOT
  auto-purge on load (a transient fetch error shouldn't nuke the workspace); the user closes it. Optional: a
  one-time reconcile against the loaded tree may drop tabs whose path is absent — if done, gate on
  `tree.length > 0` and only drop exact-miss paths.
- **Tab overflow:** the strip scrolls horizontally (CSS `overflow-x: auto`); no truncation of the list. Active
  tab `scrollIntoView({ inline: 'nearest' })` on activate so it's always visible.
- **Pop-out window:** `openPopout('note', { path })` is unchanged — it opens a separate window for the active
  note, independent of the tab strip. The "+ open in new window" button stays (it is overlaid in NotesPage and
  reads the active note path).

### 1.7 New component (FE)

`web/src/components/notes/NotesTabStrip.tsx` (new, notes-owned). Renders the horizontal strip ABOVE the editor
pane, inside `.notes-editor-pane` (NOT in the tree). Props:

```ts
interface NotesTabStripProps {
  tabs: OpenTab[];
  activePath: string | null;
  onActivate: (path: string) => void;
  onClose: (path: string) => void;
  onNewTab: () => void;       // the '+' button
}
```

Each tab: title (basename) + × button (`stopPropagation` so × doesn't also activate). `+` at the end. Active
tab gets an `.active` class. Styling → `web/src/components/notes/notes-editor.css` (or a new
`notes-tabs.css` sibling). **NEVER** `globals.css`.

---

## 2. #5 — Note favorites (BE-owned dimension + FE bookmark UX)

### 2.1 Config type change (BE — the single additive shared-file touch)

`src/core/types.ts:225` — extend the existing `favorites` block with `notes`:

```ts
favorites?: {
  categories?: string[];
  projects?: string[];
  notes?: string[];   // NEW: vault-relative note paths (WITH .md), e.g. "PARA/foo.md"
};
```

Additive + optional → backward compatible. **Flag in `sharedFileTouches`** (only the `notes?` line is added).

### 2.2 Favorites API surface (BE — mirror existing handlers EXACTLY)

`src/web/routes/favorites.ts`. The category/project handlers carry the name in the URL **param**
(`/categories/:name`). Note paths contain slashes and `.md`, so encoding them as a path param is fragile —
**use the request BODY** for notes (the build brief specifies `body {path}`). This is the only stylistic
divergence and it's the right one for slash-bearing paths.

| Method & path | Body | Returns | Emits |
|---|---|---|---|
| `GET /api/favorites` (extend) | — | `{ categories, projects, notes }` | — |
| `POST /api/favorites/notes` (new) | `{ path: string }` | `{ notes: string[] }` | `CONFIG_CHANGED { key: 'favorites' }` |
| `DELETE /api/favorites/notes` (new) | `{ path: string }` | `{ notes: string[] }` | `CONFIG_CHANGED { key: 'favorites' }` |

Implementation rules (match `favorites.ts` line-for-line):
- `GET /`: add `notes: config.favorites?.notes ?? []` to the existing response object.
- `POST /notes`: read `req.body.path` (string; 400 if missing/non-string). `if (!config.favorites) config.favorites = {}`;
  `if (!config.favorites.notes) config.favorites.notes = []`; push iff not already present (idempotent add,
  same as categories). `await updateConfig({ favorites: config.favorites })`. Emit
  `bus.emit(EventNames.CONFIG_CHANGED, { key: 'favorites' }, ['web-ui'])`. Respond `{ notes: config.favorites.notes }`.
- `DELETE /notes`: read `req.body.path`. Filter it out (`(config.favorites.notes ?? []).filter(p => p !== path)`),
  `updateConfig`, emit the same event, respond `{ notes: ... }`. (Accept the path via body; if a query-string
  variant is trivial it may also be honored, but body is the contract — keep one path to avoid drift.)
- No path normalization beyond trusting the FE to send the canonical vault path WITH `.md` (the same string the
  tree/editor use as `notePath`). Do not strip `.md`; store paths verbatim so toggle/compare is exact-string.

### 2.3 Frontend favorites client (FE — extend the existing file)

`web/src/api/favorites.ts` — **extend, do not create a parallel client.** Add:

```ts
export interface Favorites {
  categories: string[];
  projects: string[];
  notes: string[];           // NEW
}

export async function addFavoriteNote(path: string): Promise<void> {
  await apiPost('/api/favorites/notes', { path });          // body, not URL param
}
export async function removeFavoriteNote(path: string): Promise<void> {
  await apiDelete('/api/favorites/notes', { path });        // body
}
```

> FE note: confirm `apiDelete` forwards a JSON body (the category/project deletes use URL params, so this is
> the first body-bearing delete). If `apiDelete` in `web/src/api/client.ts` does not support a body, either
> add a body-capable overload there (client.ts is FE-owned, allowed) OR send the path as a query string and
> have BE additionally read `req.query.path`. Decide at implementation; the wire contract above (body) is
> preferred. Flag whichever you pick.

### 2.4 Frontend favorites hook (FE — extend the existing hook)

`web/src/hooks/useFavorites.ts` — add a `notes` dimension symmetric to categories/projects:

- State: `favoriteNotes: string[]`.
- `fetchAll` also sets `setFavoriteNotes(data.notes)`.
- `toggleFavoriteNote(path)`: optimistic add/remove + call `addFavoriteNote`/`removeFavoriteNote` (mirror
  `toggleFavoriteCategory`).
- `isNoteFavorite(path) => favoriteNotes.includes(path)`.
- `hasFavorites` also considers `favoriteNotes.length`.
- The existing `useEvent('config:changed', …)` re-sync already covers notes (it refetches on any
  `key === 'favorites'`), so cross-tab/agent toggles converge with zero extra wiring.
- Keep the `useMemo` return stable (add the three new members to the deps array).

> Reuse caveat: `useFavorites` is currently consumed by `MainPage.tsx`/`TodoPanel.tsx` (forbidden to touch for
> tabs, but `useFavorites.ts` itself is FE-shared and additive changes are safe — adding optional members does
> not change existing consumers). Verify `MainPage` still typechecks (it only reads category/project members).

### 2.5 Bookmark toggle in the editor title bar (FE)

`web/src/components/notes/NotesEditorPanel.tsx` title row (`.notes-editor-meta`, next to the save status).

- Add a bookmark button: filled glyph when `isNoteFavorite(notePath)`, outline otherwise. Click →
  `toggleFavoriteNote(notePath)`.
- `NotesEditorPanel` must receive `isFavorite: boolean` + `onToggleFavorite: () => void` as new props (it is
  presentational and should not import the hook directly — NotesPage owns `useFavorites` and passes them down),
  keeping data flow one-directional and the panel testable. (If the brief's "there may already be a bookmark
  glyph" turns out true, wire the existing glyph instead of adding one.)
- Disabled/hidden when `notePath` is null or for attachment tabs (favoriting attachments is out of scope).

### 2.6 Bookmarks group at the top of the tree (FE)

`web/src/components/notes/NotesTreePanel.tsx` — add a collapsible **"Bookmarks"** section rendered ABOVE the
file tree body (above the `tree.map(...)`), hidden when there are no favorited notes.

- New props: `favoriteNotes: string[]`, `onToggleFavorite: (path: string) => void` (for an inline un-bookmark
  affordance / context-menu, optional), and it reuses the existing `onSelect` to open.
- Each bookmark row: bookmark glyph + basename (no `.md`); click → `onSelect(path)` (which funnels through
  `openInTab` → opens in active tab per §1.3). Right-click / hover-× to remove from favorites (calls
  `onToggleFavorite`).
- Collapsible like a folder (reuse the chevron + `expandedFolders` idiom, or a dedicated `bookmarksExpanded`
  boolean persisted to localStorage if desired — optional, keep it simple).
- Optional polish: show a filled bookmark on the matching file row in the main tree so state is consistent in
  both places. Not required for v1.

---

## 3. Non-overlapping file ownership (STRICT — concurrent sessions)

### 3.1 BACKEND pod owns (favorites dimension only)

| File | Change |
|---|---|
| `src/web/routes/favorites.ts` | Extend `GET /`; add `POST /notes` + `DELETE /notes`. The reuse target. |
| `src/core/types.ts` | Add `favorites.notes?: string[]` (ONE line). **shared-file touch — flag it.** |

BE writes NOTHING in `web/`. BE does not touch `notes-v2.ts` (favorites is config, not vault).

### 3.2 FRONTEND pod owns (tabs + bookmark UX)

| File | Change |
|---|---|
| `web/src/pages/NotesPage.tsx` | Tab state model, `openInTab` helper, persistence, URL sync, wire `useFavorites`. |
| `web/src/components/notes/NotesTabStrip.tsx` | **NEW** — the tab strip component. |
| `web/src/components/notes/NotesEditorPanel.tsx` | Add bookmark toggle in title bar (new props). |
| `web/src/components/notes/NotesTreePanel.tsx` | Add Bookmarks group at top + "Open in new tab" context item + ⌘-click. |
| `web/src/api/favorites.ts` | Add `notes` to `Favorites`; `addFavoriteNote` / `removeFavoriteNote`. |
| `web/src/hooks/useFavorites.ts` | Add `favoriteNotes` / `toggleFavoriteNote` / `isNoteFavorite`. |
| `web/src/components/notes/notes-editor.css` (or new `notes-tabs.css` sibling) | Tab strip + bookmark + bookmarks-group styles. **NEVER globals.css.** |
| `web/src/api/client.ts` | ONLY IF `apiDelete` needs a body-capable overload (§2.3). FE-owned, allowed. |

FE writes NOTHING in `src/`. FE does NOT touch the editor save/dirty internals
(`web/src/hooks/useNoteContent.ts` is reused **as-is** — drive it with the active path, never edit it).

### 3.3 DO NOT TOUCH (hands off — other sessions / persistence-fix surface)

`web/src/utils/markdown.ts`, `web/src/styles/globals.css`, `web/src/components/common/FileContentView.tsx`,
`src/web/routes/local-image.ts`, ROOT `package.json`, `src/core/event-bus.ts`, `src/core/event-types.ts`,
`src/web/server.ts`, `src/web/ws/handler.ts`, `src/providers/*`, `src/core/session-*`,
`web/src/hooks/useChat.ts`, `web/src/pages/MainPage.tsx`, `web/src/api/ws.ts`,
**`web/src/hooks/useNoteContent.ts` (reuse only, no edits)**, `web/src/components/notes/NotesEditor.tsx`
(the TipTap mutation surface — the persistence fix lives here; do not touch).

`CONFIG_CHANGED` / `config:changed` already exist in the (untouchable) event files — BE only *emits* the
existing event; it does not modify the event definitions.

---

## 4. Build sequencing

1. **BE-1 (parallel):** `types.ts` `notes?` field + `favorites.ts` `GET` extend + `POST/DELETE /notes`. Unit
   test the three handlers (add → GET shows it → DELETE removes it; idempotent add). No FE dependency.
2. **FE-1 (parallel):** favorites client + hook extension (`favorites.ts`, `useFavorites.ts`) — compiles
   against the agreed wire shape even before BE lands (mock in test).
3. **FE-2:** `NotesTabStrip.tsx` + the `NotesPage.tsx` tab-state refactor (state model, `openInTab`,
   persistence, URL sync, flush-via-prop-change). This is the bulk of the work; land it behind the existing
   tree/editor so nothing else changes.
4. **FE-3:** bookmark toggle in `NotesEditorPanel` + Bookmarks group in `NotesTreePanel`, wired to the hook
   from FE-1.
5. **Verify on 3456** against the real vault (~2200 notes, PARA): open several tabs, switch (confirm no lost
   edits — type in tab A, switch to B, switch back, edit persisted), close (neighbor activation), reload
   (workspace restores), ⌘-click + Cmd+K open-in-new-tab, deep-link `?path=`, bookmark toggle reflects in
   title bar + tree group, un-bookmark, cross-reload bookmark persistence. Deploy via `npm run dev:prod`
   (sanctioned), never `kill -9`. Real UI clicks in Playwright (no `page.goto` between SPA routes; element ref
   param = `target`).

---

## 5. Open decisions (resolved here so neither pod blocks)

- **Single-click default = replace active tab** (Obsidian default), **already-open = activate** (no dupe),
  **new tab = ⌘-click / context-menu / Cmd+K**. (§1.3)
- **Tabs persistence key = `open-walnut-notes-tabs`**, shape `{ tabs: OpenTab[]; activePath: string | null }`.
  (§1.4)
- **Deep-link URL beats persisted tabs** on first mount. (§1.4)
- **Note-favorite path is stored WITH `.md`, verbatim** (exact-string toggle/compare). (§2.2)
- **`POST/DELETE /api/favorites/notes` use the request BODY** (`{path}`), unlike category/project URL params,
  because paths contain slashes. (§2.2)
- **Bookmarks UI = collapsible group at TOP of the tree** (not a toolbar dropdown). (§2.6)
- **One `useNoteContent` driven by active path; tab switch flushes via the existing prop-change load-effect.**
  No second save path. (§1.5)
