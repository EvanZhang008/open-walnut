# Web GUI — Implementation Details

For architecture overview and routes, see project `CLAUDE.md`.

## UX Implementation Details

- **Source-aware message isolation**: Streaming agent responses from different sources (heartbeat, cron, triage, user-chat) render as separate message blocks. `useChat` tracks `currentSourceRef` during streaming and passes it to `upsertLastAssistant` which only merges into the last assistant message if the source matches. The turn-merger in `chatEntriesToMessages` checks `entry.source` boundaries to prevent cross-source merging on history reload.
- **Rich task references**: Session result/error messages use `[taskId|Project / Title]` format rendered as clickable pills via a custom `marked` inline extension (`ChatMessage.tsx`). Backend enriches events with task metadata (`resolveTaskRef()` in `server.ts`); frontend builds the format via `buildTaskRef()` in `useChat.ts`. Entity refs (`<task-ref>`, `<session-ref>`) also render as clickable pills. On MainPage, clicking a task ref focuses it in TodoPanel (auto-switches tab, expands groups, scrolls into view) and clicking a session ref opens the inline SessionPanel + focuses the linked task — no page navigation.
- **Inline image rendering**: Image paths in markdown text are rendered as `<img>` tags via three mechanisms in `ChatMessage.tsx`: (1) `imagePath` inline extension for bare paths in text, (2) `link` renderer override for `[text](/api/images/...)` markdown links, (3) `codespan` renderer for backtick-wrapped paths. The `link` renderer only matches local paths (`href.startsWith('/')`) to avoid hijacking external URLs. `/api/images/` URLs render directly; absolute file paths proxy through `GET /api/local-image?path=...` (`src/web/routes/local-image.ts`) with extension whitelist, traversal protection, and 50MB size limit. Clicking any image opens a lightbox modal (`Lightbox.tsx`). Works in chat, session history, and session streaming views via the `marked` singleton.
- **Tool result image rendering**: `GenericToolCall` in `SessionMessage.tsx` auto-detects images in tool results via three mechanisms: (1) Anthropic content-block JSON with `type:"image"` + base64 data → renders as `<img src="data:...">`, (2) file paths ending in `.png/.jpg/.gif/.webp` in result text → renders via `/api/local-image` proxy, (3) input `file_path`/`path`/`filename` pointing to image files → shows preview when result has no images. **Relative paths** (e.g., `screenshot.png` from Playwright) are resolved using the session's `cwd` via `resolveImagePath()` — the `sessionCwd` prop threads through `SessionChatHistory` → `SessionMessage` → `GenericToolCall`. Detection utilities in `web/src/utils/markdown.ts` (`extractContentBlockImages`, `findImagePaths`, `isImageFilePath`, `resolveImagePath`). Result prop merges streaming (`result` prop) and persisted history (`tool.result` field) paths. Images constrained to panel width via `max-width: 100%`; lightbox click-to-zoom via existing `data-lightbox-src` delegation.
- **Session streaming**: Backend-buffered per-session streaming. `SessionStreamBuffer` (`src/web/session-stream-buffer.ts`) accumulates blocks in memory; `session:stream-subscribe` RPC returns a snapshot. All stream events broadcast to all WebSocket clients — frontend filters by `sessionId` (supports multi-panel streaming). `useSessionStream` hook handles subscribe-on-switch with catch-up. Streaming tool calls reuse `GenericToolCall` from `SessionMessage.tsx` (same expand/collapse as history) — `status` prop drives icon/class (`calling`→`done`→`error`), `result` prop renders when available.
- **Session message queue**: Persistent disk-backed queue (`src/core/session-message-queue.ts`) for session chat. Messages enqueued as `pending`, drained and combined by `SessionRunner.processNext()`, cleared after `session:result`. Supports edit/delete of pending messages. Survives server restart (at-least-once delivery).
- **Session image support**: Session chat inputs reuse the main `ChatInput` component (with `showCommands={false}` and custom `placeholder`). Images are pasted/dropped/attached client-side, sent as base64 via WS RPC, saved to `~/.walnut/images/` server-side, and their file paths are embedded in the message text.
- **Session columns on home page**: Up to 3 session panels displayed side by side between chat and ToDo (`MainPage.tsx`). `sessionColumns: string[]` queue with FIFO eviction. Triage takes the first column slot, reducing session max to 2 when open. Panel area width graduates by column count (35%→45%→55%) via `useResizablePanel.setPct()`. Chat panel toggleable via Focus Dock button. Session pills gain `isActive` prop to highlight open columns. Legacy single-session `sessionStorage` key auto-migrates to array format. Each `SessionPanel` instance streams independently (WS broadcasts all events, frontend filters by sessionId). Session pills use a three-layer badge format: `Session · Plan/Bypass · WorkStatus / ProcessStatus` — the outer label is always "Session" (unified naming), inner mode shows Plan or Bypass. Clicking the pill directly opens the session panel (one-click via `stopPropagation`). The initial prompt (first user message) renders at the top of the session chat timeline. Mode indicators in `SessionDetailPanel` and `SessionRow` use muted labels (`📋 Plan` / `⚡ Bypass`) instead of blue accent badges.
- **Focus Dock pin state**: Shared via `FocusBarContext` (`web/src/contexts/FocusBarContext.tsx`), provided in `AppShell` inside `TasksProvider`. Both `AppShell` (renders `FocusDock`) and `MainPage` (provides pin/unpin to `TodoPanel`) consume the same context — ensures optimistic pin/unpin updates are instant (~6ms) rather than waiting for API round-trips. The `useFocusBar` hook only re-fetches on `config:changed` events with `key === 'focus_bar'` to avoid stale-config races from other config writers. **No pin count limit** — users can pin any number of tasks; Focus Dock renders only the first 3 (`FOCUS_DOCK_MAX_VISIBLE` in `FocusDock.tsx`), while TodoPanel's pinned section shows all.
- **Search child task expansion**: Search results include `parentTaskId` and `isAutoExpanded` from the backend (`src/core/search.ts`). When a parent task matches, its children are auto-inserted after it with `isAutoExpanded: true`. Frontend `SearchResults.tsx` renders children with `↳ Child` badge, left-indent (`search-result-child` CSS), and an `auto` badge for auto-expanded items.
- **Segmented filter bars**: TodoPanel uses joined segmented controls (not dropdowns) for Priority, Phase, Session, and Source filters. Icons use a unified minimalist set (○ ◐ ✓ [person-svg] ⋈ ▷ ✓✓) consistent across `PHASE_ICON`, `StatusBadge`, and filter chips. AWAIT_HUMAN_ACTION uses an SVG `PersonIcon` component (`PersonIcon.tsx`) instead of a Unicode character. Icon maps are `Record<string, ReactNode>` to support mixed string/JSX icons.
- **Slash commands**: Dual-layer system — hardcoded frontend commands (`/compact`, `/plan`, `/sessions`, `/tasks`) + markdown-based commands (built-in `.md` in `src/data/slash-commands/` + user-created in `~/.walnut/commands/`). User commands override built-in by name. Backend: `src/core/command-store.ts`, `src/web/routes/commands.ts`. Frontend: `web/src/commands/` (registry + markdown-bridge), `/commands` page.
- **Session slash command autocomplete**: Session inputs (`SessionPanel`, `SessionsPage`) show a command palette when typing `/`. Aggregates 4 sources: skills, Walnut commands, `~/.claude/commands/` (root), `{cwd}/.claude/commands/` (project). Backend: `GET /api/slash-commands?cwd=...` (`src/web/routes/slash-commands.ts`). Frontend: `useSlashCommands` hook with cwd-based caching and ranked search (name prefix > name contains > description contains). `ChatInput` supports `sessionCommands` prop — selecting inserts text instead of executing. Source badges show origin (Skill, Walnut, Claude, Project).
- **Plan content rendering**: In session chat, `ExitPlanMode` renders as a `PlanCard` — an accent-bordered, collapsible card with formatted plan markdown. Plan content resolved from `ExitPlanMode.input.plan` (primary) or from a preceding `Write` to `~/.claude/plans/` (fallback). Components: `PlanCard` and `CollapsedPlanWrite` in `SessionMessage.tsx`. **Live updates**: `PlanCard` consumes `PlanContentContext` (provided by `SessionDetailPanel`) to show live plan content from `useSessionPlan` polling — this bypasses `memo()` on `SessionMessage` so both the top `PlanPreviewSection` and bottom chat `PlanCard` auto-refresh when the plan file changes. Context: `web/src/contexts/PlanContentContext.ts`. **Expand features**: `PlanCard` header has a hover-reveal expand button that opens `PlanPopup` (60vw centered popup via portal). `SessionPanel` header has an expand button that promotes the panel to 95vw×95vh fullscreen via `useFullscreen` (CSS class toggle — no new component instance). `PlanPopup` shares `useModalOverlay` for ref-counted scroll lock + Escape support; `useFullscreen` participates in the same scroll-lock ref count via the exported `lockScroll`/`unlockScroll` from `useModalOverlay.ts`. z-index: session=9000, plan=9100, lightbox=9999.
- **Fork in Walnut button**: `SessionCopyButtons.tsx` includes a "Fork in Walnut" accent button (`.session-fork-btn`) that calls `POST /api/sessions/:id/fork` with `create_child_task: true`. Backend auto-creates a child task (inheriting category/project/source from the parent) then forks the session. On success, navigates to `/tasks/{newChildId}`. Wired into both `SessionPanel` and `SessionDetailPanel`.
- **Quick Add behavior**: The "Quick add task..." form in `TodoPanel.tsx` always creates tasks under `Inbox / Quick Start` (hardcoded `category` + `project`). After creation: if on the All tab, stays (task visible); any other tab (Star, category tabs) auto-switches to the Inbox tab. The new task is auto-focused and scrolled into view via `onFocusTask`. A `focusHandledRef` prevents race conditions when the task arrives via WebSocket after `focusedTaskId` was set.
- **Multi-level child task nesting**: `TodoPanel.tsx` computes `depthMap` (task ID → nesting depth) via recursive parent-chain walk in the child-task `useMemo`. `isChildHidden` walks the full ancestor chain — collapsing any ancestor hides all descendants. Depth-based `paddingLeft` (20px per level, max depth 10) replaces the old fixed `.todo-panel-item-child` CSS class for unlimited nesting support.
- **Memory Browser** (`/memory`): Split-view page for browsing and editing all memory files. Left panel (`MemoryTreePanel`) shows collapsible sections (Global, Daily Logs, Projects, Sessions, Knowledge) with filter input. Right panel (`MemoryContentPanel`) renders selected file as markdown with an Edit toggle — clicking Edit switches to a monospace textarea for raw markdown editing with Save/Cancel buttons and keyboard shortcuts (Cmd+S, Escape). Edit state resets on file switch. Backend: `GET/PUT /api/memory/browse|global` + `GET/PUT /api/memory/*` (path-based with traversal protection). URL state via `?path=` query param. Resizable left panel with localStorage persistence.

- **Browser console log persistence**: `web/src/utils/browser-logger.ts` monkey-patches `console.log/info/warn/error` to persist browser logs to disk. Initialized in `main.tsx` before React mount. Logs sent via WS RPC `browser:logs` (batched every 2s or 50 entries) with `sendBeacon` fallback on page unload. Backend writes to the same log file (`subsystem: 'browser'`). View with `walnut logs -s browser`. See `src/logging/AGENTS.md` for full details on investigating frontend issues.

## Session Chat — Optimistic Messages & JSONL Lifecycle

Session chat renders two data sources: **persisted JSONL history** (server-parsed from Claude Code output files) and **optimistic messages** (client-side state in `useSessionSend`). The core challenge is showing user messages immediately (optimism) and gracefully transitioning to persisted data when the turn completes, without duplicates or disappearances.

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
| (removed) | Dedup filter | Persisted history now contains this message | — |

### Dedup logic (critical — was source of a disappearing-message bug)

**Problem:** Text-based dedup against ALL persisted history caused false matches. If the user previously sent "hi" in turn N, and sent "hi" again mid-stream in turn N+1, the new optimistic "hi" was matched against the OLD persisted "hi" and removed.

**Solution (two-tier dedup):**

- **Non-committed** (pending/received/delivered): Only dedup against messages that appeared since `prevMsgLen` (`messages[prevMsgLen..length]`). Old persisted messages cannot absorb new optimistic messages.
- **Committed**: Dedup against ALL persisted messages. Safe because committed = CLI consumed it, so the persisted copy exists somewhere.

Both tiers use multiset (count-based) matching for correctness with duplicate texts.

**`prevMsgLen` update timing:** In the `useLayoutEffect` that handles batch completion, `prevMsgLen` is intentionally NOT updated. The state changes from `clear()` and `onBatchCompleted()` trigger re-renders that must still see the old `prevMsgLen` to correctly dedup committed messages against newly appeared persisted messages. `prevMsgLen` updates only in the `else` branch (non-batch renders).

### Key files

| File | Role |
|------|------|
| `web/src/components/sessions/SessionChatHistory.tsx` | Renders persisted + optimistic. Dedup logic. Timeline interleaving. Turn boundary cleanup. |
| `web/src/hooks/useSessionSend.ts` | Optimistic state machine (pending→committed). `handleBatchCompleted` clears old committed + promotes new. |
| `web/src/hooks/useSessionStream.ts` | Streaming blocks from WS. `clear()` resets blocks on turn boundary. |
| `web/src/hooks/useSessionHistory.ts` | Fetches persisted history via REST. Re-fetches on `historyVersion` change. |
| `src/core/session-history.ts` | Server-side JSONL parser. Pattern A/B/C handling. |
| `src/providers/claude-code-session.ts` | FIFO write (`writeMessage`), `processNext` (FIFO→--resume fallback), stall detection. |
| `src/core/session-message-queue.ts` | Disk-backed message queue. Survives server restart. |

## Frontend File Structure

```
web/src/
├── App.tsx              # Routes (see CLAUDE.md routes table)
├── pages/               # MainPage, DashboardPage, SearchPage, SessionsPage, SettingsPage,
│                        # TaskDetailPage, ChatPage, CronPage, UsagePage
├── components/
│   ├── chat/            # ChatPanel, ChatInput, ChatMessage
│   ├── tasks/           # TodoPanel, TaskList, TaskCard, TaskContextBar, TaskForm, SubtaskList
│   ├── context/         # ContextInspectorPanel, ContextSection, ToolCard, ApiMessageBlock
│   ├── sessions/        # SessionTreePanel, SessionDetailPanel, SessionPanel, PlanPopup, SessionChatHistory, SessionRow
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
