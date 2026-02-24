# Walnut — Architecture Deep Dive

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

`TaskSource = 'ms-todo' | 'local' | string` (extensible via plugins) — categories are first-class citizens stored in `tasks.json` `store.categories` (v3 migration populates from config + existing tasks on first read). Source inference chain: parent → store.categories → existing tasks → input → ms-todo default. **Strict agent validation**: `create_task type=task` requires category to exist in store.categories (and project to exist) — prevents AI-hallucinated categories. Use `create_task type=category` / `type=project` to create them first. REST routes bypass this (auto-ensure in `addTask`). Each category must contain only one source type (409 on conflict). REST: `GET /api/categories` returns source per category, `POST /api/categories` creates one, `POST /api/categories/:name/source` sets source.

### Task phase system

`src/core/phase.ts`: 7-state lifecycle: `TODO` → `IN_PROGRESS` → `AGENT_COMPLETE` → `HUMAN_VERIFICATION` → `PEER_CODE_REVIEW` → `RELEASE_IN_PIPELINE` → `COMPLETE`. Phase is source of truth — `applyPhase()` mutates both `task.phase` and `task.status`. `complete_task` sets AGENT_COMPLETE (not COMPLETE) — only the human marks fully done.

### Session slots

Each task has `plan_session_id` and `exec_session_id` (2-slot model). `start_session` checks slots pre-flight and returns `blocked` when occupied. `applyPhase('COMPLETE')` clears both slots.

### Project metadata

Hidden `.metadata` tasks per project with YAML config (e.g., `default_host`, `default_cwd`). Used by `start_session` for host/cwd resolution. Filtered from query results and UI.

### Child tasks

`parent_task_id` links to parent. Children inherit category/project/source. Parent can't be COMPLETE with non-COMPLETE children (409 error).

### Needs-attention

`needs_attention?: boolean`: Synced flag for "needs human input." Set by triage agent on session end. Red dot in UI. Auto-cleared on task focus or completion.

### Task text fields (5-field model)

`description` (what & why, user-set), `summary` (TL;DR, AI-maintained), `note` (markdown blob, append/replace), `conversation_log` (append-only user↔agent log, auto-managed). All fields sync to external integrations (e.g., MS To-Do body, plugin comment fields). See `src/core/AGENTS.md` for field details.

---

## Memory System — Data Flow & Usage

### Layout on disk

```
~/.walnut/
├── MEMORY.md                          # Global memory (preferences, facts)
└── memory/
    ├── daily/                         # Time-indexed activity
    │   └── YYYY-MM-DD.md             # One file per day, timestamped entries
    ├── projects/                      # Mirrors task hierarchy
    │   └── {category}/{project}/MEMORY.md
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
2. ~/.walnut/skills/      # Walnut global
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

For history reading, `readSessionHistory()` accepts an `outputFile` fallback — if the canonical `~/.claude/projects/` path and the local stream capture both miss, it tries the `outputFile` path stored on the session record directly.

### AskUserQuestion auto-intercept

In `-p` mode, `AskUserQuestion` tool calls never reach the user. When detected in the JSONL stream, a corrective message is auto-injected via FIFO telling Claude to use text output instead. Fires once per turn (`_askUserIntercepted` flag, reset on new message). Skipped during JSONL replay (`suppressResults` guard).

### Hooks: knowledge capture on session end

- **on-stop hook** (`src/hooks/on-stop.ts`): Runs when a Claude Code session ends. Reads stdin (hook protocol), extracts session summary from the Claude session directory, saves it as markdown, sets `work_status: 'completed'`, `process_status: 'stopped'`, updates linked task notes, appends to daily log and project memory.
- **on-compact hook** (`src/hooks/on-compact.ts`): Runs when Claude Code compacts context. Saves intermediate session summary (checks `work_status === 'in_progress'`), updates `sessions.json` lastActiveAt, appends to daily log.

Both hooks run silently (no stdout/stderr) and use the Claude Code hook protocol (read stdin to completion, then execute).

---

## Session Lifecycle Hooks — Detail

A pluggable hook system that reacts to session bus events. Replaces hardcoded triage dispatch in `server.ts` with a global bus subscriber pattern.

**Hook points** (11): `onSessionStart`, `onMessageSend`, `onTurnStart` (derived: first response after send), `onToolUse`, `onToolResult`, `onPlanComplete` (derived: ExitPlanMode), `onModeChange` (derived), `onTurnComplete`, `onTurnError`, `onSessionEnd`, `onSessionIdle` (timer-based).

**Dispatcher** (`dispatcher.ts`): Subscribes as `'session-hooks'` with `{ global: true }`. Fast-path skips non-`session:*` events. Maps events to hook points, builds context via `PayloadBuilder` (10s TTL cache), dispatches matching hooks in parallel with `Promise.allSettled`. Per-handler timeout (30s default, 120s for agents). Error isolation: one failing hook never blocks others. Infinite loop guard: skips `session:result`/`session:error` with `source === 'subagent-runner'`.

**Built-in hooks** (`builtins.ts`): `session-triage` (priority 50, dispatches triage subagent on `onTurnComplete`) and `session-error-notify` (priority 90, logs errors on `onTurnError`). Both can be disabled/overridden via `config.session_hooks.overrides`.

**File-based hooks** (`discovery.ts`): Scans `~/.walnut/hooks/*.mjs` for modules exporting `describe()` → descriptor and `handle()` → handler. Same pattern as action system.

**Filtering**: Hooks can specify `filter: { modes, projects, categories }`. Strict mode: denies when filter is specified but context is missing (prevents unintended dispatch).

**Config** (`config.yaml` → `session_hooks`): `overrides` (per-hook enable/disable/priority/timeout), `idleTimeoutMs` (default 5 min).

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
├── store.ts       # JSON file persistence (~/.walnut/cron-jobs.json)
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

`src/actions/`: File-based action discovery mirroring the agent registry pattern. Actions are discovered from two locations: built-in (`dist/actions/*.js`, compiled from `src/actions/*.ts`) and user (`~/.walnut/actions/*.mjs`). Each module exports `describe()` → `ActionDescriptor` and `run(ctx)` → `ActionResult { invoke, content?, image? }`. User actions override built-in actions with the same ID. Platform filtering via `descriptor.platform`. REST: `GET /api/cron/actions` lists discovered actions. Frontend: CronJobForm has an "Init Processor" checkbox with action dropdown (showing source badges), target agent, and model override fields.

---

## Embedded Subagent System — Implementation

**How it works**: `SubagentRunner.init()` subscribes as `'subagent-runner'` on the bus. On `SUBAGENT_START`, it resolves the agent definition, acquires a semaphore slot, loads context sources (if `taskId` present and agent has `context_sources` config), builds a custom system prompt and tool set, and calls `runAgentLoop()` with `cacheConfig: false`. Results are emitted back to the main agent via `SUBAGENT_RESULT`. Usage is tracked per-run with `source: 'subagent'`.

**Key files**:
- `src/core/agent-registry.ts` — manages agent definitions from 3 sources: builtin ("general", "session-triage"), config-defined (`config.yaml`), runtime-created (`agents.json`). **Builtin override**: editing a builtin agent auto-creates a config entry with the same ID that shadows it (`overrides_builtin: true`); deleting the override restores the original builtin.
- `src/providers/subagent-runner.ts` — `SubagentRunner` class, subscribes to bus events, manages runs with semaphore-limited concurrency (max 20)
- `src/agent/subagent-context.ts` — builds system prompts and filtered tool sets for subagents
- `src/agent/context-sources.ts` — `loadContextSources()` — injects task/project/memory context into subagent system prompts
- `src/agent/tools/agent-crud-tools.ts` — CRUD tools for managing agent definitions

### Session Triage Agent

A builtin embedded subagent (`id: 'session-triage'`) that automatically processes completed sessions.

**Flow**: `session:result` → server.ts emits `SUBAGENT_START` with `agentId: 'session-triage'` → SubagentRunner handles it → triage agent reads task + project context → updates task notes, sets `needs_attention`, decides next steps → compact 1-2 line notification added to main chat history (not streamed to main conversation).

**Configuration**: `config.agent.session_triage_agent` can override the default triage agent ID to use a custom agent definition.

**Context sources**: Auto-loads `task_details` + `project_memory` (auto), plus `project_task_list` (enabled by default). Uses stateful memory at `{auto}/triage` for per-project triage history.

**Allowed tools**: `get_task`, `update_task`, `add_note`, `update_session`, `send_to_session`, `query_tasks`, `memory`, `search`.

### Auto-inference & stateful memory

`task_details` and `project_memory` always load when `taskId` is present, regardless of `context_sources` config. Other sources must be explicitly enabled.

Context sources are **read-only** injection at invocation time. `stateful` config is **read+write** persistent memory across invocations. An agent can have both. `stateful.memory_project` supports `{auto}`, resolved at runtime to `{category}/{project}` from the task.

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

- **Start**: `walnut web` (`src/commands/web.ts`). Default port 3456.
- **Server**: `startServer()` at `src/web/server.ts`. Same port: REST + static files + WebSocket.
- **WebSocket**: `attachWss()` at `src/web/ws/handler.ts`. Server subscribes to bus as `'web-ui'` and broadcasts events to all browsers.
- **REST routes**: `src/web/routes/` — tasks, sessions, search, memory, config, categories, dashboard, cron, chat-history, session-chat, context-inspector, favorites, ordering, local-image.
- **React SPA**: Vite → `dist/web/static/`. Root: `web/src/App.tsx`.

See `web/src/AGENTS.md` for detailed UX implementation (message isolation, task references, image rendering, session streaming, slash commands, etc.).

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
