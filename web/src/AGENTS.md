# Web GUI — Quick Reference

**Full implementation details: `.claude/skills/walnut-web-frontend/SKILL.md`** (single-timeline
model, optimistic dedup, UX patterns, file structure). **Load that skill BEFORE touching session
chat, turn boundaries, or streaming block rendering** — that area has an incident history.

**Task/session search:** the backend is the hybrid index
([`src/lib/hybrid-search/README.md`](../../src/lib/hybrid-search/README.md)). Read
[`docs/investigation/qmd-search-performance/README.md`](../../docs/investigation/qmd-search-performance/README.md)
(historical, names the removed engine) before changing search requests, provisional results,
stale-response handling, or result merging: the search races and merge rules it documents are
still live on the client.

**Task and session status:** read [Task/session status decisions](../../docs/decision/task-session-status.md) before changing red rows, read markers, Waiting badges, or connection hydration. Task commits and session status have separate authority.

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
- Sessions render in TWO home surfaces: the session columns (`SessionPanel.tsx`) and the chat
  slot. The dedicated `/sessions` page was removed; `/sessions?id=…` deep links reroute to the
  home columns (`SessionsRedirect` in `App.tsx` + `utils/open-session.ts`). The chat spot is
  `AskWalnutSlot`, which hosts an embedded `SessionPanel` for the selected ask, and a
  `DraftSessionPanel` in its New state. The embedded panel keeps every window control a column
  has (×, popout, fullscreen, locate; its × hides the slot), minus lock. The slot's only
  addition is the ≡ button leading the header's TITLE row (both panels take it as
  `headerLeading`; the title row because it ellipsizes, whereas the chips row wraps and pushed
  the time-ago to a second line in a narrow slot); it opens `AskWalnutDrawer`, an in-slot
  overlay (never a portal: the slot clips itself) with a search box, the asks and `New chat`.
  The drawer's title is the agent switcher (an inline accordion, not a portal): one list of
  asks PER console agent (`selectAgentTasks` / `isAskOf`: `walnut_agent` + the task's
  `agent_id` stamp, no stamp = Walnut, OR the agent's `Ask <name>` project), the slot's draft
  carries `draft.agent` so `DraftSessionPanel` names it ("Ask Mentor", the agent's description
  in place of the Walnut seeds), and the launch payload carries `agentId`. The search input's
  own chrome is flattened in BOTH rest and `:focus` (globals' `input:focus` ring outranks a bare
  class and painted a second frame inside the wrapper).
  Never put `contain: paint` on the slot's session wrapper: it makes the wrapper the containing
  block for the panel's `position: fixed` fullscreen overlay, which then "expands" inside the
  slot. So scope every Playwright locator for `.session-panel`
  or `.draft-session-panel` on `/` to `.main-page-session-column` (`REAL_PANEL` / `DRAFT_PANEL`
  in `tests/e2e/browser/draft-helpers.ts`), or pin it by `data-session-id`: the slot's panel
  sits earlier in the DOM, so an unscoped `.first()` grabs it instead of the column under test.
- **One browser, one task store.** `TasksContext` (`useTasks`) is the only in-browser truth for
  a task row. A surface that shows a task reads it from there (`useStoreTask(id)`) and writes
  through the store's optimistic mutators (`update` / `setPhase` / `moveTask`), so the board
  row, the session header and the detail pane change in the SAME frame; the REST round-trip
  and its WS echo only confirm. Never call `updateTask` from `@/api/tasks` directly and rely on
  the `task:updated` echo to update the other surfaces: on a stalled server (a PATCH measured
  7.2s on 2026-09-02) the header showed the new title while the board kept the old one for
  seconds. A private `fetchTask` copy is allowed only as the fallback for a row the list does
  not carry or a surface outside the provider (`useTasksContextSafe()` returns null in pop-outs).
  Ratchets: `tests/e2e/browser/task-store-same-browser-instant.spec.ts` holds the PATCH at the
  network layer and requires both directions to propagate before the server answers;
  `task-store-detail-page-instant.spec.ts` (the `/tasks/:id` page) and
  `task-store-toast-undo-instant.spec.ts` (toast Undo through `deleteTask`) do the same.
- **The same rule holds for every shared entity, not just tasks.** The general shape: ONE
  module store per entity kind (a React context or `useSyncExternalStore` module), optimistic
  mutators that write the store BEFORE the request and roll back on rejection, and WS events
  that only confirm. A component that keeps a private `useState` copy of a shared record and
  POSTs its own write is the anti-pattern; it shows the new value on one surface while every
  other surface waits for the network. Stores that exist today, each with a network-hold
  ratchet (`*-same-browser-instant.spec.ts`): project registry (`hooks/useProjectRegistry.ts`,
  `renameProjectLocal` / `removeProjectLocal` / `patchProjectLocal`; also patches the task
  store), permission requests (`stores/permission-request-store.ts`: timeline card, rail card
  and toast are three readers of one `requestId` row; a settled request is never re-armed),
  letters (`components/inbox/letter-store.ts`: rail, session Inbox tab and reader are lenses
  over one list), calendar events / routines / agents (`stores/*-store.ts`), and document
  saves (`stores/file-save-signal.ts`: a save in one editor carries its hash AND bytes to every
  other view of the same file, note or memory doc in this browser, so a clean sibling adopts
  without a refetch and an echo of your own write never reads as an external change).
- **One browser, one session-SETTINGS store.** Same rule for the session record's composer
  settings (permission mode, model, effort, reply style, ACP model): a surface never patches its
  own copy. Writes go through `applySessionSettings` / `clearSessionSettings`
  (`stores/session-status-store.ts`) and reads come back through `useResolvedSessionRecord` /
  `useSessionStatus`, so the session-column pill, the chat lane composer pill
  (`components/chat/LaneComposerControls.tsx`) and the task detail session rows change in the
  SAME frame. `setSession({ ...session, mode })` inside a panel is DEAD CODE:
  `resolveSessionRecordStatus` overwrites `mode` from the store on every read, which is why the
  pill read as a dead button until the PATCH (which also reaches the live CLI) came back. Two
  authorities, two retirement rules: `mode` also rides the authoritative status snapshot, so its
  overlay is a PENDING mark retired by the first ACCEPTED snapshot newer than the mark (an equal
  or older re-seed must NOT clobber it); model / effort / output_mode / acpModel have no snapshot,
  so the overlay is the newest value this browser knows and retires when a fetched record confirms
  the same value (a stale record cannot). Ratchets:
  `tests/e2e/browser/session-settings-store-same-browser-instant.spec.ts` (holds the PATCH and
  requires the pill AND a second surface to move inside 700ms, both directions) and
  `tests/web/session-settings-store-overlay.test.ts` (the retirement rules).
- **A boot-time registry fetch is never a single attempt.** Anything fetched once and read for
  the life of the page (folder names, the project registry, custom Focus tiers, the engine
  catalog, the plugin app catalogue) goes through `fetchWithRetry` (`utils/fetch-retry.ts`:
  timeouts, network errors, 5xx and malformed 2xx retried on a 2s/4s/8s/16s schedule, a 4xx
  never), is re-pulled on the socket coming (back) up, keeps its last good value when a refetch
  fails, and guards stale answers with a generation counter plus an AbortController that a newer
  call aborts. `api.fetchX().then(set).catch(warn)` in a mount effect is the anti-pattern: on
  2026-09-17 a hidden tab reloaded onto a new build while the server's event loop was stalled,
  the client's 6-slot connection queue rejected every request that had waited 20s (before
  `attemptRequest`, so nothing was logged), and every folder rendered as a bare icon + count
  until a manual reload while the task list, which already retried, recovered on its own. Ratchets:
  `tests/web/fetch-retry.test.ts`, `tests/web/task-groups-registry-recovery.test.ts`,
  `tests/web/project-registry-recovery.test.ts`, `tests/e2e/browser/folder-registry-recovery.spec.ts`
  (+ the `.webkit` twin: kills the first registry GETs at the network layer and requires the
  name to arrive with no reload).
- Use the structured logger `import { log } from '@/utils/log'` — never raw `console.log`;
  never `console.debug` (invisible to the disk forwarder). IDs full, never truncated.
- **`<suggest>` action cards render in BOTH lanes through one module**
  (`components/chat/SuggestSegments.tsx`): Personal AI chat (`ChatMessage`) and the session
  timeline (`SessionMessage` for persisted rows, `StreamingTextBlock` for live deltas). The card
  id keys a persisted click receipt, so the `scope` you pass to `splitSuggestSegments` must be a
  SERVER-side per-message id that is byte-identical live and after a reload — chat: `turnId`
  (rides every `agent:*` event AND the stored entry); session: `msgId`. Never scope on anything
  the browser stamps (`key`, `timestamp`): that orphans every receipt on the next reload.
- **A stored `Range` does NOT survive a re-render, and it does not tell you so.** Anything painting
  message text without touching the DOM (quote pins via the CSS Custom Highlight API:
  `utils/pin-highlights.ts`, `hooks/useQuotePinPaint.ts`) holds live Ranges. When React replaces
  the text node under one, the DOM spec re-points its boundaries onto the parent element, so the
  Range becomes COLLAPSED while `startContainer.isConnected` stays `true`, `CSS.highlights.size`
  still counts it, and it paints nothing and hit-tests as a miss. Judge staleness by the boundary
  SHAPE (`collapsed`, container no longer a text node), never by connectivity, and re-derive from
  the passage TEXT — one animation frame, not a debounce, or a click on the passage does nothing
  for as long as the debounce lasts.
- **Conversation threads are a VIEW over the one linear transcript, never a second data path.**
  A thread anchor (`SessionRecord.threadAnchors`, PATCH `thread_anchors`) keys a user message by
  the transcript uuid Walnut PRE-ASSIGNS on the send (`userUuid` on `session:send`; the CLI
  persists the user line under exactly that uuid, its own stream-json contract), and names the
  reply it hangs off by that row's msgId (an API `msg_…` id on real transcripts, so never gate a
  parent on the v4 shape). Everything else is derived: `utils/thread-tree.ts` is the only model
  (thread key = parent + passage; a follow-up filed in the same thread, from the node view or an
  outline row's click, copies the anchor verbatim, which is what keeps it in the same thread), the
  rail / gutter / `↳` tag in linear mode and the node view in tree mode are two renderers of that
  tree. Tree mode FILTERS the existing timeline items inside `SessionChatHistory` by row thread;
  it must never grow a second row renderer or history/stream pipeline. Anything the send adds for
  the model (the quoted passage, the one-line "Back to the earlier thread about …"
  re-orientation) is composed into the visible message text (`composeAnchoredText`), never a
  hidden side channel. **The composer chip is consumed by the send** (one Ask, one anchored
  message; 2026-09-18 user call, the same "a leftover state is not a request" rule as the quote
  pill), and in the node view it is DERIVED from the thread on screen, never stored. **Every mark
  a thread paints is also the way back to its passage**: the `↳` tag is a button and the gutter
  bar's strip is clickable (`jumpToThreadOrigin`), landing where the outline's thread row lands.
  Ratchets: `tests/web/thread-tree.test.ts`, `tests/e2e/browser/session-threads.spec.ts`.
- **The session "/" palette lists what the CLI advertised, not what Walnut found.** Every
  `system/init` line carries `slash_commands` (already filtered by the CLI to what works in `-p`
  mode); `ClaudeCodeSession` captures it and `GET /api/sessions/:id/slash-commands` serves it,
  using the directory scan ONLY for descriptions. After a server restart the reattach tails from
  the end and the capture is gone, so the route recovers the last init from a bounded tail of the
  session's stream file through the daemon (`src/core/sessions/cli-slash-commands-recover.ts`,
  1MB then 4MB, memoised by file size) — deploys are frequent here and every live session used
  to fall back to discovery until its next turn. Pass the session id to `useSlashCommands`
  (`SessionPanel`, `NotesSessionChat`); the cwd/host discovery form is for drafts, where no CLI
  exists yet. A result that is not settled (`degraded`, or `source: 'discovery'` for a live
  session) retries by itself with backoff, and every palette open revalidates a list older than
  a minute (`onSessionCommandsPaletteOpen`), so "press Refresh to see the real list" must never
  come back (2026-09-04: the SSH scan timed out during a daemon upgrade and the palette sat at
  "Walnut + 4 built-ins" until the user found the button). Ratchet:
  `tests/e2e/browser/slash-palette-cli-source.spec.ts`.

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
  one place and every surface gets it; parallel copies drift (the session kebab once grew its
  own "Unpin" and "Mark unread" rows this way).
- **The kebab is lean by default** (2026-09-10 user feedback: "too noisy"). No session-status row (clicking the task row opens its session), no unread row
  (opening the task marks it read), no Unpin row (the lit tier pill IS the pin; clicking it
  again unpins), Start/Due are collapsed `KebabDateRow`s whose calendar opens on click, and
  priority renders only when `ui.show_priority` is on (`useShowPriority`, Settings → Tasks;
  off by default and hidden on every surface, not just menus). Ratchets:
  `tests/web/task-kebab-lean.test.ts`, `tests/e2e/browser/kebab-menu-lean.spec.ts`.
