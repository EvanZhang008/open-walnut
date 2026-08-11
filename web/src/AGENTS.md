# Web GUI — Quick Reference

**Full implementation details: `.claude/skills/walnut-web-frontend/SKILL.md`** (single-timeline
model, optimistic dedup, UX patterns, file structure). **Load that skill BEFORE touching session
chat, turn boundaries, or streaming block rendering** — that area has an incident history.

**Task/session search:** read
[`docs/investigation/qmd-search-performance/README.md`](../../docs/investigation/qmd-search-performance/README.md) before
changing search requests, provisional results, stale-response handling, or result merging.

## Invariants you must not break (even without reading the skill)

- **Streaming blocks are APPEND-ONLY.** No event handler deletes blocks. Absorption is a
  render-time filter (`web/src/stream/render-filter.ts`), never a mutation. A missed match may
  render a block twice briefly; it must never vanish.
- Frontend accumulation semantics live in ONE place: `web/src/stream/stream-reducer.ts` (pure
  functions). The server buffer (`src/web/session-stream-buffer.ts`) is its only twin — keep
  them semantically aligned when touching either.
- Optimistic bubble dedup is two-tier (`optimistic-dedup.ts`): non-committed messages only dedup
  against history since the turn watermark; committed against all. Id-first
  (`walnutMessageId`), then count-based multiset text matching.
- Sessions render in ONE surface — the home session columns (`SessionPanel.tsx`). The dedicated
  `/sessions` page was removed; `/sessions?id=…` deep links reroute to the home columns
  (`SessionsRedirect` in `App.tsx` + `utils/open-session.ts`).
- Use the structured logger `import { log } from '@/utils/log'` — never raw `console.log`;
  never `console.debug` (invisible to the disk forwarder). IDs full, never truncated.

## Files panel — editing & quoting (`components/common/FileContentView.tsx`)

- **Editable files render an EDITOR as their default view — there is NO Edit button.** Markdown on
  the Preview tab = the Notes WYSIWYG editor (`FileMarkdownEditor`, edit the rendered doc like
  /notes); the Source tab and every plain code file = CodeMirror (`FileSourceEditor`). Read-only
  views survive only where editing is impossible (truncated/binary/raw kinds, HTML's iframe
  preview, MDX preview). Editors must NOT auto-focus — they also mount in the "@" mention preview,
  where stealing focus yanks the caret out of the chat input.
- **Preview⇄Source carries the unsaved buffer.** The tabs are two representations of one file, so
  `switchTab` captures the live editor's `getValue()` into `draftRef` (+ sticky `draftDirty`) and
  the next editor seeds from the draft. Losing the buffer on a tab click was the old Edit-mode
  behavior and is a regression.
- **A file save is EXPLICIT, never auto-save.** An agent may be writing the same repo in the same
  second, so the editor holds an optimistic lock: the read's `contentHash` goes back as
  `expectedHash` on `PUT /api/file-content`, and a mismatch is a `409` the user resolves. Do not
  add debounced auto-save here — that is correct for a Notes vault (one writer) and wrong for a
  working tree.
- **Editability is decided by the ABSENCE of `contentHash`, not by a FE guess.** The server omits
  it for truncated and binary reads, so `canEdit` keys off that one signal — a FE-side size/type
  rule would drift from the server's own refusal.
- **Neither a conflict NOR a save may remount the editor.** Both editors are seed-once and keyed
  on `path + baseHash + seedNonce`, where `baseHash` advances only on a fresh READ (and
  `seedNonce` on Discard). The save-time lock token lives in `lockHashRef` and the conflict token
  in `conflictHashRef` — both deliberately refs, outside the key. Putting either into the key wiped the unsaved buffer (conflict case) or yanked
  the caret to line 1 on every ⌘S (save case). After a save, `markClean()` re-baselines
  dirty-tracking in place.
- **Markdown edits WYSIWYG from the Preview tab** (`FileMarkdownEditor` wraps the Notes TipTap
  `NotesEditor`; Source tab / other files stay on CodeMirror). Frontmatter is split off before the
  editor and re-prepended verbatim on save (same `splitFrontmatter`/`joinFrontmatter` as Notes) —
  `getValue()` returns FULL file bytes. Dirty is armed by serialize-and-compare while clean:
  TipTap fires mount-time normalization updates that are not user edits, and tiptap-markdown does
  not round-trip byte-clean, so a naive "any onDirty = dirty" lit Save before any keystroke. MDX
  is excluded (JSX blocks would not survive the round-trip).
- **`.file-content-view` is a plain block, so a `flex:1` child collapses to ZERO height.** Editing
  state opts into a flex column via `:has(> .fv-source-editor)`, and every chrome row in it is
  pinned `flex: 0 0 auto`. Both rules are load-bearing: without them the editor rendered blank
  (text in the DOM, no height) the moment a save-error banner joined the column. Never build a
  banner on `.file-viewer-error` — that class is the whole-pane empty state (`height:100%`) and
  grew to swallow the editor.
- **Quote-to-ask is the SAME composer as the Changed tab** (`buildSelectionPrefill`), fed by three
  sources: read-only views via the DOM mouseup walk; CodeMirror via its `onSelectText` callback
  (line number from the CM doc — the DOM `data-line` walk can't see into CM); the WYSIWYG editor
  via the bubble menu's "Ask" button (`onAskSelection`, file-level reference — a rendered doc has
  no line numbers). The Files tab passes absolute paths, so shorten them with
  `displayPathForPrefill(path, cwd)` — otherwise a quote is headed by a 90-char path for a file
  the agent calls `src/x.ts`. Paths outside the cwd stay absolute on purpose.
- The selection pill's `onMouseUp` **must** `stopPropagation` — otherwise it bubbles to the
  container's own handler, which recomputes the collapsing selection and unmounts the pill before
  `click` fires (same trap as `SessionDiffView`).

## Menus & overlays — hard rules (every one is a shipped incident)

- **A menu must NEVER overflow the viewport.** Every `position:fixed` dropdown is placed by
  `useMenuPlacement` (measure real height → flip up/down → clamp to edges → `maxHeight` +
  `overflow-y:auto`). Never hand-roll placement math, never guess a height constant.
  Geometric regression suite: `tests/e2e/browser/kebab-menu-viewport-fit.spec.ts`.
- **Unbounded content never inlines into a menu.** If a section can grow after open (project
  list, async rows), render it as its OWN portalled flyout placed by the same hook
  (`MoveToProjectSection` is the model). A menu's height must not change because the user
  interacted with it — inline growth is exactly how the Project picker overflowed.
- **No native form controls inside styled menus.** A native `<select>` looks foreign AND its
  macOS popup swallows the pointerup, so dnd-kit saw a held pointer and DRAGGED the row after
  the pick. Build custom option rows.
- **Portals escape clipping/stacking, not event bubbling.** Portal menus to `<body>` for
  z-index, but React synthetic events still bubble through the component tree into the
  sortable row's drag sensors — every menu portal needs
  `onPointerDown={(e) => e.stopPropagation()}`.
- **Outside-click/scroll closers must exempt child portals.** A flyout portalled to `<body>`
  is not inside `menuRef`, so naive "outside" checks close the parent when the user clicks
  its own submenu. Check `.closest('.task-kebab-project-flyout')` (and future flyout classes)
  before dismissing.
- **Right-click opens the SAME kebab menu at the cursor** — task rows are app objects, not
  documents. One menu definition for both paths; never fork a separate context menu.
- **Action rows are defined once.** The per-task kebab, the batch "More" dropdown, and the
  session-panel kebab share `TaskActionMenuItems` / `MoveToProjectSection`. Add an action in
  one place and every surface gets it; parallel copies drift.
