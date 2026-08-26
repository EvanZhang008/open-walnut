# Open Walnut — Architecture Deep Dive

> This file is the detailed complement to [CLAUDE.md](./CLAUDE.md). It contains the full implementation docs for each subsystem. Start with CLAUDE.md for orientation; come here when you need specifics.

---

## Architecture Diagram

Event Bus is the backbone. Producers push events in; subscribers react. The Agent uses tools to read/write the Core data layer, which calls into integrations.

```
  Event Producers (push)              Event Bus                 Subscribers (react)
┌─────────────────────┐        ┌─────────────────┐        ┌─────────────────────────┐
│ Claude Code hooks   │──emit─▶│                 │◀──sub──│  Web GUI (React SPA)    │
│  (on-stop,on-compact│        │                 │◀──sub──│  TUI (terminal)         │
│ Cron jobs           │──emit─▶│   Event Bus     │◀──sub──│  CLI                    │
│ MS To-Do sync       │──emit─▶│                 │        │                         │
│ Core mutations      │──emit─▶│  pub/sub        │◀──sub──│  Main Agent             │
│ Chat / Web GUI      │──emit─▶│  dest routing   │        │  (reacts to events,     │
│                     │        │  coalescing     │◀──sub──│   can trigger actions)  │
└─────────────────────┘        └─────────────────┘        │  Session Runner         │
                                                          │  (spawns claude -p)     │
                                                          └────────────┬────────────┘
                                                                       │
                                                            Agent uses tools (~30)
                                                                       │
                                                                       ▼
                                                          ┌────────────────────────┐
                                                          │      Core Layer        │
                                                          │  task-manager          │
                                                          │  memory system         │
                                                          │  search (FTS5)         │
                                                          │  session-tracker       │
                                                          │  chat-history          │
                                                          │  config-manager        │
                                                          │  skill-loader          │
                                                          │  cron scheduler        │
                                                          │  agent-registry        │
                                                          └────────────┬───────────┘
                                                                       │
                                                                       ▼
                                                          ┌────────────────────────┐
                                                          │    Integrations        │
                                                          │  Microsoft To-Do       │
                                                          │  git-sync              │
                                                          │  Claude Code CLI       │
                                                          └────────────────────────┘
```

## Agent Loop Diagram

```
User message
     │
     ▼
buildSystemPrompt()              ◀── memory context + skills + config
     │
     ▼
prepareWithCache()               ◀── prompt caching (Bedrock)
     │
     ▼
sendMessage() to Bedrock         ◀── model: claude-opus-4-6
     │
     ▼
Extract response blocks
     │
     ├── text blocks → return to user
     │
     └── tool_use blocks ──▶ executeTool() ──▶ tool_result
                                                    │
                                              feed back to model
                                              (loop, max 300 rounds)
```

## Session Start Diagram

```
┌─────────────┐     start_session tool      ┌──────────────────┐
│  Agent or   │ ──────────────────────────▶  │  bus.emit(       │
│  User       │                              │  SESSION_START)  │
└─────────────┘                              └────────┬─────────┘
                                                      │
                                             SessionRunner listens
                                                      │
                                                      ▼
                                             ┌──────────────────┐
                                             │ ClaudeCodeSession │
                                             │ spawn('claude',   │
                                             │   ['-p',          │
                                             │    '--output-format│
                                             │    stream-json',  │
                                             │    '--verbose'],  │
                                             │  {detached: true, │
                                             │   stdout→file})   │
                                             └────────┬─────────┘
                                                      │
                                           JsonlTailer reads file
                                                      │
                          ┌───────────────────────────┼────────────────┐
                          │                           │                │
                     system init              assistant msgs      result event
                          │                           │                │
                          ▼                           ▼                ▼
                   claudeSessionId         bus: SESSION_TEXT_DELTA  bus: SESSION_RESULT
                   captured                bus: SESSION_TOOL_USE   persistSessionRecord()
                                           bus: SESSION_TOOL_RESULT
```

## Subagent Flow Diagram

```
Main Agent ──▶ start_subagent tool ──▶ bus: SUBAGENT_START
                                              │
                                     SubagentRunner listens
                                     (semaphore: max 20 concurrent)
                                              │
                                              ▼
                                     resolves AgentDefinition
                                     builds custom system prompt + tools
                                              │
                                              ▼
                                     runAgentLoop() (same code as main agent)
                                              │
                                     ┌────────┴────────┐
                                     ▼                 ▼
                              SUBAGENT_RESULT    SUBAGENT_ERROR
                              → main-ai          → main-ai
```

## Web GUI Diagram

```
Browser (React SPA)                    Server (Express 5)
┌─────────────────┐    HTTP/REST    ┌──────────────────┐
│  pages/          │◀──────────────▶│  routes/          │──▶ Core Layer
│  hooks/          │                │  tasks, sessions, │
│  api/            │    WebSocket   │  search, config,  │
│  components/     │◀══════════════▶│  chat (RPC)       │
└─────────────────┘                └──────┬───────────┘
                                          │
                                   subscribes as 'web-ui'
                                          │
                                          ▼
                                     Event Bus
```

---

## Concurrency & File Locking

JSON data stores (`tasks.json`, `sessions.json`, `chat-history.json`, `config.yaml`) are written by multiple concurrent callers: REST routes, agent loop, cron jobs, session runner, health monitor, and Claude Code hook child processes.

**Two-layer write protection** prevents lost-update races:

1. **In-process promise-chain lock** (`withWriteLock`) — serializes async callers within the Node.js server. Used by `task-manager.ts`, `session-tracker.ts`, `config-manager.ts`, `chat-history.ts`.

2. **Cross-process file lock** (`withFileLock` / `withFileLockSync` in `src/utils/file-lock.ts`) — uses atomic `mkdir` + PID-based stale detection to coordinate between the server and hook child processes. Used by `task-manager.ts`, `session-tracker.ts` (server-side async) and `on-stop.ts`, `on-compact.ts`, `shared.ts` (hook-side sync).

| Store | In-process lock | File lock | Why |
|---|---|---|---|
| `tasks.json` | Yes | Yes | Hooks (`updateTaskFromSession`) write directly |
| `sessions.json` | Yes | Yes | Hooks (`updateSessionStore`, `updateSessionLastActive`) write directly |
| `chat-history.json` | Yes | No | No hook writes to this file |
| `config.yaml` | Yes | No | No hook writes to this file |
| `cron-jobs.json` | Yes (own lock) | No | No hook writes to this file |
| SQLite stores | N/A | N/A | SQLite has its own locking |

3. **Main Agent Turn Queue** (`enqueueMainAgentTurn` in `src/web/agent-turn-queue.ts`) — serializes all main-agent turns that share `chat-history.json` (WS chat, cron main-session). Max concurrency = 1. Callers with independent history (isolated cron, subagents, compaction summarizer) bypass the queue. Session triage runs as a dedicated subagent (not through the main turn queue).

4. **Token Budget Guard** (`guardBudget` in `src/agent/token-budget.ts`) — checks full API payload (system + tools + messages) against 168K budget before each model call (round 1 + every 5th round). If over budget, `emergencyTrim` drops oldest messages while preserving role alternation and tool_use/tool_result pairs.

---

## Data Model — Deep Dive

### Task source routing

`TaskSource = 'ms-todo' | 'local' | string` (extensible via plugins) — **Project is the single grouping layer** (the category tier was removed in the v5 schema migration). Projects live in the `task_projects` SQLite table (name PK COLLATE NOCASE, source, order_index, metadata JSON with default_cwd/default_host/summary/legacy_category/remote_list). Source inference chain: parent → project registry row → input → local. `task_create` takes an optional `project`; an unknown name auto-creates the registry row via `ensureProject` (source `'local'`). A task with no project lives in the **Inbox** (`project = ''`) — the Inbox has no registry row and can never be claimed by a sync provider. Each project has at most one source (409 `ProjectSourceConflictError` on conflict). REST: `GET /api/projects` lists registry rows + counts, `POST /api/projects` creates, `PATCH /api/projects/:name` renames (merge-on-collision), `GET|PUT /api/projects/:name/metadata`.

### Task phase system

`src/core/phase.ts`: 7-state lifecycle: `TODO` → `IN_PROGRESS` → `AGENT_COMPLETE` → `HUMAN_VERIFICATION` → `PEER_CODE_REVIEW` → `RELEASE_IN_PIPELINE` → `COMPLETE`. Phase is source of truth — `applyPhase()` mutates both `task.phase` and `task.status`. `complete_task` sets AGENT_COMPLETE (not COMPLETE) — only the human marks fully done.

### Session slots

Each task has `plan_session_id` and `exec_session_id` (2-slot model). `start_session` checks slots pre-flight and returns `blocked` when occupied. `applyPhase('COMPLETE')` clears both slots.

### Project metadata

Stored in the `task_projects.metadata` JSON blob (`default_host`, `default_cwd`, `summary`, `legacy_category`, `remote_list`). Used by `start_session` for host/cwd resolution. The pre-v5 hidden `.metadata_*` sentinel tasks are retired — the v5 migration folded them into the registry and `addTaskFull` permanently rejects `.metadata*` titles so provider pulls can't re-import them.

### Child tasks

`parent_task_id` links to parent. Children inherit project/source. Parent can't be COMPLETE with non-COMPLETE children (409 error).

### Read / unread

`unread?: boolean`: the read/unread lifecycle for agent work — "the agent produced something the human hasn't looked at yet." Red dot in the UI (task rows, pinned cards, Focus/Satellite cards, the Focus Dock). Driven entirely by the phase machine (`readMarkerForPhase` in `src/core/phase.ts`): a task goes **unread** on `AGENT_COMPLETE` (turn finished) and `AWAIT_HUMAN_ACTION` (errored / needs a decision), and goes **read** on `IN_PROGRESS` (a new turn supersedes it), on `COMPLETE`, and — the actual read event — the moment the human opens the task in the UI. The marker rides the same row write as the phase, so no surface can observe handed-back work without its dot.

There is exactly ONE field and one spelling: read `task.unread`, write `{ unread }`. Never re-derive "unread" from `phase` at a render site: opening a task clears the marker but does *not* change its phase, so a phase-derived surface has no way to go quiet. The field is `unread` rather than `is_read` because an absent value must mean "no dot" — `is_read: undefined` would light up every task that predates the feature. `needs_attention` was the name until 2026-08-09; the v6 SQLite migration rewrites it inside the `payload` blob and `RETIRED_TASK_KEYS` blocks it from ever coming back. External sync still uses `Attention:` on the wire (MS To-Do / Jira body header) — that's an established remote format, not a second local field.

### Task text fields (5-field model)

`description` (what & why, user-set), `summary` (TL;DR, AI-maintained), `note` (markdown blob, append/replace), `conversation_log` (append-only user↔agent log, auto-managed). All fields sync to external integrations (e.g., MS To-Do body, plugin comment fields). See `src/core/AGENTS.md` for field details.

---

## Memory System — Data Flow & Usage

### Layout on disk

```
~/.open-walnut/
├── MEMORY.md                          # Global memory (preferences, facts)
└── memory/
    ├── daily/                         # Time-indexed activity
    │   └── YYYY-MM-DD.md             # One file per day, timestamped entries
    ├── projects/                      # Mirrors task grouping (flattened to single segment by the project-only migration)
    │   └── {project}/MEMORY.md
    ├── repos/                         # Per-repository environment knowledge
    │   └── {slug}/MEMORY.md           # Dynamic learnings (build quirks, conventions)
    ├── sessions/                      # Session summaries (auto-captured)
    │   └── [slug].md
    ├── knowledge/                     # Knowledge articles
    │   └── *.md
    └── memory-index.sqlite            # FTS5 full-text search index
```

**Data flow**: Agent uses `memory` tool → writes to daily log + project memory → memory-watcher detects change → FTS5 reindexed → chunk embeddings reconciled (3s delay) → searchable via hybrid search. Task embeddings update incrementally on `task:created`/`task:updated` events (500ms debounce). On startup, full reconciliation runs in background. On session end, on-stop hook auto-captures session summary + daily log + project memory.

### How the agent uses memory

When the agent's system prompt is built (`src/agent/context.ts`), it includes:
1. **Global memory** — full content of `MEMORY.md`
2. **All project summaries** — YAML frontmatter from every project's `MEMORY.md`
3. **Recent daily logs** — most-recent-first, within a 10k token budget (90-day lookback). Oversized days are truncated by entry boundary (newest entries kept) rather than skipped entirely.

When the agent needs to find something specific, it uses the `search` tool → hybrid search (BM25 keyword + vector similarity via min-max normalized weighted fusion). Three modes: `hybrid` (default), `keyword`, `semantic`. Falls back to keyword-only when Ollama is unavailable.

---

## Agent System — Internals

- **Auth**: Bearer token from `config.yaml` → `AWS_BEARER_TOKEN_BEDROCK` env → AWS credential chain. Auto-retry on 403.
- **Streaming**: Always uses `sendMessageStream()`. Max 300 tool rounds. Auto-continues on `max_tokens` (up to 3x).
- Tools can return text or image content blocks (base64 images for vision model perception).
- **Image compression** (`src/utils/image-compress.ts`): `compressForApi(buffer, mimeType)` auto-compresses images to fit Bedrock's 5 MB base64 limit. Strategy: GIF→WebP (preserves animation), others→JPEG quality 85→30, then halve dimensions up to 3×. Called by `read_file` tool (vision reads) and `hydrateImagePaths()` (chat history). `MAX_BASE64_BYTES = 5_000_000` is exported for consistent guard checks across callers. Requires `sharp` npm package.

### What the agent knows

The system prompt (`src/agent/context.ts`) gives the agent:
- User's name and current date/time
- All project summaries (names, descriptions)
- Recent daily activity logs (10k token budget)
- Global memory content
- Available skills
- Full tool descriptions

This means the agent has context on **all your tasks, all your projects, and your recent activity** — whether work or personal.

See `src/agent/AGENTS.md` for retry/abort/caching/subagent internals.

---

## Skills System — Detail

### Discovery (3 locations, priority order)

```
1. ./skills/             # Workspace-local (highest priority)
2. ~/.open-walnut/skills/      # Walnut global
3. ~/.claude/skills/     # Claude-shared (lowest priority)
```

Each skill is a directory with a `SKILL.md` containing YAML frontmatter (name, description, requires) and markdown instructions.

### Eligibility filtering

Before injecting skills into the prompt, each skill is checked:
- `requires.bins`: Are required commands installed? (`which <bin>`)
- `requires.env`: Are required env vars set?
- `requires.platform`: Does the OS match? (darwin, linux, win32)

Only eligible skills appear in the system prompt as `<available_skills>` XML. The agent reads the SKILL.md of the most relevant skill before responding.

---

## Plugin System

Walnut has one Plugin model. Installing a Plugin means trusting its code. A Plugin can have a full Node server entry, a native React web entry, an optional iframe Webview, or any combination. `server`, `web`, and `webview` are entry points, not permission levels. Full authoring details live in [Plugin development](./docs/reference/plugin-development.md).

### Public contract

An `apiVersion: 1` manifest names `server`, `web`, and optional `webview` artifacts and declares an enforced `engines.walnut` range. The server and web modules export `activate(walnut)`. Authors import only `@open-walnut/plugin-api`; the host injects the runtime services. Legacy manifests without `apiVersion` continue through the old capability adapter.

The Server API has three layers: typed services for common data, stable primitives such as events, ops, HTTP, WebSocket RPC, tools, hooks, cron actions, agents, providers, commands, skills, and sync registration, then an explicitly unstable `unsafe` escape hatch. Full Node access is already available to server code, so Walnut does not pretend these methods are a security boundary.

The Web API runs native Plugin modules in Walnut's browser realm. The host provides the exact React, ReactDOM, and JSX runtime instances used by the console, so Plugin components share one React tree. Live owner-scoped registries feed Apps, standalone pages, Settings sections, injected CSS, and stable Views such as `TaskView`, `ChatView`, `SessionView`, `CalendarView`, `FileView`, `NoteView`, and `TerminalView`.

### App Registry

The console has one App Registry (`web/src/apps/registry.ts`) holding three kinds of row: Core Apps (Home, Tasks, Notes, Calendar, Routines, Settings), native Plugin Apps, and legacy Webviews. The Sidebar, the Settings "Plugins" group, the `/apps/:appId/*` host route, the App Command Palette entries, and the Apps section of Settings all read that one registry, so order, visibility, pinning, badges, and navigation behave the same for a Plugin App as for a built-in screen. There is no fixed dashboard route and no panel grid: an App owns its own screen. Home's Chat, Todo, and Agenda are Dock controls inside Home rather than registry rows.

`walnut.ui.app({ id, title, icon, component, badge, order, fullBleed, placement })` is the atom. The host derives the route `/apps/<pluginId>~<appId>` and every subpath under it, the entry row (in the Sidebar by default, or in the Settings Plugins group when the App declares `placement: 'settings'`), deep links, the palette entry, and the badge channel, then returns a handle carrying `path`, `setBadge(value)`, and `dispose()`. The component receives `basePath`, `subpath`, `search`, and `navigate`. Registration is owner-scoped and path collisions are refused, so a Plugin can neither shadow a Walnut route nor outlive its own disable.

`placement` is a default the user can override per App from Settings → Apps ("Move to Settings" / "Move to Sidebar"), stored alongside their pin, hide, and order preferences and cleared by "Restore defaults". Every surface asks `effectiveAppPlacement(app, preferences)` rather than reading the declared field, so the Sidebar and the Settings nav can never disagree about one row. Core Apps and legacy Webviews are pinned to the Sidebar and offer no override: losing Home or Chat into a settings list is not a choice worth having. Moving a row changes nothing else about the App, which is why the same route, deep links, badge, and palette entry survive the move.

Time tracking is the worked example of a first-party App: the `walnut-time` Plugin (source in `examples/plugins/walnut-time/`) is the ONLY Time UI, and it ships as a builtin so a stock install has it without an install step (`scripts/ship-builtin-plugins.mjs` copies its manifest and web bundle into `dist/integrations/` during the build; `plugins.walnut-time.enabled: false` turns it off). The server side (`/api/time/*`, the heartbeat capture) is untouched by that packaging and is what the App reads.

### Lifecycle and ownership

`PluginManager` runs discovery, compatibility checks, activation, disposal, reload, quarantine, and Safe Mode. Every registration carries its Plugin owner and returns a token-guarded `Disposable`. A disable or reload removes routes, tools, timers, subscriptions, hooks, commands, skills, agents, providers, RPC methods, and UI contributions in reverse registration order. Historical task sources retain inert tombstones so old tasks remain readable.

A boot sentinel records the Plugin that was activating if the process dies. Repeated activation failures quarantine that Plugin only. `WALNUT_PLUGIN_SAFE_MODE=1` or `--plugin-safe-mode` starts Walnut with external Plugins disabled so the user can recover.

### Loading and distribution

Discovery order is built-in Plugins, linked or copied Plugins under `~/.open-walnut/plugins/`, then Plugin Store sources under `~/.open-walnut/plugin-stores/`. The first active id wins and later copies are reported as duplicates. Git sources are pinned by commit. npm sources are installed with lifecycle scripts disabled and record their resolved version and integrity. Updates are explicit; Walnut does not auto-update trusted code.

Native web modules are fetched from authenticated `/api/plugin-runtime` endpoints, content-addressed by SHA-256, and imported as Blob ESM. A cloud companion relays missing modules from the primary and caches them by hash. Plugin HTTP handlers and module relays have size limits and deadlines.

The older iframe APP path remains available as `webview`. It is useful for external pages or content that specifically needs browser isolation, but it is not the default Plugin UI. Its `postMessage` bridge and static-file guards do not sandbox the Plugin's server entry.

### Kernel direction

The long-term Kernel is small: Plugin discovery and lifecycle, owner registries, Event Bus, storage, auth, transport, and the React shell. First-party integrations already use the same `apiVersion: 1` registration path, and other first-party features move one contribution at a time without breaking legacy routes or stored data.

The executable reference is [examples/plugins/walnut-demo](./examples/plugins/walnut-demo), the Walnut Plugin Demo. Its browser surface is one Demo App registered through `ui.app`, one auxiliary `ui.page`, a Settings section, and one injected stylesheet. Its server entry exercises every registry category along with lifecycle cleanup, Tool, Hook, Cron, HTTP, WebSocket RPC, Agent, Provider, storage, secrets, and stable View composition.

Authoring details, including the one-command dev loop, live in [Plugin development](./docs/reference/plugin-development.md).

---

## Claude Code Session Lifecycle — Detail

### Session data model (`sessions.json`)

Session status uses two independent dimensions instead of a flat status field:

```typescript
type ProcessStatus = 'running' | 'stopped';           // Is the OS process alive?
type WorkStatus = 'in_progress' | 'turn_completed'    // What stage is the work at?
               | 'pending_human_review' | 'completed' | 'error';
type SessionMode = 'bypass' | 'accept' | 'default';   // CLI permission mode

interface SessionRecord {
  claudeSessionId: string;     // Claude Code's session UUID
  taskId: string;              // Linked task ID
  project: string;             // Project name
  process_status: ProcessStatus;
  work_status: WorkStatus;
  mode: SessionMode;
  activity?: string;           // Freeform: 'Using Bash', 'implementing', etc.
  last_status_change?: string; // ISO timestamp of last status transition
  startedAt: string;           // ISO timestamp
  lastActiveAt: string;        // ISO timestamp
  messageCount: number;        // Number of messages exchanged
  cwd?: string;                // Working directory
  title?: string;              // One-sentence summary
  pid?: number;                // OS process ID
  outputFile?: string;         // JSONL stream file path
}
```

**Status transitions**: `process_status` is system-managed (spawn → running, exit → stopped). `work_status` transitions automatically on JSONL events (init → in_progress, result → turn_completed, PID death → error) and can be set by the agent tool (`update_session`) for review/completion states. The agent cannot set `in_progress` or `error` directly.

**3-layer session monitoring**: Per-session PID check (3s) → health monitor scan (30s) → startup reconciler. See `src/core/AGENTS.md` for details.

### FIFO stall detection

After writing to the named FIFO, `processNext` starts a 30s timer. If the JSONL output file hasn't grown (Claude CLI stopped reading stdin), the stalled process is killed and respawned via `--resume`. Mid-turn messages can also be injected via FIFO (`injectMidTurn`).

### Resume failure detection

When `--resume <id>` is used, `ClaudeCodeSession` sets `_expectedSessionId = id` before spawning. On the init event, if the returned session ID differs from expected (Claude CLI couldn't resume and started fresh), `renameSessionId()` is called to rename the original record in-place instead of creating a phantom record. This preserves task linkage and history continuity. If the rename fails (ID collision or missing record), a fresh `persistSessionRecord()` is attempted. `outputFile` and PID are also persisted immediately after spawn (before the init event) so early-death sessions leave a traceable record.

For history reading, `readSessionHistory()` tries sources in order: (1) canonical JSONL at `~/.claude/projects/` (local) or via SSH (remote), (2) local streams capture in `SESSION_STREAMS_DIR` (local sessions only — remote sessions have no local output file), (3) direct `outputFile` path from the session record (tmp file not yet renamed). Remote sessions only have source (1) via SSH; if that fails, there is no local fallback.

### AskUserQuestion auto-intercept

In `-p` mode, `AskUserQuestion` tool calls never reach the user. When detected in the JSONL stream, a corrective message is auto-injected via FIFO telling Claude to use text output instead. Fires once per turn (`_askUserIntercepted` flag, reset on new message). Skipped during JSONL replay (`suppressResults` guard).

### Hooks: knowledge capture on session end

- **on-stop hook** (`src/hooks/on-stop.ts`): Runs when a Claude Code session ends. Reads stdin (hook protocol), extracts session summary from the Claude session directory, saves it as markdown, sets `work_status: 'completed'`, `process_status: 'stopped'`, updates linked task notes, appends to daily log and project memory.
- **on-compact hook** (`src/hooks/on-compact.ts`): Runs when Claude Code compacts context. Saves intermediate session summary (checks `work_status === 'in_progress'`), updates `sessions.json` lastActiveAt, appends to daily log.

Both hooks run silently (no stdout/stderr) and use the Claude Code hook protocol (read stdin to completion, then execute).

---

## Session Lifecycle Hooks — Detail

A pluggable hook system that reacts to session bus events. Replaces hardcoded triage dispatch in `server.ts` with a global bus subscriber pattern.

**Session hook points** (10): `onSessionStart`, `onMessageSend`, `onTurnStart` (derived: first response after send), `onToolUse`, `onToolResult`, `onPlanComplete` (derived: ExitPlanMode), `onModeChange` (derived), `onTurnComplete`, `onTurnError`, `onSessionWillReap` (the idle reaper is about to kill this session: once per idle episode, `remainingMs` 0 to 5 min). There is deliberately no `onSessionEnd` / `onSessionIdle`: `session:ended` fires after every turn, so hooks bound to it ran per-turn. See [no session-end gist](./docs/decision/no-session-end-gist.md).

**Dispatcher** (`dispatcher.ts`): Subscribes as `'session-hooks'` with `{ global: true }`. Fast-path skips non-`session:*` events. Maps events to hook points, builds context via `PayloadBuilder` (10s TTL cache), dispatches matching hooks in parallel with `Promise.allSettled`. Per-handler timeout (30s default, 120s for agents). Error isolation: one failing hook never blocks others. Infinite loop guard: skips `session:result`/`session:error` with `source === 'subagent-runner'`.

**Built-in hooks** (`builtins.ts`): `session-triage` (priority 50, dispatches triage subagent on `onTurnComplete`) and `session-error-notify` (priority 90, logs errors on `onTurnError`). Both can be disabled/overridden via `config.session_hooks.overrides`.

**File-based hooks** (`discovery.ts`): Scans `~/.open-walnut/hooks/*.mjs` for modules exporting `describe()` → descriptor and `handle()` → handler. Same pattern as action system.

**Filtering**: Hooks can specify `filter: { modes, projects }`. Strict mode: denies when filter is specified but context is missing (prevents unintended dispatch).

**Config** (`config.yaml` → `session_hooks`): `overrides` (per-hook enable/disable/priority/timeout). `idleTimeoutMs` is a deprecated no-op (it configured the removed `onSessionIdle`); the idle reap threshold lives in `session.idle_timeout_minutes`.

**Typed event payloads** (`src/core/event-types.ts`): All 35+ bus events have typed payload interfaces in `EventPayloadMap`. Use `eventData<'event:name'>(event)` instead of manual `as {...}` casts. Re-exported from `event-bus.ts`.

---

## Heartbeat System — Implementation

**Checklist CRUD**: AI tools `get_heartbeat_checklist` / `update_heartbeat_checklist` (in `src/agent/tools/heartbeat-tools.ts`) and REST endpoints `GET/PUT /api/heartbeat/checklist` (in `src/web/routes/heartbeat.ts`) both use shared `readHeartbeatChecklist()` / `writeHeartbeatChecklist()` from `src/heartbeat/checklist-io.ts`. Settings page (`web/src/pages/SettingsPage.tsx`) has a textarea editor for HEARTBEAT.md.

**Key files**: `src/heartbeat/` (types, runner, checklist-io, barrel), `src/web/routes/heartbeat.ts` (REST), `src/web/server.ts` (integration), `web/src/hooks/useChat.ts` (WS handler), `web/src/components/chat/ChatMessage.tsx` (rendering), `web/src/styles/globals.css` (styling).

---

## Cron Job System — Detail

### Directory layout

```
src/core/cron/
├── index.ts       # Barrel + normalization helpers
├── types.ts       # CronJob, Schedule, Payload interfaces
├── store.ts       # JSON file persistence (~/.open-walnut/cron-jobs.json)
├── schedule.ts    # Schedule evaluation (at, every, cron expr)
├── timer.ts       # Timer management (setTimeout-based)
├── service.ts     # CronService class — main orchestrator
├── jobs.ts        # Built-in job definitions
├── ops.ts         # Job execution logic
└── normalize.ts   # Input validation & normalization
```

### Init Processor

`InitProcessor`: Optional pre-step that runs a file-based action before the payload. Configured via `job.initProcessor` with fields: `actionId`, `timeoutSeconds?`. Target agent and model are now job-level fields (`job.targetAgent`, `job.targetAgentModel`). Two execution modes in `timer.ts`: (1) `job.targetAgent` set → action output piped to a subagent directly (terminal, supports multimodal image+text), (2) no targetAgent → action output injected as context into the payload text/message. Legacy `payload.kind === 'action'` jobs are auto-migrated to `initProcessor` + job-level fields on store load (`store.ts`) and via backward-compat normalization (`normalize.ts`). `job.tag` provides stable job identification (e.g. `'screenshot-track'`).

### Action System

`src/actions/`: File-based action discovery mirroring the agent registry pattern. Actions are discovered from two locations: built-in (`dist/actions/*.js`, compiled from `src/actions/*.ts`) and user (`~/.open-walnut/actions/*.mjs`). Each module exports `describe()` → `ActionDescriptor` and `run(ctx)` → `ActionResult { invoke, content?, image? }`. User actions override built-in actions with the same ID. Platform filtering via `descriptor.platform`. REST: `GET /api/cron/actions` lists discovered actions. Frontend: CronJobForm has an "Init Processor" checkbox with action dropdown (showing source badges), target agent, and model override fields.

---

## Embedded Subagent System — Implementation

**How it works**: `SubagentRunner.init()` subscribes as `'subagent-runner'` on the bus. On `SUBAGENT_START`, it resolves the agent definition, acquires a semaphore slot, loads context sources (if `taskId` present and agent has `context_sources` config), builds a custom system prompt and tool set, and calls `runAgentLoop()` with `cacheConfig: false`. Results are emitted back to the main agent via `SUBAGENT_RESULT`. Usage is tracked per-run with `source: 'subagent'`.

**Key files**:
- `src/core/agent-registry.ts` — manages agent definitions from 3 sources: builtin ("general", "session-triage"), config-defined (`config.yaml`), runtime-created (`agents.json`). **Builtin override**: editing a builtin agent auto-creates a config entry with the same ID that shadows it (`overrides_builtin: true`); deleting the override restores the original builtin.
- `src/providers/subagent-runner.ts` — `SubagentRunner` class, subscribes to bus events, manages runs with semaphore-limited concurrency (max 20)
- `src/agent/subagent-context.ts` — builds system prompts and filtered tool sets for subagents
- `src/agent/context-sources.ts` — `loadContextSources()` — injects task/project/memory context into subagent system prompts
- `src/agent/tools/agent-crud-tools.ts` — CRUD tools for managing agent definitions

### Turn-complete triage (no subagent anymore)

There is **no** triage subagent. The old summarizer subagent was removed: the session itself now writes the merged task summary via `side_question`, and the phase/notify decision comes from a deterministic `PHASE_SIGNAL` lookup in `src/core/session-hooks/builtins.ts` (`decideNotify`). The id `turn-complete-triage` survives only as an `agentId` label on notification events so the notify gate, UI rendering, and usage classification keep working — see the deletion notes in `src/core/agent-registry.ts`. Do not re-introduce a summarizer subagent without reading those notes first.

### Auto-inference & stateful memory

`task_details` and `project_memory` always load when `taskId` is present, regardless of `context_sources` config. Other sources must be explicitly enabled.

`project_memory` reads the **legacy** `memory/projects/<project>/MEMORY.md` store (the project-only migration flattened the old `<category>/<project>/` layout, merging on collision). The 2026-07 unification moved project knowledge to skills and stopped writing here, but did not migrate the existing files — so this source still returns real content for pre-migration projects and nothing for anything newer. It is read-only; put new project knowledge in a skill.

Context sources are **read-only** injection at invocation time. `stateful` config is **read+write** persistent memory across invocations. An agent can have both. `stateful.memory_project` supports `{auto}`, resolved at runtime to the task's `{project}` (or `inbox` when the task has none).

---

## Event Bus — Implementation

- **Class**: `EventBus`. Singleton `bus`.
- **Named subscribers**: `bus.subscribe('web-ui', handler)` — subscribe/unsubscribe by name. Error isolation: one failing subscriber never blocks others.
- **Destination routing**: Events with `destination` field go only to that subscriber. Unaddressed events fan out to all.
- **CoalescingQueue** — batches high-frequency events (AI streaming tokens) into periodic flushes (250ms urgent, 60s normal). Prevents N events → N redundant UI updates.

---

## Logging — Subsystem Loggers

**Subsystem loggers**: `log.bus`, `log.agent`, `log.session`, `log.subagent`, `log.web`, `log.ws`, `log.hook`, `log.task`, `log.memory`, `log.usage`, `log.heartbeat`. Child loggers: `log.agent.child('loop')` → tag `agent/loop`.

See `src/logging/AGENTS.md` for code examples, log levels, and redaction patterns.

---

## Usage Tracking — Implementation

**Components**:
- `types.ts` — `UsageRecord`, `UsageSummary`, `UsageSource` (agent, agent-cli, subagent, compaction, image-tool, session, perplexity, glm, heartbeat, cron, triage). `parent_source` optional field tracks which source invoked a subagent (e.g. subagent called from 'cron' records `parent_source: 'cron'`).
- `pricing.ts` — Multi-provider pricing table (Claude, GLM-4, Perplexity) with substring pattern matching on model IDs. `computeCost()` computes from tokens; `external_cost_usd` overrides when provided (e.g. session costs from Claude Code CLI).
- `tracker.ts` — `UsageTracker` class with `record()`, `getSummary()`, `getDailyCosts()`, `getBySource()`, `getByModel()`, `getRecentRecords()`, `prune()`. Uses parameterized SQL queries.
- `index.ts` — Barrel + singleton `usageTracker` instance (lazy DB init).

**Instrumentation**: Every `usageTracker.record()` call is wrapped in `try/catch` to prevent non-critical tracking failures from crashing the agent loop. Call sites: web chat, CLI chat (interactive + one-shot), compaction, subagent runner, image tool, cron agent turns, session triage, session:result handler.

**REST API**: `src/web/routes/usage.ts` — 6 GET endpoints: `/api/usage/summary`, `/api/usage/daily`, `/api/usage/by-source`, `/api/usage/by-model`, `/api/usage/recent`, `/api/usage/pricing`.

**Admin page**: `/usage` — summary cards, SVG daily chart, source/model breakdowns, cache efficiency stats, recent activity table. No external chart library.

---

## Web GUI — Server Setup

- **Start**: `open-walnut web` (`src/commands/web.ts`). Default port 3456.
- **Server**: `startServer()` at `src/web/server.ts`. Same port: REST + static files + WebSocket.
- **WebSocket**: `attachWss()` at `src/web/ws/handler.ts`. Server subscribes to bus as `'web-ui'` and broadcasts events to all browsers.
- **REST routes**: `src/web/routes/` — tasks, sessions, search, memory, config, projects, dashboard, cron, chat-history, session-chat, context-inspector, favorites, ordering, local-image.
- **React SPA**: Vite → `dist/web/static/`. Root: `web/src/App.tsx`.

See `web/src/AGENTS.md` for detailed UX implementation (message isolation, task references, image rendering, session streaming, slash commands, etc.).

---

## CLI — an HTTP client, never a second writer

`open-walnut add|tasks|done|recall|projects|sessions|start|tools` are HTTP clients of the running server's `/api/v1` facade (`src/utils/api-client.ts`; base URL `OPEN_WALNUT_API_URL`, default `http://127.0.0.1:3456`). They used to import `core/task-manager` and write SQLite from the CLI process, which made every invocation a SECOND WRITER racing the server — two processes each holding a stale in-memory store delete each other's rows. The server is now the single writer; localhost requests bypass auth, so no token plumbing is needed.

- **One interface, one rule (2026-08-20):** the bin shim (`bin/open-walnut.js`) routes every DATA command above to the slim `dist/cli-fast.js` entry (~75KB, ~0.2s total), because their real work is one local HTTP request and the full bundle costs ~0.5s of boot first (tsup builds `dist/cli.js` as one unsplit 6.3MB file that eagerly loads the web-server graph). Process-owning/interactive commands (`web`, `mcp`, `chat`, `sync`, `backup`, `logs`, `device`, `lists`, `subtask`, `session-server`) stay on the full entry — they live seconds-to-forever, so boot cost is irrelevant. Humans and agents share the same path; the split is by what the command does, not who runs it. The `LITE` set in the bin shim mirrors `LITE_COMMANDS` in `src/cli-fast.ts` — keep in sync.
- Task-mutating commands (`add`, `done`) print a `<task-ref id="…" label="…"/>` line so an AI session running them through Bash can cite the task (the web UI renders these as clickable pills). `--json` carries the same string in a `ref` field. Tag construction lives in `taskRefTag()` (`src/utils/entity-refs.ts`), next to the regex that parses it back.
- Server down → ONE friendly line ("start it with: open-walnut web") + exit 1, never a stack trace (`reportApiError`).
- `WALNUT_CLI_DIRECT=1` is the rollback lever: each data command falls back to its original in-process path. Those legacy implementations live together in `src/commands/direct-commands.ts` and are installed at boot ONLY by the full entry (`src/cli.ts`) through the `src/commands/direct-registry.ts` seam — a data command file must never name the direct module, or the bundler inlines core/task-manager into the slim bundle and re-inflates every call (this is measured: one literal import = 75KB → 6.3MB). The bin shim routes `WALNUT_CLI_DIRECT=1` invocations to the full entry. Anything that must run against an isolated temp store (the `tests/commands/*` CLI-subprocess tests) MUST set it — otherwise the child talks to production :3456; tests importing command modules directly must also call `installDirect()` first (the registry fails loud instead of silently writing to prod).
- `open-walnut start <task_id>` posts to `POST /api/v1/tasks/:id/start` so the SESSION_START emit happens in the process that owns the session-runner. Core: `src/core/sessions/task-start.ts` (shared with the direct path). `POST /api/v1/sessions` can't serve this — its body requires an absolute `cwd`, while `start` names only a task and lets the runner resolve cwd from the task/project chain.
- `open-walnut done` posts to `POST /api/v1/tasks/:id/complete`, NOT `PATCH {status:'done'}`: only `completeTask()` auto-unpins from the Focus bar and awaits the external-sync push.
- Out of scope (still direct, by design): `chat`, `web`, `logs`, `sync`, `auth`, `device`, `dashboard`, `session-server`, and the legacy `subtask`/`lists` stubs.

---

## Testing — Full Guide

See `AGENTS.md` (root) for the full test pyramid, tier descriptions, and test quality checklist.
See `tests/AGENTS.md` for test pyramid details, config tables, mock patterns, coverage matrix, and Playwright setup.

### Test design checklist

1. **Data flow**: Trace the full path (REST → Core → bus → WS → client)
2. **Persistence**: POST then GET to confirm state changed
3. **State transitions**: Valid + invalid transitions
4. **Boundary conditions**: Empty, missing, duplicate, first-time
5. **Multi-client**: WS events reach 2+ clients
6. **Error paths**: Bad IDs, missing fields, spawn failures

### What makes a bad test

- Mocks everything — passes even when real code is broken
- Tests internals — asserts on private methods instead of observable behavior
- No persistence check — POST succeeds but never verifies via GET
- No error paths — only tests happy path

### 5 test tiers

Unit (`tests/core/`, `tests/agent/`) → Integration (`tests/web/routes/`, supertest) → E2E (`tests/e2e/`, real server+WS) → Browser (`tests/e2e/browser/`, Playwright) → Live (`*.live.test.ts`, real APIs).

### What "real" means

- **Real server**: Express on random port (`startServer({ port: 0, dev: true })`)
- **Real event bus, WebSocket, disk I/O**: Temp directory via `vi.mock('../../src/constants.js', ...)`
- **Only mock**: Claude CLI binary → `tests/providers/mock-claude.mjs`
- **Skip if no creds**: External APIs (MS To-Do, Bedrock) skipped when credentials absent
