---
name: walnut-web-frontend
description: Implementation details for web/src/ (React SPA) — session chat single-timeline model (streaming blocks, render-filter absorption, optimistic dedup, turn watermark), UX patterns (task refs, images, plan cards, slash commands), frontend file structure. MUST read before touching session chat, turn boundaries, or streaming block rendering.
---

# Web GUI — Implementation Details

For architecture overview and routes, see project `CLAUDE.md`.

**Rendering model text (markdown, rich HTML, marked extensions, sanitize policy) lives in its own skill: `walnut-markdown-rendering`.** Load that one before changing `web/src/utils/markdown.ts` or `rich-blocks.ts`; it holds the hard rules (never patch marked, register a retune on BOTH `Marked` instances, collapse blank lines at render time only).

## UX Implementation Details

- **Source-aware message isolation**: Streaming agent responses from different sources (heartbeat, cron, triage, user-chat) render as separate message blocks. `useChat` tracks `currentSourceRef` during streaming and passes it to `upsertLastAssistant` which only merges into the last assistant message if the source matches. The turn-merger in `chatEntriesToMessages` checks `entry.source` boundaries to prevent cross-source merging on history reload.
- **Rich task references**: Session result/error messages use `[taskId|Project / Title]` format rendered as clickable pills via a custom `marked` inline extension (`ChatMessage.tsx`). Backend enriches events with task metadata (`resolveTaskRef()` in `server.ts`); frontend builds the format via `buildTaskRef()` in `useChat.ts`. Entity refs (`<task-ref>`, `<session-ref>`) also render as clickable pills. On MainPage, clicking a task ref focuses it in TodoPanel (auto-switches tab, expands groups, scrolls into view) and clicking a session ref opens the inline SessionPanel + focuses the linked task — no page navigation.
- **Inline image rendering**: Image paths in markdown text are rendered as `<img>` tags via three mechanisms in `ChatMessage.tsx`: (1) `imagePath` inline extension for bare paths in text, (2) `link` renderer override for `[text](/api/images/...)` markdown links, (3) `codespan` renderer for backtick-wrapped paths. The `link` renderer only matches local paths (`href.startsWith('/')`) to avoid hijacking external URLs. `/api/images/` URLs render directly; absolute file paths proxy through `GET /api/local-image?path=...` (`src/web/routes/local-image.ts`) with extension whitelist, traversal protection, and 50MB size limit. Clicking any image opens a lightbox modal (`Lightbox.tsx`). Works in chat, session history, and session streaming views via the `marked` singleton.
- **Tool result image rendering**: `GenericToolCall` in `SessionMessage.tsx` auto-detects images in tool results via three mechanisms: (1) Anthropic content-block JSON with `type:"image"` + base64 data → renders as `<img src="data:...">`, (2) file paths ending in `.png/.jpg/.gif/.webp` in result text → renders via `/api/local-image` proxy, (3) input `file_path`/`path`/`filename` pointing to image files → shows preview when result has no images. **Relative paths** (e.g., `screenshot.png` from Playwright) are resolved using the session's `cwd` via `resolveImagePath()` — the `sessionCwd` prop threads through `SessionChatHistory` → `SessionMessage` → `GenericToolCall`. Detection utilities in `web/src/utils/markdown.ts` (`extractContentBlockImages`, `findImagePaths`, `isImageFilePath`, `resolveImagePath`). Result prop merges streaming (`result` prop) and persisted history (`tool.result` field) paths. Images constrained to panel width via `max-width: 100%`; lightbox click-to-zoom via existing `data-lightbox-src` delegation.
- **Session streaming (single-timeline model)**: Backend-buffered per-session streaming. `SessionStreamBuffer` (`src/web/session-stream-buffer.ts`) accumulates blocks in memory; `session:stream-subscribe` RPC returns a snapshot. All stream events broadcast to all WebSocket clients — frontend filters by `sessionId` (supports multi-panel streaming). `useSessionStream` hook handles subscribe-on-switch with catch-up. **Frontend accumulation semantics live in ONE place**: `web/src/stream/stream-reducer.ts` (pure functions: lane isolation by `parentToolUseId`, msgId-boundary = new block, tool-result backfill newest-calling-first) — shared by `useSessionStream` AND `session-cache`. The server buffer is the only remaining twin (language boundary — keep it semantically aligned when touching either). Streaming tool calls reuse `GenericToolCall` from `SessionMessage.tsx` (same expand/collapse as history) — `status` prop drives icon/class (`calling`→`done`→`error`), `result` prop renders when available.
- **Session message queue**: Persistent disk-backed queue (`src/core/session-message-queue.ts`) for session chat. Messages enqueued as `pending`, drained and combined by `SessionRunner.processNext()`, cleared after `session:result`. Supports edit/delete of pending messages. Survives server restart (at-least-once delivery).
- **Session image support**: Session chat inputs reuse the main `ChatInput` component (with `showCommands={false}` and custom `placeholder`). Images are pasted/dropped/attached client-side, sent as base64 via WS RPC, saved to `~/.open-walnut/images/` server-side, and their file paths are embedded in the message text.
- **Session columns on home page**: Up to 3 session panels displayed side by side between chat and ToDo (`MainPage.tsx`). `sessionColumns: string[]` queue with FIFO eviction. Triage takes the first column slot, reducing session max to 2 when open. Panel area width graduates by column count (35%→45%→55%) via `useResizablePanel.setPct()`. Chat panel toggleable via Focus Dock button. Session pills gain `isActive` prop to highlight open columns. Legacy single-session `sessionStorage` key auto-migrates to array format. Each `SessionPanel` instance streams independently (WS broadcasts all events, frontend filters by sessionId). Session pills use a three-layer badge format: `Session · Plan/Bypass · WorkStatus / ProcessStatus` — the outer label is always "Session" (unified naming), inner mode shows Plan or Bypass. Clicking the pill directly opens the session panel (one-click via `stopPropagation`). The initial prompt (first user message) renders at the top of the session chat timeline. Mode indicators use muted labels (`📋 Plan` / `⚡ Bypass`) instead of blue accent badges.
- **Focus Dock pin state**: Shared via `FocusBarContext` (`web/src/contexts/FocusBarContext.tsx`), provided in `AppShell` inside `TasksProvider`. Both `AppShell` (renders `FocusDock`) and `MainPage` (provides pin/unpin to `TodoPanel`) consume the same context — ensures optimistic pin/unpin updates are instant (~6ms) rather than waiting for API round-trips. The `useFocusBar` hook only re-fetches on `config:changed` events with `key === 'focus_bar'` to avoid stale-config races from other config writers. **No pin count limit** — users can pin any number of tasks; Focus Dock renders only the first 3 (`FOCUS_DOCK_MAX_VISIBLE` in `FocusDock.tsx`), while TodoPanel's pinned section shows all.
- **Search child task expansion**: Search results include `parentTaskId` and `isAutoExpanded` from the backend (`src/core/search.ts`). When a parent task matches, its children are auto-inserted after it with `isAutoExpanded: true`. Frontend `SearchResults.tsx` renders children with `↳ Child` badge, left-indent (`search-result-child` CSS), and an `auto` badge for auto-expanded items.
- **Segmented filter bars**: TodoPanel uses joined segmented controls (not dropdowns) for Priority, Phase, Session, and Source filters. Icons use a unified minimalist set (○ ◐ ✓ [person-svg] ⋈ ▷ ✓✓) consistent across `PHASE_ICON`, `StatusBadge`, and filter chips. AWAIT_HUMAN_ACTION uses an SVG `PersonIcon` component (`PersonIcon.tsx`) instead of a Unicode character. Icon maps are `Record<string, ReactNode>` to support mixed string/JSX icons.
- **Slash commands**: Dual-layer system — hardcoded frontend commands (`/compact`, `/plan`, `/tasks`) + markdown-based commands (built-in `.md` in `src/data/slash-commands/` + user-created in `~/.open-walnut/commands/`). User commands override built-in by name. Backend: `src/core/command-store.ts`, `src/web/routes/commands.ts`. Frontend: `web/src/commands/` (registry + markdown-bridge), `/commands` page.
- **Session slash command autocomplete**: Session inputs (`SessionPanel`) show a command palette when typing `/`. Aggregates 4 sources: skills, Walnut commands, `~/.claude/commands/` (root), `{cwd}/.claude/commands/` (project). Backend: `GET /api/slash-commands?cwd=...` (`src/web/routes/slash-commands.ts`). Frontend: `useSlashCommands` hook with cwd-based caching and ranked search (name prefix > name contains > description contains). `ChatInput` supports `sessionCommands` prop — selecting inserts text instead of executing. Source badges show origin (Skill, Walnut, Claude, Project).
- **Plan content rendering**: In session chat, `ExitPlanMode` renders as a `PlanCard` — an accent-bordered, collapsible card with formatted plan markdown. Plan content resolved from `ExitPlanMode.input.plan` (primary) or from a preceding `Write` to `~/.claude/plans/` (fallback). Components: `PlanCard` and `CollapsedPlanWrite` in `SessionMessage.tsx`. **Live updates**: `PlanCard` consumes `PlanContentContext` (provided by `SessionPanel`) to show live plan content from `useSessionPlan` polling — this bypasses `memo()` on `SessionMessage` so both the top `PlanPreviewSection` and bottom chat `PlanCard` auto-refresh when the plan file changes. Context: `web/src/contexts/PlanContentContext.ts`. **Expand features**: `PlanCard` header has a hover-reveal expand button that opens `PlanPopup` (60vw centered popup via portal). `SessionPanel` header has an expand button that promotes the panel to 95vw×95vh fullscreen via `useFullscreen` (CSS class toggle — no new component instance). `PlanPopup` shares `useModalOverlay` for ref-counted scroll lock + Escape support; `useFullscreen` participates in the same scroll-lock ref count via the exported `lockScroll`/`unlockScroll` from `useModalOverlay.ts`. z-index: session=9000, plan=9100, lightbox=9999.
- **Session header actions**: Only four chips stay visible outside the ⋮ kebab — **Fork / Changed / Files / Terminal**. Everything else (copy CWD/ID/Resume, Restart, Investigate, Notes, Msgs, Plan & Execute) lives in the kebab's `Session` section. The kebab is the shared `TaskQuickActions` (`slot="kebab"`); it takes an `extraSection={(close) => …}` render-prop so one dropdown holds Task actions (top) + Session actions (bottom, `SessionKebabSection.tsx`). The kebab now renders even for a task-less session (when `extraSection` is supplied). `SessionForkButton.tsx` is the standalone Fork action (calls `POST /api/sessions/:id/fork` with `create_child_task: true`; backend auto-creates a child task then forks; navigates to `/tasks/{newChildId}`). Wired into `SessionPanel`. Exit-fullscreen uses the shared `ICON_COLLAPSE` (lucide minimize-2, arrows inward).
- **Quick Add behavior**: The "Quick add task..." form in `TodoPanel.tsx` always creates tasks under `Inbox / Quick Start` (hardcoded `category` + `project`). After creation: if on the All tab, stays (task visible); any other tab (Star, category tabs) auto-switches to the Inbox tab. The new task is auto-focused and scrolled into view via `onFocusTask`. A `focusHandledRef` prevents race conditions when the task arrives via WebSocket after `focusedTaskId` was set.
- **Multi-level child task nesting**: `TodoPanel.tsx` computes `depthMap` (task ID → nesting depth) via recursive parent-chain walk in the child-task `useMemo`. `isChildHidden` walks the full ancestor chain — collapsing any ancestor hides all descendants. Depth-based `paddingLeft` (20px per level, max depth 10) replaces the old fixed `.todo-panel-item-child` CSS class for unlimited nesting support.
- **Memory Browser** (`/memory`): Split-view page for browsing and editing all memory files. Left panel (`MemoryTreePanel`) shows collapsible sections (Global, Daily Logs, Projects, Sessions, Knowledge) with filter input. Right panel (`MemoryContentPanel`) renders selected file as markdown with an Edit toggle — clicking Edit switches to a monospace textarea for raw markdown editing with Save/Cancel buttons and keyboard shortcuts (Cmd+S, Escape). Edit state resets on file switch. Backend: `GET/PUT /api/memory/browse|global` + `GET/PUT /api/memory/*` (path-based with traversal protection). URL state via `?path=` query param. Resizable left panel with localStorage persistence.

- **Browser console log persistence**: `web/src/utils/browser-logger.ts` monkey-patches `console.log/info/warn/error` to persist browser logs to disk. Initialized in `main.tsx` before React mount. Logs sent via WS RPC `browser:logs` (batched every 2s or 50 entries) with `sendBeacon` fallback on page unload. Backend writes to the same log file (`subsystem: 'browser'`). View with `open-walnut logs -s browser`. See `src/logging/AGENTS.md` for full details on investigating frontend issues.

## Session Chat — Single-Timeline Model (streaming blocks + persisted history + optimistic bubbles)

Session chat renders three data sources: **persisted JSONL history** (server-parsed from Claude Code output files), **streaming blocks** (WS deltas accumulated in `useSessionStream`), and **optimistic messages** (client-side state in `useSessionSend`). The core challenge is showing content immediately and gracefully converging to persisted data, without duplicates or disappearances.

### The single-timeline invariant (2026-07 refactor — read before touching turn boundaries)

The old model DELETED streaming blocks at turn boundaries via evidence reconciliation (`clearCompleted`, `completedLen`, `awaitingRefresh`, deferred clears, 5s fallback timers). Every new CLI stream format broke one of the heuristics → 7 same-shape "message vanished / pinned at bottom / looks unfinished" incidents in 2026-06~07. The refactor inverts the failure mode:

- **Streaming blocks are APPEND-ONLY.** No event handler deletes blocks. `session:result` only stamps `completedLen` (a MERGE boundary for the text accumulator, nothing else).
- **Absorption is a render-time filter**, not a mutation: `web/src/stream/render-filter.ts` (`computeRenderFilter`) hides a block iff current history PROVES it was absorbed — msgId twin (watermark-immune), toolUseId twin (incl. `childMessages` recursion), content twin within the turn window, or parent-Agent `bgTaskFinished` for subagent-lane blocks. Matching rules live in `web/src/cache/promote-blocks.ts` (`computeAbsorbedIndices`) — the exact semantics that survived the incident chain.
- **Failure inverts**: a missed match means a block briefly renders TWICE (next to its history twin) and collapses when evidence lands; it can never vanish. Unmatched finished blocks log a `render-filter: … no delta twin` warning — a persistent one means archive & stream genuinely disagree (real bug, surface it).
- **Turn watermark** (`SessionChatHistory`): history length when the current turn started streaming (`isStreaming` false→true edge; seeded at first history load). Content matching for id-less blocks only trusts `messages[watermark..]`; id matching is scope-safe at any range. On /compact shrink the slice clamps empty → content matching pauses, ids unaffected.
- **Live-tail guard**: while streaming, the last MAIN-lane block (`lastMainLaneIndex`) is never matched — its partial content / early-known msgId must not hide it mid-accumulation.
- **Memory reclamation is all-or-nothing**: `resetIfAbsorbed` in `useSessionStream` drops the whole array only when every block is hidden and no turn is live (`allBlocksAbsorbed`). Because reset is atomic and blocks are append-only, **array indices are stable render identities** — no blockSeq needed; `blockIndexMap` bubble anchors are set-once and clamp to 0 on full reset.
- `session-cache`'s streaming state is a background accumulator; `gcAbsorbedBlocks` is memory-bound GC only (correctness lives in the render filter, never in the cache).
- Fault-injection e2e pins the invariants: `tests/e2e/browser/single-timeline-fault-injection.spec.ts` (batch-before-result race, held refetch, /compact shrink).

### How Claude Code JSONL records user messages

Claude Code CLI writes JSONL output (one JSON object per line). User messages appear via 3 patterns:

| Pattern | When | JSONL entries | Reliable? |
|---------|------|---------------|-----------|
| **A** (FIFO mid-stream) | User sends while CLI is running a turn | `queue-operation:enqueue` → `queue-operation:dequeue` → normal `human_turn_start` | Usually, but CLI may finish before reading FIFO |
| **B** (FIFO unprocessed) | FIFO msg not consumed before turn ends | `queue-operation:enqueue` only (no dequeue) — parser synthesizes user msg | Yes (enqueue always logged) |
| **C** (--resume) | No running process → server spawns `claude --resume -p "msg"` | Normal `human_turn_start` | Always |

Server-side parser (`src/core/session-history.ts`): matches enqueue→dequeue pairs (Pattern A skips enqueue, uses the user message that follows). Unmatched enqueues (Pattern B) are synthesized as user messages at their chronological position.

### Optimistic message lifecycle

```
pending → received → delivered → committed → (deduped by persisted history)
```

| Status | Trigger | Meaning | Visual |
|--------|---------|---------|--------|
| `pending` | `send()` | Exists only in React state | Grey |
| `received` | WS RPC response | Server acknowledged, queueId = real messageId | "Queued" badge |
| `delivered` | `session:messages-delivered` event | Written to FIFO or --resume spawned | "Delivered ✓" badge |
| `committed` | `session:batch-completed` → `handleBatchCompleted` | CLI consumed the message | Normal text |
| (hidden) | Render dedup (`consumedQueueIds` sticky set) | Persisted history now contains this message | — |
| (removed) | GC notification effect → `onBatchCompleted(0, ids)` | Post-render cleanup of hidden bubbles | — |

### Dedup logic (critical — was source of a disappearing-message bug)

**Problem:** Text-based dedup against ALL persisted history caused false matches. If the user previously sent "hi" in turn N, and sent "hi" again mid-stream in turn N+1, the new optimistic "hi" was matched against the OLD persisted "hi" and removed.

**Solution (two-tier dedup, `optimistic-dedup.ts`):**

- **Non-committed** (pending/received/delivered): Only dedup against messages that appeared since the **turn watermark** (`messages[watermark..length]`). Old persisted messages cannot absorb new optimistic messages. (The watermark replaced the old `prevMsgLen` freeze dance — it advances only on the `isStreaming` false→true edge, so no per-render bookkeeping.)
- **Committed**: Dedup against ALL persisted messages. Safe because committed = CLI consumed it, so the persisted copy exists somewhere.

Both tiers use multiset (count-based) matching for correctness with duplicate texts, with a `walnutMessageId` id-first pass (echo-claim) before any text matching. Deduped bubbles enter the sticky `consumedQueueIds` set (render tombstone); a post-render effect notifies `useSessionSend` (`onBatchCompleted(0, ids)` — count 0 so the count-fallback path can't misfire) to physically remove them.

### Key files

| File | Role |
|------|------|
| `web/src/stream/stream-reducer.ts` | THE single copy of frontend accumulation semantics (lane isolation, msgId boundary, tool-result backfill). Pure functions. |
| `web/src/stream/render-filter.ts` | Non-destructive absorption: `computeRenderFilter` (hidden set + unmatched diagnostics), `allBlocksAbsorbed` reset gate. |
| `web/src/cache/promote-blocks.ts` | `computeAbsorbedIndices` = the evidence-matching core (id-first, content multiset, join-run, childMessages, bgTaskFinished). `promoteCompletedBlocks` = destructive wrapper used only for cache GC. |
| `web/src/components/sessions/SessionChatHistory.tsx` | Renders persisted + streaming (filtered) + optimistic. Turn watermark. Bubble dedup + GC notification. Timeline interleaving. |
| `web/src/components/sessions/optimistic-dedup.ts` | Bubble dedup (id pass + watermark-windowed multiset). |
| `web/src/hooks/useSessionSend.ts` | Optimistic state machine (pending→committed). |
| `web/src/hooks/useSessionStream.ts` | Streaming blocks from WS (append-only; `resetIfAbsorbed` for memory reclamation). |
| `web/src/cache/session-cache.ts` | Background accumulator for offscreen sessions + history LRU. `gcAbsorbedBlocks` = memory GC only. |
| `web/src/hooks/useSessionHistory.ts` | Fetches persisted history via REST (cursor/delta transport, stale self-heal). Re-fetches on `historyVersion` change. |
| `src/web/session-stream-buffer.ts` | Server-side accumulator twin (language boundary — keep semantics aligned with stream-reducer). |
| `src/core/session-history.ts` | Server-side JSONL parser. Pattern A/B/C handling. |
| `src/providers/claude-code-session.ts` | FIFO write (`writeMessage`), `processNext` (FIFO→--resume fallback). |
| `src/core/session-message-queue.ts` | Disk-backed message queue. Survives server restart. |

## Frontend File Structure

```
web/src/
├── App.tsx              # Routes (see CLAUDE.md routes table)
├── pages/               # MainPage, DashboardPage, SearchPage, SettingsPage,
│                        # TaskDetailPage, ChatPage, CronPage, UsagePage
├── components/
│   ├── chat/            # ChatPanel, ChatInput, ChatMessage
│   ├── tasks/           # TodoPanel, TaskList, TaskCard, TaskForm, SubtaskList
│   ├── context/         # ContextInspectorPanel, ContextSection, ToolCard, ApiMessageBlock
│   ├── sessions/        # SessionPanel (the ONLY session surface), PlanPopup, SessionChatHistory
│   ├── settings/        # SettingsNav, inputs/ (SectionCard, SecretInput, ToggleSwitch, NumberInput,
│   │                    #   ListEditor, KeyValueEditor, StatusIndicator), sections/ (9 section components)
│   ├── memory/          # MemoryTreePanel, MemoryContentPanel
│   ├── usage/           # UsageSummaryCards, UsageDailyChart, UsageBreakdownTable, UsageRecentTable
│   ├── cron/            # Cron job management components
│   ├── layout/          # Sidebar, AppShell
│   ├── search/          # SearchBar, SearchResults (child task display with indentation)
│   └── common/          # EmptyState, LoadingSpinner, StatusBadge, PriorityBadge
├── hooks/               # useTasks, useChat, useWebSocket, useSessionStream, useResizablePanel,
│                        # useSessionHistory, useContextInspector, useCronJobs, useFavorites, useOrdering,
│                        # useUsage, useSettingsConfig, useModalOverlay
├── api/                 # REST client: tasks, sessions, search, config, ws
├── utils/               # Shared utilities (markdown rendering, session-status, time)
└── styles/globals.css   # Theme
```
