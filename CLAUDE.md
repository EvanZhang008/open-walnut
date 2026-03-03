# Walnut — Personal Intelligent Butler

> For full system deep-dives and diagrams, see [ARCHITECTURE.md](./ARCHITECTURE.md).

## CRITICAL: Open Source Repository — No Internal/Sensitive Information

**This is a PUBLIC open-source project on GitHub. Every commit, file, and message is visible to the entire internet.**

You MUST NOT include any of the following in code, comments, commit messages, file names, documentation, or any other content:
- **Company-internal names**: product names, service names, tool names, team names, project codenames, or any proprietary terminology from any employer
- **Personal information**: real names (other than the repo owner), email addresses, employee IDs, phone numbers, addresses
- **Internal infrastructure**: hostnames, internal URLs, IP addresses, account IDs, ARNs, internal API endpoints
- **Credentials & secrets**: tokens, passwords, API keys, certificates, cookie values
- **Internal processes**: oncall procedures, ticket systems, internal wikis, deployment pipelines specific to an employer

When referencing external integrations or plugins, use **generic descriptions** (e.g., "external sync plugin", "company-internal tool") instead of actual product names. If an external/internal plugin must exist, it belongs in `~/.walnut/plugins/` (external, never committed) — not in this repo.

**When in doubt, leave it out.**

## What & Why

Walnut is a personal AI butler that manages tasks, accumulates knowledge, and runs AI sessions — all centered around one idea: **tasks are the atom of everything**. Tasks live in a Category → Project hierarchy, can spawn Claude Code sessions, and connect to a rich memory system. The AI agent has access to your full context (tasks, memory, sessions, skills, tools) and acts on your behalf.

## Multi-Agent Warning

Multiple Claude Code agents may work in this repo simultaneously. Rules:
- **NEVER delete or revert other agents' changes**
- If your build fails, wait a moment and retry — another agent may be mid-commit
- If you have a merge conflict, back off and work on something else first
- Commit your own work promptly
- **Multi-agent safety:** do **not** create/apply/drop `git stash` entries unless explicitly requested (this includes `git pull --rebase --autostash`). Assume other agents may be working; keep unrelated WIP untouched and avoid cross-cutting state changes.
- **Multi-agent safety:** when the user says "push", you may `git pull --rebase` to integrate latest changes (never discard other agents' work). When the user says "commit", scope to your changes only. When the user says "commit all", commit everything in grouped chunks.
- **Multi-agent safety:** do **not** create/remove/modify `git worktree` checkouts (or edit `.worktrees/*`) unless explicitly requested.
- **Multi-agent safety:** do **not** switch branches / check out a different branch unless explicitly requested.
- **Multi-agent safety:** running multiple agents is OK as long as each agent has its own session.
- **Multi-agent safety:** when you see unrecognized files, keep going; focus on your changes and commit only those.
- Bug investigations: read source code of relevant npm dependencies and all related local code before concluding; aim for high-confidence root cause.
- Code style: add brief comments for tricky logic; keep files under ~500 LOC when feasible (split/refactor as needed).

## Production Server Safety

**Port 3456 is the user's PRODUCTION Walnut server. Agents MUST NOT kill, restart, or interfere with it.**

- The `exec` tool has a hardcoded rule that blocks `lsof/fuser/kill` commands targeting port 3456.
- Session system prompts include a `<server_safety>` block reminding agents of these rules.

### Dev Scripts — Build + Start with Latest Code

```bash
npm run dev:prod        # Build all → kill port 3456 → start with latest code (foreground)
npm run dev:ephemeral   # Build all → start ephemeral server (random port, temp data)
```

### Ephemeral Server Details

`walnut web --ephemeral` uses a two-phase daemon pattern:
1. **Launcher** (parent process): copies `~/.walnut/` to `/tmp/walnut-{PPID}-{random}/`, spawns a detached child server, polls for the port, prints JSON to stdout, and **exits immediately** — so `exec` captures the output.
2. **Child** (detached daemon): runs `startServer({ port: 0 })` — **100% identical to production** with all features (cron, sessions, sync, health monitor, event bus, WebSocket). Writes `ephemeral.json` inside its tmpdir. Self-destructs after **10 minutes of no HTTP requests** (idle timeout resets on each request).

**Usage from the exec tool:**
```bash
# Start — returns JSON immediately (parent exits)
result=$(walnut web --ephemeral)
# → {"pid":12345,"port":54321,"tmpDir":"/tmp/walnut-5000-abc123","startedAt":"..."}

# Extract port and test
port=$(echo "$result" | jq -r .port)
curl http://localhost:$port/api/tasks

# Stop when done — server cleans up its own tmpdir on exit
kill $(echo "$result" | jq -r .pid)
```

Max 3 concurrent ephemeral servers. Each self-cleans on exit (SIGTERM, SIGINT, or 10-min idle timeout).

### Starting the Real Production Server

To start the long-lived production server for the user (NOT for testing):
```bash
walnut web                    # Default port 3456
walnut web --port 8080        # Custom port
```
This is the user's always-on server. **Never** start/stop this from agent sessions.

## Concurrency & File Locking

`tasks.json` and `sessions.json` use two-layer write protection: in-process `withWriteLock` (serializes async callers) + cross-process `withFileLock` (`src/utils/file-lock.ts`, atomic mkdir + PID stale detection) — because hook child processes write these files directly. Other stores (`chat-history.json`, `config.yaml`) use only the in-process lock. Main agent turn queue (`enqueueMainAgentTurn`) max concurrency = 1. Token budget guard at 168K (`src/agent/token-budget.ts`).

See [ARCHITECTURE.md — Concurrency & File Locking](./ARCHITECTURE.md#concurrency--file-locking) for the full lock table.

## Architecture

Event Bus is the backbone — producers (cron, hooks, core mutations, user actions) emit events; subscribers (Web GUI, Main Agent, Session Runner) react. The Agent uses ~30 tools to read/write the Core data layer (task-manager, memory, sessions, config, cron, agent-registry), which calls into integrations (MS To-Do, external sync plugins, git-sync, Claude Code CLI). Core is a pure data/logic layer — Tools are the bridge.

See [ARCHITECTURE.md — Architecture Diagram](./ARCHITECTURE.md#architecture-diagram) for the full diagram.

## Data Model — 4-Layer Hierarchy

```
Category  →  Project  →  Task  →  Subtask
```

| Level | Example | Code field |
|---|---|---|
| **Category** | Work, Life, Later, Inbox | `task.category` |
| **Project** | HomeLab, Costco, AI Eureka | `task.project` |
| **Task** | "Fix tax filing" | `task.title` |
| **Subtask** | "Step 1: gather docs" | `task.subtasks[].title` |

- `task.project` defaults to `task.category` when not specified.
- **Strict agent validation**: `create_task type=task` requires the category AND project to already exist — use `create_task type=category` / `type=project` first. REST routes auto-ensure.
- Task text fields (5-field model): `description`, `summary`, `note`, `conversation_log`. See `src/core/AGENTS.md`.
- Phase lifecycle (7 states): `TODO` → … → `AGENT_COMPLETE` → … → `COMPLETE`. `complete_task` sets AGENT_COMPLETE — only the human marks fully done.
- MS To-Do list name = `"${category} / ${project}"`. Key functions: `parseGroupFromCategory()` at `src/utils/format.ts`, `buildListName()` at `src/core/task-manager.ts`.
- **Dependencies**: `task.depends_on: string[]` — validated (no self-refs, no cycles). Plugins sync via `updateDependencies()`: MS To-Do uses comment `DependsOn:` headers; other plugins can use native dependency APIs if supported. See `src/core/AGENTS.md` for details.

See [ARCHITECTURE.md — Data Model](./ARCHITECTURE.md#data-model--deep-dive) for source routing, phase system, session slots, child tasks, and needs-attention details.

## Memory System

Project-based memory mirrors the task hierarchy. Each project gets `~/.walnut/memory/projects/{category}/{project}/MEMORY.md`. Daily logs at `memory/daily/YYYY-MM-DD.md`. Session summaries auto-captured at `memory/sessions/`. FTS5 + BGE-M3 (Ollama) vector search via `memory-index.sqlite`.

| Component | Purpose | File |
|---|---|---|
| **Global memory** | User preferences, facts the agent learned | `src/core/memory-file.ts` |
| **Project memory** | Category/project-scoped logs with YAML frontmatter | `src/core/project-memory.ts` |
| **Daily logs** | Time-indexed activity, one file per day | `src/core/daily-log.ts` |
| **Session summaries** | Auto-captured from Claude Code hooks | `src/hooks/shared.ts` |
| **Search index** | SQLite FTS5 over all .md files (~400 tokens/chunk) | `src/core/memory-index.ts` |
| **Embedding system** | Local vector embeddings via BGE-M3 (Ollama) | `src/core/embedding/` |
| **Memory watcher** | Watches .md changes, debounces reindexing (1500ms) | `src/core/memory-watcher.ts` |

See [ARCHITECTURE.md — Memory System](./ARCHITECTURE.md#memory-system--data-flow--usage) for data flow, disk layout, and how the agent loads memory into its system prompt.

## Agent System (`src/agent/`)

Entry: `runAgentLoop()` at `src/agent/loop.ts`. Each turn: build system prompt → Bedrock API call (model: `claude-opus-4-6`) → extract text/tool_use blocks → execute tools → feed results back (loop, max 300 rounds). See [ARCHITECTURE.md — Agent Loop Diagram](./ARCHITECTURE.md#agent-loop-diagram).

| Category | Tools |
|---|---|
| **Task management** | `query_tasks`, `get_task`, `add_task`, `complete_task`, `update_task`, `add_note`, `update_note`, `update_description`, `update_summary`, `delete_task` |
| **Memory** | `memory` (append, update_summary, update_global, read, edit) |
| **Search** | `search` (hybrid BM25 + vector, modes: hybrid/keyword/semantic) |
| **Sessions** | `list_sessions`, `get_session_summary`, `start_session`, `send_to_session`, `get_session_history`, `update_session` |
| **Config** | `get_config`, `update_config`, `rename_category` |
| **Coding** | `read_file`, `write_file`, `edit_file` |
| **Execution** | `exec`, `apply_patch`, `process` |
| **Integration** | `slack`, `tts`, `analyze_image` |
| **Web** | `web_search`, `web_fetch` |
| **Cron** | `list_cron_jobs`, `manage_cron_job` |

See [ARCHITECTURE.md — Agent System](./ARCHITECTURE.md#agent-system--internals) for auth, image compression, and context details. See `src/agent/AGENTS.md` for loop internals.

## Chat History & Compaction (`src/core/chat-history.ts`)

Persistent chat via `~/.walnut/chat-history.json`. Unified `entries[]` with `tag: 'ai'` (model-facing) and `tag: 'ui'` (display-only). When payload exceeds ~160K tokens, two-step compaction runs: memory flush + LLM checkpoint summary. Old entries marked `compacted: true`, last 10 turns always preserved. See `src/core/AGENTS.md` for details.

## Skills System (`src/core/skill-loader.ts`)

Pluggable `SKILL.md` modules. Discovery order: `./skills/` → `~/.walnut/skills/` → `~/.claude/skills/`. Filtered by `requires.bins`, `requires.env`, `requires.platform`. Only eligible skills appear in the agent's `<available_skills>` XML. See [ARCHITECTURE.md — Skills System](./ARCHITECTURE.md#skills-system--detail).

## Claude Code Session Lifecycle

Sessions are detached `claude -p` child processes writing to a JSONL file. `SessionRunner` listens on the bus, spawns the process; `JsonlTailer` reads output and emits streaming events (`SESSION_TEXT_DELTA`, `SESSION_TOOL_USE`, `SESSION_RESULT`). Remote SSH sessions supported via `ssh user@host 'cd /path && claude -p ...'`. Per-host limits: local=7, remote=20. **Remote PATH setup**: `buildRemotePreamble()` in `session-io.ts` handles non-interactive SSH environments. Base PATH adds `~/.local/bin` and `~/.npm-global/bin`. Per-host `shell_setup` config field lets users add custom env setup (e.g. `source $HOME/.nvm/nvm.sh` for nvm, `eval "$(fnm env)"` for fnm). Wrapped in `|| true` for safety. **Image transfer (bidirectional)**: *Local→remote*: Before spawning a remote session, `transferImagesForRemoteSession()` in `session-io.ts` detects local image paths in the prompt, SCPs them to `/tmp/walnut-images/{random}/` on the remote host, and rewrites paths. *Remote→local*: During streaming, `rewriteRemoteImagePaths()` detects remote image paths in assistant text and tool results, rewrites them to `~/.walnut/images/remote/{sessionId}/`, and fires background SCP downloads. History replay (`rewriteHistoryRemoteImages()`) does the same for the history API. Transparent to the UI — all paths are local by the time they reach the frontend. Graceful degradation on failure.

**Session file access** (`src/core/session-file-reader.ts`): Unified `SessionFileReader` interface with `LocalFileReader` (fs) and `RemoteFileReader` (SSH) implementations. `readSessionJsonlContent()` transparently reads JSONL from local or remote. `readSubagentContents()` reads Task subagent JSONL files (batched SSH for remote). Used by `session-history.ts` (history parsing, plan extraction, state recovery) and `plan-message.ts` (remote plan reading).

**NEVER force-kill Claude Code processes** — this bypasses the on-stop hook and loses knowledge capture. See [ARCHITECTURE.md — Session Start Diagram](./ARCHITECTURE.md#session-start-diagram) and [Session Lifecycle Detail](./ARCHITECTURE.md#claude-code-session-lifecycle--detail).

**Three-tier session state model**: `ProcessStatus = 'running' | 'idle' | 'stopped'`. Running = actively processing a turn. Idle = turn complete, process alive, waiting for input. Stopped = process dead (resumable via `--resume`). Three layers manage resources: (1) **Processing Limit** (per-host, local=7, remote=20) — blocks new sessions when too many running; (2) **Idle Limit** (per-host, local=30, remote=40, configurable via `config.session.max_idle`) — evicts oldest idle session when limit exceeded; (3) **Idle Timeout** (health monitor, persistent timestamps, default 30min via `config.session.idle_timeout_minutes`, 0 = disabled) — kills sessions idle too long. Graceful two-phase shutdown (SIGINT → SIGTERM) preserves state for `--resume`. SSH and `await_human_action` sessions are excluded from idle timeout.

**Mid-session model switching**: Users can switch the Claude model via the `/model` control command in session chat. `pendingModel` is saved on the `SessionRecord` at the RPC layer (before message enqueue), consumed by `processNext()` which forces a `--resume` spawn with the new `--model` flag. Model values are validated against an allowlist (`opus`, `sonnet`, `haiku`) in `session-chat.ts`. UI: `ModelPicker` component in `web/src/components/sessions/ModelPicker.tsx`.

## Session Lifecycle Hooks (`src/core/session-hooks/`)

Pluggable hooks react to session bus events. 11 hook points (`onSessionStart` → `onSessionIdle`). Dispatcher at `dispatcher.ts` dispatches in parallel (30s timeout per hook). Built-in: `session-triage` (priority 50, fires on `onTurnComplete`) and `session-error-notify` (priority 90). File-based hooks from `~/.walnut/hooks/*.mjs`. See [ARCHITECTURE.md — Session Lifecycle Hooks](./ARCHITECTURE.md#session-lifecycle-hooks--detail).

## Plan-mode sessions

Sessions can run in `mode: 'plan'` — produces a plan file (`~/.claude/plans/{slug}.md`) and calls `ExitPlanMode`. Completed plan sessions can be "executed" via `POST /sessions/:id/execute` (starts new session with plan content embedded). The `mode` parameter is validated against `['bypass', 'accept', 'default', 'plan']`. Plan content renders as a collapsible `PlanCard` in session chat. See `web/src/AGENTS.md` for rendering details.

## Heartbeat System (`src/heartbeat/`)

Periodic AI self-check. Reads `~/.walnut/HEARTBEAT.md` on schedule (`heartbeat.every`, default `"30m"`, optional `activeHours`). If agent replies `HEARTBEAT_OK`, stores compact "All clear" instead of full AI messages. Trigger modes: periodic, event-driven (`session-ended`, `cron-completed`), manual (`POST /api/heartbeat/trigger`). See [ARCHITECTURE.md — Heartbeat](./ARCHITECTURE.md#heartbeat-system--implementation).

## Cron Job System (`src/core/cron/`)

Scheduler in `src/core/cron/` (service, store, schedule, timer, ops, normalize). Schedule types: `at` (one-time ISO), `every` (interval), `cron` (expr + timezone). Payload types: `systemEvent` or `agentTurn`. Optional `initProcessor` runs a file-based action before the payload, with optional `targetAgent` for multimodal piping. Managed via `list_cron_jobs` and `manage_cron_job` tools. See [ARCHITECTURE.md — Cron Job System](./ARCHITECTURE.md#cron-job-system--detail).

## Embedded Subagent System

Main agent delegates via `start_subagent` → `SubagentRunner` (max 20 concurrent, `src/providers/subagent-runner.ts`) resolves the `AgentDefinition`, builds custom system prompt + tool set, and calls `runAgentLoop()` in-process. Results returned via `SUBAGENT_RESULT` event. Agent definitions from 3 sources: builtin, `config.yaml`, runtime `agents.json`. See [ARCHITECTURE.md — Subagent Flow Diagram](./ARCHITECTURE.md#subagent-flow-diagram).

**Context sources** (injected when `taskId` present):

| Source ID | What it loads | Budget | Auto? |
|---|---|---|---|
| `task_details` | Task metadata, subtasks, description, summary, note | 1500 tok | Yes |
| `project_memory` | Project MEMORY.md content | 2000 tok | Yes |
| `project_task_list` | All non-completed tasks in same project | 1500 tok | No |
| `global_memory` | Global MEMORY.md | 2000 tok | No |
| `daily_log` | Recent daily activity logs | 3000 tok | No |
| `session_history` | JSONL history of the triggering session | 4000 tok | No |
| `conversation_log` | Task's conversation_log field | 1000 tok | No |

See [ARCHITECTURE.md — Embedded Subagent System](./ARCHITECTURE.md#embedded-subagent-system--implementation) for implementation and session triage agent details.

## Event Bus (`src/core/event-bus.ts`)

Singleton `bus`. Named subscribers, destination routing (events with `destination` go only to that subscriber), CoalescingQueue (250ms flush for high-frequency streaming events). See [ARCHITECTURE.md — Event Bus](./ARCHITECTURE.md#event-bus--implementation).

| Category | Events |
|---|---|
| **Task** | `task:created`, `task:updated`, `task:completed`, `task:starred`, `task:deleted`, `task:reordered` |
| **Subtask** | `subtask:added`, `subtask:toggled`, `subtask:deleted` |
| **Agent** | `agent:text-delta`, `agent:tool-activity`, `agent:tool-call`, `agent:tool-result`, `agent:thinking`, `agent:response`, `agent:error` |
| **Session** | `session:start`, `session:send`, `session:started`, `session:ended`, `session:result`, `session:error` |
| **Session streaming** | `session:text-delta`, `session:tool-use`, `session:tool-result`, `session:status-changed`, `session:usage-update`, `session:messages-delivered`, `session:batch-completed`, `session:message-queued` |
| **Subagent** | `subagent:start`, `subagent:send`, `subagent:started`, `subagent:result`, `subagent:error` |
| **Chat** | `chat:history-updated`, `chat:compacting`, `chat:compacted` |
| **Cron** | `cron:job-added`, `cron:job-updated`, `cron:job-removed`, `cron:job-started`, `cron:job-finished`, `cron:notification` |
| **Category / Config** | `category:created`, `category:updated`, `config:changed` |

Typed payloads: use `eventData<'event:name'>(event)` helper (`src/core/event-types.ts`).

## Logging & Debugging

Structured logging: JSON lines to `/tmp/walnut/walnut-YYYY-MM-DD.log` (auto-pruned 3 days) + colored stderr. Sensitive data auto-redacted.

```
walnut logs                          # Last 100 lines, pretty-printed
walnut logs -f -s agent              # Follow only agent logs
walnut logs --json | jq '.message'   # Raw JSON + jq
```

See `src/logging/AGENTS.md` for subsystem loggers, log levels, and redaction patterns.

## Usage Tracking (`src/core/usage/`)

SQLite tracking of all API costs and token usage at `~/.walnut/usage.sqlite` (WAL mode). Sources: agent, subagent, compaction, heartbeat, cron, triage, session, etc. Admin page at `/usage`. See [ARCHITECTURE.md — Usage Tracking](./ARCHITECTURE.md#usage-tracking--implementation).

## UI Surface: Web GUI

React SPA communicates with the Express server via REST and WebSocket. The server subscribes to the Event Bus as `'web-ui'` and broadcasts events to all connected browsers. Same port (3456) serves REST, static files, and WebSocket. See [ARCHITECTURE.md — Web GUI Diagram](./ARCHITECTURE.md#web-gui-diagram).

- **Landing page**: Chat (left ~65%) + collapsible To-Do panel (right ~35%).
- **Task-centered interaction**: Click a task → `TaskContextBar` → `useChat` sends task context with every message.
- **Hierarchy**: TodoPanel groups by Category → Project. Category tabs at top.
- **Drag-and-drop**: `@dnd-kit/core` + `@dnd-kit/sortable`. Within-group and cross-group moves.
- **Real-time**: `useTasks`, `useChat`, `useSessionStream` hooks listen to WebSocket events.
- **Always-mounted MainPage**: Hidden via `display:none` + `inert`. Preserves React state across navigation.
- **Theme**: Apple-style light/dark. Light: #fff/#F5F5F7, dark: #000/#1C1C1E, accent: #007AFF/#0A84FF.

| Route | Page | Description |
|---|---|---|
| `/` | MainPage | Chat + To-Do panel |
| `/tasks` | DashboardPage | Full task board |
| `/tasks/:id` | TaskDetailPage | Single task detail view |
| `/search` | SearchPage | Full-text search |
| `/sessions` | SessionsPage | Task-tree browser (left) + session detail/chat (right) |
| `/usage` | UsagePage | Token usage & cost dashboard |
| `/commands` | CommandsPage | Slash command management |
| `/settings` | SettingsPage | Config editor |

See `web/src/AGENTS.md` for detailed UX implementation (message isolation, task references, image rendering, session streaming, slash commands).

## Integration Plugin System

Integrations are now plugins discovered by the loader from two directories:
- **Built-in** (`src/integrations/*/`): ships with the repo
- **External** (`~/.walnut/plugins/*/`): user-installed or company-internal

Each plugin has a `manifest.json`, an entry point (`index.ts`), and registers via `PluginApi` (sync methods, source claim, display metadata, migrations, HTTP routes).

| Plugin | Type | Purpose | Dir |
|---|---|---|---|
| **local** | In-repo | Universal fallback (no external sync) | `src/integrations/local/` |
| **ms-todo** | In-repo | Two-way sync with Microsoft To-Do | `src/integrations/ms-todo/` |
| *(external)* | Plugin | Additional sync plugins installed at `~/.walnut/plugins/` | User-provided |
| **git-sync** | Standalone | Version-controlled backup of task/memory data + auto-commit polling | `src/integrations/git-sync.ts` |

**In-repo** plugins ship with the package. **Internal** plugins are company-specific and can be relocated to `~/.walnut/plugins/` for external deployment (see README.md in each plugin dir). The loader discovers both locations identically.

Core code never imports plugins directly -- all access goes through `IntegrationRegistry` and dynamic imports inside each plugin's `plugin.ts`.

| Component | Purpose | File |
|---|---|---|
| **IntegrationRegistry** | Singleton plugin store, category claim resolution | `src/core/integration-registry.ts` |
| **IntegrationLoader** | Plugin discovery, manifest validation, config migration | `src/core/integration-loader.ts` |
| **IntegrationSync** | 16-method sync interface every plugin implements | `src/core/integration-types.ts` |
| **Integrations API** | `GET /api/integrations` returns plugin metadata for UI | `src/web/routes/integrations.ts` |

## Commands

```
walnut                                    # Interactive TUI
walnut web [--port 3456]                  # Web GUI server
walnut web --ephemeral                    # Isolated test server (temp data, random port)
walnut add "title" -p high -c Work -l HomeLab # Add task (category + project)
walnut tasks [-s todo] [-c work]          # List/filter tasks
walnut done <id>                          # Complete task
walnut sessions                           # List Claude Code sessions
walnut start <task_id>                    # Start Claude Code session for task
walnut recall "query"                     # Search memory
walnut projects                           # List projects
walnut chat                               # Chat with agent (CLI)
walnut logs [--follow] [--json] [--limit N] [--subsystem NAME]  # View structured logs
walnut sync                               # Git sync
walnut auth                               # Microsoft To-Do auth
```

All commands support `--json` for structured output.

## Development

```bash
npm run build     # Build server (tsup) → dist/
npm test          # Unit + integration + e2e (parallel via scripts/test-parallel.mjs)
npm run dev       # Watch mode (backend only)
cd web && npx vite build  # Build React SPA → dist/web/static/
```

### Frontend Dev with Hot Reload

```bash
cd web && npx vite   # Starts on http://localhost:5173
```

Vite proxies `/api` → `localhost:3456`, `/ws` → `ws://localhost:3456` (see `web/vite.config.ts`). Edit `web/src/` → browser updates instantly. When done, `cd web && npx vite build` to deploy to production.

## Source Directory Structure

```
src/
├── actions/        # File-based action modules (types, registry, screenshot-track)
├── agent/          # AI agent loop, system prompt, tools (~30), model client, caching
├── commands/       # CLI command handlers (add, done, web, chat, logs, etc.)
├── core/           # Pure data/logic: task-manager, session-tracker, chat-history, event-bus,
│                   #   memory (file, project, daily, index, watcher), search, config, cron/, usage/,
│                   #   embedding/ (BGE-M3 vector search via Ollama — client, store, pipeline, cosine)
├── heartbeat/      # Periodic AI self-check system
├── hooks/          # Claude Code lifecycle hooks (on-stop, on-compact)
├── integrations/   # MS To-Do sync, external sync plugins, git-sync
├── logging/        # Structured logging with subsystem tags
├── providers/      # ClaudeCodeSession + SessionRunner, SubagentRunner
├── tui/            # Terminal UI (state machine)
├── utils/          # Shared utilities (fs, format, file-lock, etc.)
└── web/            # Express server, REST routes (15 files), WebSocket handler
```

## Data Files (on disk)

```
~/.walnut/
├── config.yaml          # User config (name, defaults, provider, agent, ms_todo, hosts)
├── tasks/
│   ├── tasks.json       # Task store
│   └── archive/         # Completed task archives
├── sessions.json        # Session registry (v2: SessionRecord[])
├── chat-history.json    # Persistent chat (unified entries[] v2 + compaction)
├── cron-jobs.json       # Cron job definitions and state
├── agents.json          # Runtime subagent definitions
├── usage.sqlite         # Token usage tracking (SQLite, WAL mode)
├── MEMORY.md            # Global memory
├── memory/
│   ├── daily/           # YYYY-MM-DD.md daily logs
│   ├── projects/        # category/project/MEMORY.md
│   ├── sessions/        # [slug].md session summaries
│   ├── knowledge/       # *.md knowledge articles
│   └── memory-index.sqlite  # FTS5 search index
└── hook-errors.log      # Silent hook error log
```

## Git Auto-Commit (`src/web/server.ts` → `src/integrations/git-sync.ts`)

`startGitAutoCommit()` runs at server startup: ensures `~/.walnut/` is a git repo (`ensureRepo()`), commits any leftover dirty state, pulls remote, then polls every 30s (`commitIfDirty()`). Health state (`GitAutoCommitHealth`) tracks `protected`, `consecutiveFailures`, `error`. Status exposed via `GET /api/git-sync/status` and pushed to frontend via `git-sync:status` WebSocket event. `DataSafetyBanner` (red, non-dismissible) appears when git is unavailable or commits fail 3+ times. `task-manager.ts` has a backup-on-empty safety net: saves `tasks.backup.json` before writing an empty store when disk has existing tasks.

## E2E-First Development Workflow

**The #1 rule: Before writing ANY code, figure out how you will verify end-to-end.**

Every task — bug fix or new feature — starts with designing the verification, not with writing the implementation. This prevents shipping code that "looks correct" but was never actually tested against the real user flow.

### Bug Fix

```
1. DESIGN verification: What exact user flow reproduces this bug?
   → Write it down: click X, see Y, expect Z
2. REPRODUCE with Playwright: Run the flow, screenshot the broken state
   → If you can't reproduce it, you don't understand it yet
3. IMPLEMENT the fix
4. BUILD: npm run build && cd web && npx vite build
5. VERIFY with Playwright: Run the SAME flow from step 2
   → Use real UI interactions (sidebar clicks, not page.goto)
   → Screenshot and compare with step 2
6. COMMIT only if Playwright verification passes
```

### New Implementation

```
1. DESIGN verification: How will I know this feature works?
   → Define 2-3 E2E scenarios (happy path + edge case + error)
   → Specify: what to click, what to see, what data to check
2. PLAN the implementation
3. IMPLEMENT
4. BUILD: npm run build && cd web && npx vite build
5. VERIFY with Playwright: Execute ALL scenarios from step 1
   → Screenshot each step
   → Check DOM state (attributes, text content, element counts)
6. COMMIT only if all scenarios pass
```

### Critical Testing Rules

- **NEVER** commit a UI change based on code reasoning alone. Always verify empirically.
- **NEVER** use `page.goto()` to simulate navigation — use real UI clicks (sidebar, buttons). `page.goto()` is a full page reload and tests a completely different scenario than SPA navigation.
- **NEVER** say "it should work because the code is correct." Run the test.
- Use `/verify` after implementation to run the verification workflow.
- For the production server at port 3456, use Playwright MCP tools directly. For isolated testing, use the ephemeral server (`walnut web --ephemeral`).

## Conventions

### Plan communication style
- Architecture first: data flow diagrams, module interaction diagrams — not code
- User experience: scenario tables from user's perspective
- Layered: high level (architecture, UX) → middle level (patterns, mechanisms) → no low-level code
- File changes: annotated file tree, not separate step lists
- Pseudocode is fine; detailed implementation code is not

## Testing

**The one hard rule**: Every feature MUST have at least 1 real E2E test. The happy path must go through a real server (`startServer({ port: 0, dev: true })`), not just mocks. Only mock the Claude CLI binary (`tests/providers/mock-claude.mjs`).

```bash
npm test                          # Unit + integration + e2e (parallel)
npx playwright test               # Browser tests
npm run test:live                  # Live tests (requires credentials)
npm run test:all                  # lint + unit + integration + e2e + playwright
```

See `AGENTS.md` and `tests/AGENTS.md` for the full test pyramid, tier descriptions, mock patterns, and coverage matrix. See [ARCHITECTURE.md — Testing](./ARCHITECTURE.md#testing--full-guide) for design checklist and tier details.
