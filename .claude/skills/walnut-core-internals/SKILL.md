---
name: walnut-core-internals
description: Deep implementation details for src/core/ — task model (5 text fields, phase lifecycle, dependencies, session slots, child tasks), session monitoring (3-layer), message queue & FIFO/JSONL delivery patterns, daemon-uniform file access rule, chat history compaction. Use when implementing or debugging anything in src/core/ or the session data layer.
---

# Core Layer — Implementation Details

Detailed internals for `src/core/`. For architecture overview, see project `CLAUDE.md`.

## Task Model Details

### Task text fields (5-field model)

Each task has `description` (what & why — pre-action context, user-set), `summary` (TL;DR of progress — AI-maintained), `note` (detailed markdown blob — evolving, append via `addNote()` or replace via `updateNote()`), and `conversation_log` (append-only markdown log of user↔agent interactions, auto-managed by the chat handler via `appendConversationLog()`).

The conversation_log is automatically appended server-side after every chat turn where a task is focused — each entry has a `### YYYY-MM-DD HH:MM` timestamp heading followed by `**User:**`/`**AI:**` summaries (truncated to 150/200 chars). The field is optional, starts as `undefined`, and is created on first interaction.

Migration from the old `notes: string[]` is handled by `migrateNotesToFields()` in `task-manager.ts`.

MS To-Do sync: all fields combine into a structured body (`description\n\n---\n\n## Summary\n...\n\n## Notes\n...\n\n## Conversation Log\n...`) via `composeMsTodoBody()`/`parseMsTodoBody()` in `src/integrations/microsoft-todo.ts`.

External sync plugins: each plugin decides how to map these fields to its platform (e.g., description field, comment body, etc.). See the plugin's own documentation for details.

Conversation_log is tail-truncated (recent entries preserved) in Task Context (400 chars), session context (300 tokens), and task_get tool response (1500 chars).

### Task source routing

`TaskSource = 'ms-todo' | 'local' | string` — extensible via plugins. Source is auto-determined at creation by `addTask()` using the `IntegrationRegistry` category claim chain. The agent does not set source manually. `autoPushIfConfigured()` routes push by source.

Migration: legacy `source: 'local'` → `'ms-todo'` with a one-time `scheduleUnsyncedPush()` to push formerly-local tasks.

**Category-source consistency**: `validateCategorySource()` enforces that each category contains only one source type — `addTask()`, `updateTask()` (on category change), and `renameCategory()` throw `CategorySourceConflictError` (HTTP 409) if a cross-source conflict is detected. Plugins may reserve categories via their claim priority. Sync pull paths (`addTaskFull`, `updateTaskRaw`) bypass validation since they are the source of truth.

### Task phase system

Tasks have a 7-state `phase` lifecycle (`TODO` → `IN_PROGRESS` → `AGENT_COMPLETE` → `AWAIT_HUMAN_ACTION` → `HUMAN_VERIFIED` → `POST_WORK_COMPLETED` → `COMPLETE`) that replaces the old 3-state `status`. Status is auto-derived from phase via `PHASE_TO_STATUS` for backward compatibility.

Key mappings in `src/core/phase.ts`:
- `PHASE_TO_WORKFLOW` / `WORKFLOW_TO_PHASE` — external plugin workflow sync (includes both canonical names like `'Implementation'` and common aliases like `'In Progress'`)
- `PHASE_TO_MS_STATUS` / `MS_STATUS_TO_DEFAULT_PHASE` — MS To-Do sync
- Plugin-specific phase groups — preserving local phase during pulls

Phase is the source of truth — `applyPhase()` mutates both `task.phase` and `task.status`. The `VALID_PHASES` set is used for input validation.

### Task dependencies (`depends_on`)

Tasks can declare dependencies on other tasks via `task.depends_on: string[]` (array of task IDs). Dependencies are validated (no self-refs, no circular chains via BFS) and managed through mutation helpers: `add_depends_on`, `remove_depends_on`, `set_depends_on` in `updateTask()`. `isTaskBlocked(task, allTasks)` checks if any dependency is non-COMPLETE.

**Sync**: `autoPushIfConfigured()` calls `sync.updateDependencies(task, task.depends_on ?? [])` after the parallel field batch. Each plugin decides how to represent dependencies on its platform:
- **MS To-Do**: `DependsOn: id1,id2` header in comment body (informational only, roundtripped via `composeMsTodoBody()`/`parseMsTodoBody()`).
- **Other plugins**: Can implement native dependency APIs if the platform supports them. The plugin computes a delta against previous state and pushes add/remove operations.

Store version: v4 (`migrateToV4DependsOn`). The `depends_on` field is optional.

### Session slots (2-slot model)

Each task has typed session fields instead of an unbounded array: `plan_session_id?: string` (current plan session) and `exec_session_id?: string` (current execution session). The old `active_session_ids: string[]` is removed; `session_ids: string[]` is retained as a historical log.

`linkSessionSlot(taskId, sessionId, 'plan'|'exec')` and `clearSessionSlot(taskId, sessionId?, slotType?)` in `task-manager.ts` manage these fields. `session_start` in `tools.ts` checks slots pre-flight and returns a `blocked` response with the existing session info when a slot is occupied. `applyPhase('COMPLETE')` and `toggle-complete` clear both slots.

### Project metadata (`.metadata` tasks)

Each project can have a hidden `.metadata` task whose `description` contains YAML config (e.g., `default_host: remote-dev\ndefault_cwd: /home/user/project`). Retrieved via `getProjectMetadata(category, project)` in `task-manager.ts`. `.metadata` tasks are filtered from `task_query`, REST endpoints, and the TodoPanel UI. Used by `session_start` for host/cwd resolution.

**Session CWD resolution chain** (5 priorities, in `resolveSessionContext()` in `tools.ts`): ① explicit `working_directory` param → ② `task.cwd` → ③ parent task chain walk → ④ project metadata `default_cwd` → ⑤ project memory directory (`~/.open-walnut/memory/projects/{category}/{project}/`). The same chain runs in `handleStart()`/`handleStartSdk()` in `claude-code-session.ts` as defense-in-depth for the RPC/bus path. If all 5 priorities fail, the agent tool returns an actionable error message.

### Subtask model: two systems (child tasks vs. embedded subtasks)

Walnut has two subtask mechanisms. **Child tasks are the canonical model; embedded subtasks are legacy.**

#### Child tasks (the REAL subtask model)

Full Task objects with `parent_task_id` pointing to a parent. They have ALL Task fields (description, summary, note, phase, sessions, dependencies, etc.) and go through the normal task lifecycle (`addTask`, `updateTask`, `completeTask`).

- Inherit `category`, `project`, `source` from parent (unless overridden).
- `getChildTasks(taskIdPrefix)` returns all children.
- `guardActiveChildren()` blocks completing a parent with non-COMPLETE children (`ActiveChildrenError`, HTTP 409).
- UI: indented with `└ child` badge; parent shows `N sub` count.
- Sync: `Parent: <shortId>` header in MS To-Do body and plugin comment fields.

#### Embedded subtasks (LEGACY — will be removed)

`task.subtasks?: Subtask[]` — lightweight embedded checkbox (just `title` + `done`). Modeled after MS To-Do's "checklist items" which are NOT real tasks.

**This is deprecated.** Cannot have descriptions, priorities, phases, sessions, or dependencies. When the integration plugin system lands, this will be removed. All subtasks will be child tasks. Each plugin handles platform mapping internally:
- **MS To-Do**: plugin maps child tasks to checklist items
- External plugins handle platform-specific child mapping (e.g., sub-issues, child tasks)

Legacy code (do not extend):
- Types: `Subtask` interface, `task.subtasks` field in `types.ts`
- Functions: `addSubtask()`, `toggleSubtask()`, `removeSubtask()`, `updateSubtask()` in `task-manager.ts`
- Routes: `POST /api/tasks/:id/subtasks`, `PATCH/DELETE/POST .../:sid/toggle`
- UI: `SubtaskList.tsx`

### Needs-attention notification

`needs_attention?: boolean` — a synced flag that signals "this task needs human input." The AI triage agent sets it via `task_update` when a session completes — instruction #4 in all three triage prompts in `server.ts`.

Default behavior: set it unless the session clearly succeeded and the agent is resuming with obvious next steps. In the UI, flagged tasks show a red dot (`.task-attention-dot`). Clicking/focusing a task in MainPage auto-clears the flag via `PATCH { needs_attention: false }`. `applyPhase('COMPLETE')` also clears it.

MS To-Do sync: roundtripped via `Attention: true` header line in body. External plugins may include it in their sync payload (typically push-only). The `task_query` tool includes it when truthy and supports `where.needs_attention` filter.

## Session Monitoring — 3-Layer System

Sessions are monitored at three levels, from fastest to slowest:

| Layer | Component | Interval | Scope | Triggers |
|---|---|---|---|---|
| **Per-session** | `ClaudeCodeSession` liveness timer | 3s | Single session | PID death → flush file → emit result/error |
| **Health monitor** | `SessionHealthMonitor` | 30s | All non-terminal sessions | PID death missed by per-session → update DB + emit status |
| **Reconciler** | `reconcileSessions()` | On startup | All non-terminal sessions | Server restart → reconnect alive, mark dead completed |

**Per-session liveness** (`ClaudeCodeSession`): Each session has a 3-second interval that calls `isProcessAlive(pid, 'claude')`. On death, flushes the tailer, reads stderr, and emits `SESSION_RESULT` or `SESSION_ERROR`. This is the fast path — catches most normal exits.

**Health monitor** (`src/core/session-health-monitor.ts`): A 30-second interval that scans all non-terminal sessions from `sessions.json`. If a PID died while `work_status === 'in_progress'`, checks the output file for a result event line to determine `agent_complete` vs `error`. Clears task session slots via `clearSessionSlot()`. Started/stopped with the web server lifecycle.

**Reconciler** (`src/core/session-reconciler.ts`): Runs once on server startup. For each non-terminal session: if `pid + outputFile` exist and the process is alive → reconnectable (SessionRunner attaches and tails from byte 0). Otherwise → mark `completed`, clear task references, emit status change.

## Authoritative Status Reconcile (`src/core/session-reconcile.ts`) — READ BEFORE TOUCHING STATUS LOGIC

NOT the same as `session-reconciler.ts` above (startup-only zombie sweep). This is the **runtime convergence primitive**: every status write in the system is one-directional and event-driven, so losing a single `result` event (tailer freeze, server-restart window, WS drop, replay-guard swallow) wedges `process_status` at 'running' — or the task at IN_PROGRESS — forever. `reconcileProcessStatus()` is the only path that re-checks records against ground truth. Called from `attachToExisting()` (restart recovery) and `SessionHealthMonitor.reconcileStuckRunningSessions()` (periodic, 30s tick with 5-min per-session backoff + 5-per-tick cap).

### Hard-won evidence rules (each cost a real incident — do NOT regress)

1. **The daemon STREAM file is the ONLY authoritative source for turn-ends.** The CLI writes `result` / `session_state_changed` / `task_*` events ONLY to stdout (captured into `STREAMS_DIR/<sid>.jsonl`), NEVER to the canonical `~/.claude/projects/<enc-cwd>/<sid>.jsonl`. Verified empirically across 80+ real sessions: canonical files contain ZERO top-level result/state lines. A v1 of this module read the canonical JSONL via `recoverStateFromJsonl()` — its workStatus was ALWAYS undefined on real data and the convergence never fired, while unit tests passed because fixtures unrealistically wrote result lines into the canonical path. **Lesson: fixtures must mirror the REAL file layout (result events in the stream file, not canonical), and any evidence rule must be validated against live session files before shipping.**
2. **The stream file is blind to turn STARTS.** The CLI never echoes stdin user messages to stdout, so a turn started by a plain-text FIFO send leaves no anchor line. Without compensation, the fold's backward anchor scan lands on a PREVIOUS turn's user line and adopts that turn's stale result as the current turn's verdict (inc-1783644415695: a working session force-converged to a day-old error, 3× in one day). Compensations, both required: (a) the daemon appends a `walnut-injected` marker line at every FIFO delivery (`appendUserMarker` RPC) which `isRealUserLine` accepts as an anchor; (b) positional veto — a result whose byte offset ≤ `record.consumedOffset` was already consumed by the live path ('result-already-consumed'), and a fold that sees init / state:running AFTER a result discards that result.
3. **Missing evidence = no-op, never manufacture completion.** Converge only when ALL hold: real result after the last real user message + trailing idle after it (skipped for error results) + `gatingBgCount === 0` + `!teamActive`. Every string return from `fetchStreamTailFold` means "do not converge".
4. **Clear the PID only when the process is confirmed DEAD.** An error verdict with a live CLI + FIFO keeps its pid — clearing it forced the next send onto the cold `--resume` path, spawning a SECOND CLI against the same session (split-brain).
5. **Terminal converge (stopped/error) must `clearSessionSlot`** — mirrors the live result path; otherwise the reconciled session holds the task's session slot forever.
6. **After a DB converge, sync the live CCS instance** via `sessionRunner.findSessionByClaudeId(sid)?.setProcessStatusFromReconciler(to)` — `writeMessage()` decides mid-turn injection from the in-memory `_processStatus`, which otherwise desyncs from the record.
7. **Health-monitor loop hygiene:** `reconcileStuckRunningSessions` returns the converged-ID Set and the main loop skips those IDs (stale-snapshot overwrite race — same pattern as `checkIdleTimeout`/`checkHungSessions`); backoff timestamp + MAX_PER_TICK slot are recorded INSIDE the try, after the attempt actually starts (a fast refusal must not burn a slot + 5-min backoff).

### Connectivity loss ≠ process death (`reconcileTaskPhases` Rule A guard)

An SSH-tunnel flap makes `isAlive()` return false for every remote session past the 5-min disconnect grace, and the health monitor marks them `error` / `status_reason='remote_unreachable'`. In the SAME tick, `reconcileTaskPhases` Rule A used to see `aliveSessions: 0` and force IN_PROGRESS → AWAIT_HUMAN_ACTION — the "session is running but task shows complete" incident (inc-311a517d, clouddev tunnel flap; self-healed 4 min later when the stream reconnected, but the task badge lied the whole time). The guard: when ALL dead primary sessions are remote with `status_reason === 'remote_unreachable'`, liveness is UNKNOWN — skip the phase force. `isProcessAlive()` is a hard OS fact for local sessions only; for remote sessions during a disconnect it is a guess.

## Session Start Steps

1. Agent tool `session_start` validates the task and calls `sessionRunner.startSession()` directly (awaits the Claude session ID so the response can include a `<session-ref>` tag). Other callers (REST, CLI) still emit `SESSION_START` via the bus.
2. `SessionRunner.handleStart()` builds session context via `buildSessionContext()` (task info, project memory)
3. Creates `ClaudeCodeSession` instance and calls `.send(message, cwd, ...)`
4. Detached child process is spawned, stdout redirected to a JSONL file in `SESSION_STREAMS_DIR`
5. `JsonlTailer` tails the output file, parsing lines and emitting bus events in real-time
6. A per-session liveness timer (3s interval) checks PID — on death, flushes remaining file data and emits `SESSION_RESULT` or `SESSION_ERROR`
7. `startSession()` returns `{ claudeSessionId, title }` after `sessionReady` resolves (30s timeout)

## Session Message Queue (`session-message-queue.ts`)

Messages sent to sessions are persisted to disk before processing. This prevents message loss on server crash. `markProcessing()` atomically moves pending messages to a processing state; `removeProcessed()` cleans up after the session turn completes. Multiple messages arriving while a session is busy are batched and sent as one combined `--resume` call.

## Session Message Delivery — FIFO & JSONL Patterns

Messages reach Claude Code via two paths, which produce different JSONL patterns:

**1. FIFO write (mid-turn delivery):** `processNext()` calls `writeMessage()` → writes JSON to a named FIFO pipe that Claude CLI reads as stdin. Claude logs `queue-operation` entries in its JSONL output:

  - **Pattern A** (consumed): `enqueue` → `dequeue` → normal `human_turn_start`. The session-history parser matches enqueue→dequeue pairs and uses the user message that follows (skips the enqueue to avoid duplicates).
  - **Pattern B** (not consumed before turn ends): `enqueue` only (no matching dequeue). The parser synthesizes a user message from the enqueue content at its chronological position. This happens when the CLI finishes its turn before reading the FIFO.

**2. --resume spawn (between-turn delivery):** When no running process exists (or FIFO write fails), `processNext()` spawns `claude --resume <id> -p "message"`. This produces a normal `human_turn_start` entry (Pattern C). Always reliable.

**Frontend implications:** See `web/src/AGENTS.md` "Session Chat" section for how the frontend deduplicates optimistic messages against these JSONL patterns. Key issue: FIFO-delivered messages may or may not appear in JSONL depending on timing, so the frontend must handle both cases (message in persisted history vs. not).

## Session JSONL Files

Each session has two JSONL files:
- **Canonical JSONL** (`~/.claude/projects/<cwd>/<id>.jsonl`): owned by Claude Code, source of truth for `--resume` (uuid/parentUuid chain) — Walnut must never write to it.
- **Output-stream JSONL** (`~/.open-walnut/sessions/streams/<id>.jsonl`): owned by Walnut (`_outputFile`), used for real-time tailing and `writeSyntheticUserEvent()`. **Local sessions only** — remote sessions have no local output file (`RemoteSessionManager.outputFile` returns null).

## Daemon-Uniform File Access (the ONE rule for reading session data)

**Every read of a Claude Code session-data file goes through `DaemonFileReader(host ?? '__local__')` — local AND remote, no exceptions.** There is no separate "local" transport: `__local__` connects to the in-process local daemon over WebSocket exactly like a remote host connects over an SSH-tunneled one. This is the single most important invariant in the session layer — it makes local and remote one code path, so a bug fixed for one is fixed for both, and the whole surface is trivially decoupled from where the files physically live.

**Session-data files** = Claude Code's per-session artifacts (NOT Walnut's own tasks.json/sessions.json/memory/):
- main transcript `~/.claude/projects/<enc-cwd>/<sid>.jsonl`
- subagent transcripts `…/<sid>/subagents/agent-*.jsonl`
- dynamic-workflow manifests `…/<sid>/workflows/*.json`
- plan files `~/.claude/plans/*.md`
- the Walnut stream copy `<streams-dir>/<sid>.jsonl`

**Reader API** (`src/core/daemon-file-reader.ts`): `readFile(path)` (ENOENT→null, transport-fail→throw), `stat(path)` → `{mtimeMs,size}`, `listDir(path)`, `findSession(sid)` (daemon `fs.find` over `~/.claude/projects`, returns `{content,path}`), `batchReadSubagents(dir)`. Paths may be tilde-prefixed (`~/.claude/...`) — the daemon expands `~` against **its own** `process.env.HOME` (override with `WALNUT_HOME_OVERRIDE`, used only by tests to align the daemon with a mocked `CLAUDE_HOME`).

**Conventions:**
- The sanctioned read helpers live in `session-file-reader.ts` (`readSessionJsonlContent`, `readSubagentContents`, `readSingleSubagentContent`, `readWorkflowManifest`) and `session-history.ts` / `session-changes.ts`. New code reads through these, not raw `fs`.
- Path **builders** (`canonicalJsonlPath`, `remoteJsonlPath`, `encodeProjectPath`) only construct strings — building a path is fine; only direct `fs`/`ssh` **reads** of the files above are violations.
- mtime cache: `stat()` via the daemon before a full read; a `{mtimeMs}` match returns cached parse (`session-history.ts`). `host ?? '__local__'` is the cache key.
- Anti-pattern that WILL break: a `DaemonFileReader('__local__')` read racing ahead of any session `attach()` on a **cold server start** — `connect()` must self-warm the `__local__` pool (it does; mirrors `reconnect()`). Do not assume the pool is warmed by session creation order.

**Known remaining bypasses (local-only fast paths, migrate when touched):** `team-reader.ts`, `subagent-poller.ts`, and `claude-code-session.ts:_areTeammatesStillActive()` still hit the fs directly. They use *partial* reads — `readFileHead` (first N bytes) and byte-offset tailing — which the daemon has no command for yet. Routing them to the daemon requires adding an `fs.readRange`/`fs.head` command first (else every poll full-reads a large JSONL — a perf regression). Until then they are the documented exception, not a template to copy.

**Daemon socket writes (the OTHER one rule):** every daemon→client WebSocket write in `daemon-standalone.ts` MUST go through `safeSend` (never raw `ws.send`). Bun's `ServerWebSocket.send()` returns `0` and **silently drops the message forever** when the socket's backpressure buffer is saturated — one ~28MB `fs.read` response is enough, and everything sent while saturated (concurrent RPC replies, other sessions' `jsonl` stream events on the shared per-host connection) vanishes. `safeSend` queues dropped payloads per-socket and flushes them on Bun's `drain` callback, preserving FIFO order. The plain-Node `daemon-source.ts` does NOT need this (the `ws` package buffers internally and never drops) — see the PARITY NOTE there. Regression: `tests/providers/daemon-ws-backpressure.test.ts` (real binary, 6 concurrent large reads).

**Parser dedup edge case (mid-turn sends):** `parseSessionMessages` skips an `enqueue` when a real `type:"user"` twin with identical text follows within 50 lines (Pattern A). The twin's `content` is USUALLY a string but ~0.3% of the time an **array** of blocks (image refs / long text) — the matcher must extract the first `text` block for the array case, or those enqueues render twice. Content-matching (not enqueue/dequeue/remove counting) is the true invariant: counts don't balance across `--resume`/compact boundaries. Validated on a 2517-enqueue real corpus. Tests: `tests/core/session-parser-dedup.test.ts` (unit), `tests/e2e/mid-stream-message-position.test.ts` (e2e through the real server with a mocked daemon transport).

## Chat History & Compaction Details

The main agent chat persists via `~/.open-walnut/chat-history.json`. Unified `entries[]` array (v2 schema):
- **`tag: 'ai'`**: Model-facing messages (Anthropic `ContentBlock[]` format). Fed to `runAgentLoop()` via `getModelContext()`.
- **`tag: 'ui'`**: Display-only notifications. Never sent to the model.

Key API: `addAIMessages()`, `addNotification()`, `getModelContext()`, `getDisplayEntries()`. Auto-migrates from v1 on first read. Also runs one-time migration to mark orphan `tool_result` entries as compacted.

### Compaction process (when full payload exceeds 80% of context window)

Threshold is dynamic: 80% of the model's context window (160K for 200K models, 800K for `[1m]` 1M models). Reads `agent.main_model` from config. See `getContextWindowSize()` in `src/agent/model.ts`.

1. **Memory flush** (`MEMORY_FLUSH_MESSAGE`): Real agent turn via `runAgentLoop()` with full default tool set. Agent uses `memory` tool to persist knowledge. Only runs when `aiEntries.length >= 8`. Uses default tools to preserve Bedrock prompt cache prefix alignment.
2. **Summarize** (`buildCompactionInstruction()`): LLM call with full message history as `MessageParam[]` produces structured checkpoint summary (10-section format).
3. **Parallel execution**: Steps 1 and 2 run concurrently via `Promise.all`.
4. **Turn-boundary cutting**: `findTurnBoundaryIndex()` scans from end counting user messages to find where last 10 turns begin. Guarantees no split `tool_use`/`tool_result` pairs.
5. **Entries before the boundary are deleted** from `entries[]` — both old AI conversation and older UI notifications (triage/cron/subagent/session-error) are discarded together. Kept entries are slimmed. Guard: must have >= 4 old messages.
6. Summary stored as `compactionSummary` and injected into system prompt.

**Why delete instead of marking `compacted: true`?** The model never reads old entries (they're filtered out), and the UI notification source data always lives in each subagent's own JSONL file (`~/.open-walnut/sessions/streams/<runId>.jsonl`). Retaining them only grew `chat-history.json` unboundedly (35 MB observed before the switch) and froze the Node event loop on every turn. The `compacted: true` marker is still checked defensively in `getModelContext()` for backward compatibility with older data, but new compactions never produce it.

**Defense layer**: `getModelContext()` strips any user message whose `tool_result` blocks have no matching `tool_use` in the preceding assistant message.

Both WebSocket auto-compaction and REST `/compact` endpoint share `createCompactionCallbacks()` factory in `src/web/routes/chat.ts`.
