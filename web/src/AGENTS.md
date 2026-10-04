# Web GUI — Quick Reference

**Full implementation details: `.claude/skills/walnut-web-frontend/SKILL.md`** (single-timeline
model, optimistic dedup, UX patterns, file structure). **Load that skill BEFORE touching session
chat, turn boundaries, or streaming block rendering** — that area has an incident history.

**Task/session search:** the backend is the hybrid index
([`src/lib/hybrid-search/README.md`](../../src/lib/hybrid-search/README.md)). Read
[`docs/investigation/qmd-search-performance/README.md`](../../docs/investigation/qmd-search-performance/README.md)
(historical, names the removed engine) before changing search requests, provisional results,
stale-response handling, or result merging: the search races and merge rules it documents are
still live on the client. The home panel shows a search as ONE flat ranked list: literal hits
lead and never move, server hits only append, and a server hit whose title or snippet doesn't
show the typed text folds into "Related (N)" (never by raw score: lanes score on different
scales). A completed task stays findable by its own title: up to three completed title hits
show inline after the open ones, other completed hits that show the query fold into
"Completed (N)" ([`search-relevance.ts`](./components/tasks/search-relevance.ts)).

**Task and session status:** read [Task/session status decisions](../../docs/decision/task-session-status.md) before changing red rows, read markers, Waiting badges, or connection hydration. Task commits and session status have separate authority.

## Invariants you must not break (even without reading the skill)

- **Streaming blocks are APPEND-ONLY.** No event handler deletes blocks. Absorption is a
  render-time filter (`web/src/stream/render-filter.ts`), never a mutation. A missed match may
  render a block twice briefly; it must never vanish.
- Frontend accumulation semantics live in ONE place: `web/src/stream/stream-reducer.ts` (pure
  functions). The server buffer (`src/web/session-stream-buffer.ts`) is its only twin — keep
  them semantically aligned when touching either.
- **ONE compaction is ONE row** (`src/core/stream/compaction-notice.ts`, shared by the reducer,
  the server buffer and the history parser). `status: compacting` is a 30s transport keep-alive
  the CLI re-emits for a compaction that runs minutes, so its repeats collapse into the
  placeholder already on screen and the boundary REPLACES that placeholder in place. This is the
  one sanctioned exception to append-only: it swaps a system PLACEHOLDER for its own outcome at
  the same index, so no model output is touched and array indices (the render identities) do not
  shift. Never extend it to text/thinking/tool blocks.
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
  `agent_id` stamp, no stamp = Walnut, OR the agent's `Ask <name>` project). Membership, order,
  title and dot state are ONE module, `@open-walnut/ask-list` (src/core/sessions/ask-list.ts),
  which `GET /api/v1/asks` also serves the phone from: newest `last_session_update` first (never
  `updated_at`, which edits move), the row prints the stamp it sorts by, and rows hold their
  places while the drawer is open (`holdOrder`; a newcomer joins at the end). A held row
  prints the stamp it had in the snapshot and a newcomer reads "New" (`printedStamp`), so a
  continued ask never reads "just now" under "5mo ago"; the next open shows real times in the
  true order. The places are the ones the user SAW: `nextHeldOrder` takes an agent's snapshot
  only once the task list has loaded and has rows (a drawer opened before the board arrived
  used to hold an empty list, so every row followed the live order), keeps ONE per agent until
  the drawer closes (Walnut, Mentor, Walnut shows Walnut's first list again), and until then the
  list reads "Loading your asks…", never "no sessions yet". The slot's draft
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
- **Pins never block an open, and the count follows the strip** (`panelBudget` in
  `pages/sessionColumns.ts`, read ONLY by `addSessionColumn`). The panel count
  (`ui.session_panels`, 1-5 or Auto) is the budget, except when the locked columns alone fill it:
  then an open gets the pins plus ONE free slot (never past `MAX_PANELS`), so a pill click with
  every panel locked opens a column instead of the old "All session panels are locked" toast (now
  only at 5 pins). The moment an open uses that grant, `openSessionOrToast` (MainPage) WRITES the
  new width into the setting (`setMode`, Auto becomes the number): a strip of 3 under a picker
  still saying "2" was "very confusing" (2026-10-02), so every picker shows what is on screen and
  the strip is back to "size = setting". Nothing else reads the grant: the trim effect, the triage
  open and `fitRestoredColumns` fit the bare count (pins are never cut; a free column saved over
  the count goes), so the only wider-than-count strip is the one an unlock leaves (unlocking closes
  nothing). An open evicts AT MOST ONE column, in `addSessionColumn` and in the trim effect's
  placeholder falling edge (a Start from a draft), so that strip never loses two panels on one
  click; a capacity change (count, resize) trims all the way. Spec:
  `tests/e2e/browser/session-panel-lock-grant.spec.ts`.
  **Shrinking back is the user's own move, never a heuristic** (decided 2026-10-01 against an
  idle/"finished" auto-fold; 2026-10-02: "if it already adjusted then keep it 3, the customer can
  reduce it themselves"): close a column, or pick a lower count. What the strip owes them is
  finding that count: the grow moment raises a `hint` toast, two short lines ("Panels
  auto-increased from 3 to 4" / "All 3 were pinned, so the new session needed its own"; kind
  `hint` in `contexts/notifications/types.ts`, ephemeral, 8s) whose "See your setting" button
  opens the picker the user ALREADY HAS beside the strip, the task panel's Display menu
  (the sliders button next to New task), on its Session columns row, pulsing
  (`revealViewOption('session-panels')` in `components/tasks/view-dropdown-reveal.ts`: a window
  event the home `DisplayButton` answers (`DisplayMenu.tsx`, row class `dm-row-flash`); it shows
  a hidden task panel first and waits for the trigger to hold still, `whenSettled`, before
  placing the menu, because the panel slides open over 250ms). It does NOT send the user to
  Settings (2026-10-02: "that's ridiculous, it's too far away"); `/settings#session-panels` still
  works as a typed deep link (`ROW_TARGETS`
  in `components/settings/settings-routing.ts`, pulses the row with
  `settings-anchor-flash-strong`). The Panels 1-5/Auto row is also the FIRST row of the session
  kebab (`leadingSection` of `TaskQuickActions`, above Task detail), not a line between the view
  toggles.
- **The home task panel has ONE filter concept and ONE toolbar button** (2026-10-02, the new-user
  redesign: "what is pinned, focus, satellite? filter is filter"; "so ugly, process is super long,
  better a small search thing"; 2026-10-03: "no need for two buttons, one button: Display, with the
  filter inside it; filter, sort and group are strongly related; the view does not have to show in
  full, two clicks is fine; Show tab bar and Session columns must show"). **Display** (sliders, the
  active-filter count as a badge, `components/tasks/DisplayMenu.tsx` for the button, `FilterMenu.tsx`
  `PanelMenu` for the menu) is a SMALL two-page menu, 320px, one search box on top. Page one, top to
  bottom: `Filter` (`FilterHome.tsx`: one row per property with its value at the right, Status,
  Project, Date, Source; Priority, Blocked, Tags, Sprint, Time window folded behind `More filters`
  unless set; `Clear` in the title while something is set), then the display rows
  (`DisplaySections.tsx`): Sort and Group, then View (one row, the current view's name at the right),
  Show tab bar, Session columns, and last the rows only some views have (Collapse all, Tier layout,
  Recent order). A property row opens page two (`FilterValuesPage.tsx`), that property's values as a
  checklist (`FilterValueList.tsx`, shared with the chip menus: a plain click TOGGLES a multi-select
  row, a single-select pick closes the menu); the View row opens the view list (`DisplayViewsPage`,
  the bar's tabs above a hairline, the rest below, a pick closes the menu). Typing searches every
  filter value AND every view on page one (hits ranked by `RecentEntry.uses`, `filter-home-model.ts`
  `rankByUse`) and filters the rows on page two. Never bring the wall back: a first page is a
  handful of 28px rows, not every value of every property, and never a `Most used` block (it was
  the first thing dropped). What the filter sets shows as chips in the filter row under the toolbar
  (`FilterBar.tsx`, one chip per dimension; the count and `Clear` in the row's tail at the top
  right), the one place that says "a filter is on". There is ONE Status (To Do, In Progress, Need
  Action, Waiting, Complete; the default is the three open ones), never a Status AND a Phase. Tier
  names never sit at the first level. Open state is the filter controller's (`useHomeFilters.ts`
  `menuOpen`, `buttonRef`): the F shortcut, the board's "Filter to this project", the row's view
  item and the strip's "Adjust panels" hint all open the same menu. State lives in
  `useHomeFilters.ts` (`FilterState`, persisted under `walnut-todo-filters`, chips derived by
  `filter-bar-dims.ts`, the list predicate in `filter-predicate.ts`); `/tasks` keeps `ViewDropdown`
  for now with the same one-Status section. Every popover and flyout here is placed by
  `useMenuPlacement` and closed through `hooks/useOverlayLayer.ts` (one outside-press/Escape layer per
  open overlay, child portals exempt). Specs: `tests/e2e/browser/filter-bar*.spec.ts`,
  `display-menu.spec.ts`, `todo-search-and-filters.spec.ts`; helpers in `filter-bar-helpers.ts`.
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
  over one list), calendar events / routines / agents (`stores/*-store.ts`), document
  saves (`stores/file-save-signal.ts`: a save in one editor carries its hash AND bytes to every
  other view of the same file, note or memory doc in this browser, so a clean sibling adopts
  without a refetch and an echo of your own write never reads as an external change), and the
  session recap tip (`stores/recap-tip-store.ts`: the Overall / Latest rows above the composer,
  the plan popover's composer and the Todo detail row read ONE merge of the session record with
  the live `session:recap-updated` copy, newest field wins by its `*At` stamp; a per-panel
  `setSession` patch used to lose the event when it beat the record's first fetch, and an
  in-flight fetch used to put the old recap back; dismissals live there too, keyed by the text).
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
  (thread key = parent + passage). The UI calls them **questions**; the word "thread" never
  appears in visible text or an aria-label (code identifiers keep it).
  **The Stack is the only page renderer.** A question page is the SAME timeline scroll box in
  `SessionChatHistory`, filtered to one question's turns (`partThreadKey === currentKey`) and
  decorated by `ThreadStackFrame` (sliver of ancestor bars, the P4 stack header, the quote head,
  "Asked from this answer" rows). Never add a second row renderer or history/stream pipeline, and
  never remount the scroll box on a push or pop (the frame is always mounted, `display: contents`
  when off). Navigation is `useThreadStack` (path, per-page drafts, Esc through
  `usePanelKeyRouter`, `data-thread-depth` on the panel root, sessionStorage
  `thread-stack.v1:<sid>` plus the `t<n>` URL leaf); landing on a pop is `useThreadLanding`
  (restore scroll, correct once, flash the passage, `armBack: false` so a pop never arms the
  outline's Back). The pure rules live in `utils/thread-stack-state.ts` and are unit tested.
  **Asking opens a page before anything is written**: a pending page (`pending:<parent>:<hash>`)
  holds the quote head and an empty composer; the first send does ONE PATCH carrying
  `thread_anchors` + `thread_meta` together, and the text the model sees is composed into the
  visible message (`composeAnchoredText` / `composeOrientedText`), never a hidden side channel.
  The same passage asked twice goes to the existing page (one passage, one mark, one page).
  **Live blocks belong to the page of the turn that wrote them.** A queued question never claims
  the running answer, and a FINISHED turn's blocks stay on its page until the transcript absorbs
  them (`recordTurnSegments` / `blockPageKey`: a turn is matched to the oldest delivery not yet
  matched; the main conversation's key is `''`, a real owner, so "unknown" is `null`). Without
  this, three Asks sent during one answer pulled that answer onto the last question's page.
  **Every mark a question paints is also the way back to it**: a mark in an answer (CSS Custom
  Highlight, hit-tested by caret position in `utils/thread-mark-hit.ts`) pushes its page, the
  quote head and the sliver pop to the passage, and in Conversation Mode the 2px turn rule
  jumps to the origin (`jumpToThreadOrigin`).
  **Two views, one pill, one sidebar (2026-09-29).** `SessionViewMode`: `linear` is
  **Conversation Mode**, the DEFAULT, every row in order with ONE `ThreadTurnLabel` (number,
  title, status word) above each question turn's user row and a grey rule down the turn
  (`.session-msg--threaded`); `stack` is **Tree Mode**, the question pages. The header's only
  question control is `ThreadModePill`, which names the view a click switches TO (icon only under
  560px). The `N open` count pill, the root `More` menu and the linear banner are gone: counts and
  the list live in the sidebar (`ThreadMap`), the drawer opens from the map's list button or
  Cmd+Shift+E. View key `walnut:session-view.v2:<sid>`, fallback `walnut:session-view.default`
  (specs set it to `stack`); the pre-v2 key is never read. In Conversation Mode the stack path is
  the composer's TARGET, not a filter (`useThreadStack.active` is mode-independent, `enabled` is
  stack view only): a map row or a turn label picks the question the next message replies in.
  **Questions are told apart by NUMBER and status word, never by colour.** `SessionThreadMeta.seq`
  is given once at Ask (`nextQuestionSeq`; the server keeps it write-once and the AI writer may
  not set it), questions from before the field are numbered by transcript order
  (`utils/question-tag.ts` `questionNumbers`). Status words: Waiting / Answering… / New / Answered
  / To check / Done / No answer / Draft (`ThreadStatusWord`); a streaming answer already counts as
  present. The user's words on the hue-per-question design: "I don't know which one is which".
  **The reply tag files the answer.** A question's send (and every follow-up) opens with the
  `[Question Q<n>]…[/Question Q<n>]` banner asking the model to begin with the line `[Q<n>]`; the
  bubble hides that banner (`QUESTION_BANNER_RE`), `SessionMessage` and `StreamingBlockView` strip
  the tag from the text on screen, and the tag decides where the turn belongs: `withTagAnchors`
  adds a client-side synthetic anchor for a turn whose first answer text names another question
  (or none was recorded), and `tagKeyOfBlocks` routes live blocks the same way, both ahead of the
  send-order guesses (`recordTurnSegments` / `blockPageKey`). This is the fix for "the answer
  shows while it streams and then disappears": the user row's pre-assigned uuid is lost on a
  `--resume` fallback or when two sends merge into one turn, so the anchor filed the reply under
  the wrong turn the moment history absorbed it, and a truncated half of it stayed pinned at the
  main conversation's tail. The mock CLI answers the banner with the tag (`tests/providers/
  mock-claude.mjs` `stripBanners`), so every fixture exercises this path. Ratchets:
  `tests/web/question-tag.test.ts`, `tests/e2e/browser/session-conversation-mode.spec.ts`.
  **The comment card (2026-09-30).** In Conversation Mode a question is read and asked in a card
  BESIDE its passage, like a comment in a document (`ThreadCommentCard`, pure parts in
  `utils/thread-card.ts`, placement in `hooks/useThreadCardPlace.ts`). Open is one flag in
  `SessionChatHistory` (`cardOpen`); WHICH question is the stack's target, so a sidebar row, a turn
  label, a drawer row (`requestHeadJump`), a click on the marked passage and an Ask on a selection
  all open or swap it by moving the target, Esc / an outside click / the mode pill close it, and a
  pending question promoted by its first send stays on screen. **An Ask nobody wrote leaves
  nothing (2026-10-03):** every close (`closeCard` → `stack.leavePending(cardText)`; the frame's
  outside press and the Files tab losing the file go through `requestCard(null)`) drops a pending
  page with no words, so no draft row, no dashed mark, no rail entry and no target survive; words
  typed in the card's own box (`onTextChange`, which the composer probe cannot see) or the composer
  keep it a draft that reopens with them (`initialText`; the rule is `pageLeave` in
  `utils/thread-stack-state.ts`). One exception: a press into the panel's composer closes the card
  but keeps the Ask as the target, since the reader is writing it there, and appends the card's
  words to the composer (`COMPOSER_INSERT_EVENT`, mode `append`). **The composer names its
  target** (`ComposerThreadPill`, `threads.composerTarget`, Conversation Mode only): `Replying in
  [n] title` or `Asking about title`, the title reopening the card and × (`stack.replyInMain`)
  sending to the main conversation with the typed words carried into its draft. The user asked to
  see and take back the choice the placeholder alone hid. **The card expands**: its ⤢ portals it
  into `.session-panel` over a backdrop (inside the panel, so the panel's styles still reach the
  turns; `.thread-card-backdrop` is exempt from the outside closer), Esc or the backdrop brings it
  back, × closes. The card shows the question's turns
  (`cardTurnsOf`: the question without the quote block it was sent with, `questionBodyOf`, then the
  reply's prose rows with `suppressTools`), the optimistic row and the live text blocks of the turn
  being answered, and a composer that sends through `threadsApi.sendToTarget` (the same anchored
  path as the panel's composer). It lives in `.thread-card-layer`, a zero-height positioned box at
  the top of the scroll content, so `top` is a content coordinate and the card scrolls with its
  passage; `placeCard` puts it below the passage's last line, right edges aligned, clamped to the
  layer. Every asked passage wears ONE neutral grey mark (`allPassageMarks`, highlight
  `thread-mark-neutral`), never a hue. Two rules this slice fixed: `useThreadLanding` takes
  `targetOnly` and does nothing on a navigation in Conversation Mode (a target change is not a page
  change; before, every Ask and every sidebar row "landed at the top" and the whole conversation
  jumped to its first message), and the rail is thin lines (`.thread-map-tick`: root longer,
  pending dashed, current dark), no number badges and no dot ("just a few lines, like Claude").
  Ratchets: `tests/web/thread-card.test.ts`, `tests/e2e/browser/session-thread-card.spec.ts`.
  **The question tree is always on screen, never behind a hover or a button** (`ThreadMap`, top
  left of the timeline, in place of the outline rail once a session has a question). Its rows are
  the drawer's All view (`utils/thread-map.ts` → `flattenTree`), so the two never disagree. A box
  of 640px or more reserves a gutter for the labelled tree (`data-thread-map="panel"` pads the
  scroll box, so no text runs under it); a narrower one, or a user who hid it (localStorage
  `walnut:thread-map.v1`), gets a rail of marks whose list opens on hover, focus or a tap. The
  user's report that led here: a real session showed only the header's `2 open` pill, and
  "people don't know" to look for a drawer. Three traps it encodes: pins alone are no question
  (a pins-only session keeps its outline, `mapHasContent`); a gutter change reflows every row
  and the box has no native scroll anchoring, so `useThreadMapLayout` puts the old gutter back
  for one measure and holds the first row on screen; and a row key holds a NUL, which
  `CSS.escape` turns into U+FFFD, so DOM ids are `encodeURIComponent`ed.
  Ratchets: `tests/web/thread-tree.test.ts`, `tests/web/thread-stack-state.test.ts`,
  `tests/web/thread-map.test.ts`, `tests/e2e/browser/session-threads*.spec.ts`,
  `tests/e2e/browser/session-thread-map.spec.ts`.
  **A passage of a FILE in the Files tab is asked about the same way (2026-10-01).** The anchor's
  parent is `file:<absolute path>` (`FILE_PARENT_PREFIX`, `fileParentOf` / `fileOfParent` in
  `utils/thread-tree.ts`; the server takes a `file:` parent up to 1024 chars and an optional
  1-based `line`), the node hangs off root at depth 1 with `node.file = {path, line}`, and the
  send opens with ``About `path[:line]`:`` ahead of the quote (`fileAboutLineOf`;
  `questionBodyOf` drops that line too). Two entry points, both in `FileThreadLayer`
  (`components/common/FileThreadLayer.tsx`, mounted by `FileContentView` over the file view
  whenever the panel can ask): the selection pill's second action (`SelectionAskPill` with
  `onAskHere`: `Ask here` / `Quote in chat`; the WYSIWYG bubble menu has the same pair), and an
  inline `Ask` on the block under the pointer (`askableBlockOf`, `blockQuoteOf`: the whole
  paragraph, item, heading, cell or code block). The card is STILL the timeline's: the layer lends
  a host (`FileCardHost {path, el, place}` through `threadsApi.setFileCardHost`), asks with
  `threadsApi.requestCard(key | null, via)`, and `SessionChatHistory` portals its one
  `ThreadCommentCard` into that host when the open question is about the file on show, or calls
  `onFileOpen(path, line)` to open the Files tab first (a sidebar row, a turn label, the quote
  head's back arrow in Tree Mode). The host box does not scroll, so `placeFileCard`
  (`utils/file-thread.ts`) works in host coordinates and re-measures on scroll, resize and
  mutation; a passage scrolled off keeps its card docked at the edge. Marks on asked passages use
  the neutral style; in the HTML preview they are painted into the IFRAME's own document and
  highlight registry (its own `<style>`, its own `pointerdown` closer, since the top document's
  outside-click never sees a press inside the frame). The mock CLI answers these like a model
  (`stripInputDecorations` in `tests/providers/mock-claude.mjs`: no `> quote`, no `(Back to …)`,
  no reminder lines, and with `MOCK_CLAUDE_PLAIN_ECHO=1` from the browser fixture no spawn-flag
  suffixes), so an e2e that needs proof of WHAT was sent reads the record's anchor, not the echo.
  **The file on show has its own question rail (2026-10-02)**: `FileQuestionRail`
  (`components/common/FileQuestionRail.tsx`, rows from `fileQuestionRows` in `utils/file-thread.ts`)
  is the narrow column's rail again (same `.thread-map-mark` lines, `railMarks`, `MapRow`), one
  mark per question about THIS file plus the draft, pinned by the layer at the top-left of the
  file area just under the Preview/Source toolbar (`.fv-file-rail`, measured against
  `.fv-html-toolbar`), never inside the HTML iframe. Hover or focus opens "In this file"; a row
  calls `requestCard(key, 'file-rail')`. The user asked for it after not knowing what they had
  asked in a document. Every open brings its passage on screen when it is off it: the once-per-key
  guard (`scrolledForRef`) resets when the card closes, because kept per key a reopen after the
  reader scrolled away docked the card at the bottom edge over unrelated content (a real long
  explainer page, 2026-10-03; pinned by `cache-handbook.html` in the browser fixture). Drafts kept
  with words show on the rail and the passage too (dashed). The rail pitch is `MAP_RAIL_PITCH` = 10px (was 14: two marks read as two
  unrelated dashes); `.thread-map-mark { height }` must match it.
  Ratchets: `tests/web/file-thread.test.ts`, `tests/e2e/browser/session-file-questions.spec.ts`.
- **Side question vs Ask: two features, pick by context.** A side question (`SideQuestionDrawer`,
  the btw fork) runs in an ISOLATED context: a one-off aside whose answer must not enter the main
  conversation, so the main session never sees it. Ask (select a passage, then Ask) is a
  question IN the main conversation: every follow-up goes into the one transcript the main
  session reads, and the Stack only changes what is on screen. Use a side question when you do
  not want to spend or steer the main context; use Ask to dig into a sentence of the main
  conversation. Do not merge them, and do not label either with the other's words.
- **The outline reads in transcript order, and the loaded history is a TAIL window.** A pin
  whose message is not loaded is almost always OLDER than every loaded row, so it is placed by
  its message's timestamp (`components/sessions/outline-order.ts`: half a step before the first
  loaded row stamped after it), never parked at the end (2026-09-18: a two-day-old pin sat under
  one made an hour ago). Its row is a real destination: `jumpToPlace` loads the full history
  first and finishes the jump when the row lands. Rows from another day show their date, since a
  bare clock time is what made the mis-order look impossible. Ratchets:
  `tests/web/outline-order.test.ts`, `tests/e2e/browser/session-outline-window.spec.ts`.
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
- **There are no submenus.** The core `ContextMenu` has none, so the Mail message menu groups its
  AI entries under a `Walnut` info row instead, with the ✦ inline in the LABEL rather than in
  `row.icon`: Mail has never drawn that icon column, and filling it for one group indents only
  that group. Adding a submenu means adding a portalled flyout (previous rule), not nesting a
  menu. See [Leaving a mailing list](../../docs/plan/mail-unsubscribe.md) for how the four
  unsubscribe states read in that group.
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
