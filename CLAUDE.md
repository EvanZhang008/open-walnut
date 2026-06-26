# Open Walnut — Personal Intelligent Butler

> **References**: [ARCHITECTURE.md](./ARCHITECTURE.md) | [src/core/AGENTS.md](./src/core/AGENTS.md) | [src/agent/AGENTS.md](./src/agent/AGENTS.md) | [web/src/AGENTS.md](./web/src/AGENTS.md) | [tests/AGENTS.md](./tests/AGENTS.md) | [src/logging/AGENTS.md](./src/logging/AGENTS.md)

## CRITICAL: Open Source Repository

**PUBLIC repo. Every commit is visible to the internet.**

No company-internal names, personal info, internal URLs, credentials, or internal processes. Generic descriptions only. Internal plugins go in `~/.open-walnut/plugins/` (never committed). **When in doubt, leave it out.**

## Multi-Agent Safety

- **NEVER** delete/revert other agents' changes or switch branches unless asked
- No `git stash`, no `git worktree` ops unless explicitly requested
- On "push": `git pull --rebase` OK. On "commit": scope to your changes only
- If build fails, retry — another agent may be mid-commit
- Bug investigations: read npm dep source + all related code before concluding
- Code style: brief comments for tricky logic; files under ~500 LOC

## Production Server Safety

**Port 3456 = PRODUCTION. NEVER kill, restart, or interfere.**

```bash
npm run dev:prod        # Build all → restart 3456 with latest code
npm run dev:ephemeral   # Ephemeral server (random port, temp data, auto-cleans)
```

## What Is Walnut

Personal AI butler: tasks + knowledge + AI sessions. **Tasks are the atom.** `Category → Project → Task → Subtask`. Event Bus connects everything. See [ARCHITECTURE.md](./ARCHITECTURE.md).

### Key Rules for Implementation

- `create_task type=task` requires category AND project to exist first
- Phase: `TODO` → … → `AGENT_COMPLETE` → … → `COMPLETE` (agent sets AGENT_COMPLETE, human marks COMPLETE)
- **NEVER force-kill Claude Code processes** — bypasses on-stop hook
- **Tasks & Sessions live in TWO surfaces — the Homepage panel is the PRIMARY one.** Both
  Tasks and Sessions render in (1) the **Homepage (`/`) side panels** — `TodoPanel` for
  tasks, `SessionPanel` for sessions — AND (2) the dedicated full pages (`/tasks` →
  `DashboardPage`/`TaskList`/`TaskCard`, `/sessions` → `SessionDetailPanel`). **Default to
  the Homepage panel** for any Task/Session work, demos, and recordings — it's what the
  user sees daily. The dedicated page is the **secondary** surface: still implement & test
  it for parity, but it's the second option, never the primary scenario.
- Concurrency: `tasks.json`/`sessions.json` use in-process + cross-process file locks

### Remote Session Daemon (resilience model)

**Topology:** walnut (Mac) ←ssh tunnel→ daemon (remote bun binary) ←spawn→ `claude -p` CLI. Goal: tunnel/daemon crashes don't lose sessions.

**Remote files:** `/tmp/open-walnut/sessions.json` (registry), `/tmp/open-walnut-streams/<sid>.{pipe,jsonl,pgid}`. JSONL is source of truth.

**CLI lifecycle (READ THIS — easy to get wrong):**
- `claude -p --input-format stream-json` is **LONG-RUNNING**, NOT per-turn. One CLI process stays alive across many messages, reading new input from its FIFO stdin between turns. (Evidence: a session with 39 messages had only 4 spawns.)
- The daemon holds the FIFO open with `O_RDWR` (`daemon-standalone.ts`) so the pipe survives between turns. Process is reaped only by the **idle timer** (`SESSION_IDLE_KILL_MS = 2h`, 5-min warning) or a real death (ENXIO / pid gone / crash) — never "turn ended".
- `isTurnCompleteExit()` does NOT mean turns exit. It only runs *inside* `reapSession()` to normalize the exit code *when a death already happened*, deciding if the last JSONL `result` line was a clean turn-end vs a crash.
- `--resume <sid>` is the **fallback** path (FIFO write failed / process really died), not the normal send path. Normal send = write the live FIFO.

**Delivery paths (where mid-turn injection breaks):** A send to a session walnut thinks is "processing" (`activeProcessing`) goes through `injectMidTurn` (gated on `targetSession.hasPipe`); otherwise `processNext` (writes the FIFO directly, no hasPipe gate). Pitfall: `RemoteSessionManager._hasPipe` is set `true` only in `start()` — `attach()` (used when reconnecting to an already-alive CLI after a daemon restart) returns `alive:true` but historically left `_hasPipe=false`, so `injectMidTurn` falsely reported "no FIFO pipe" and queued the message until the turn ended (25–55s grey stall). Keep `_hasPipe` in sync with daemon-authoritative liveness, not with spawn-vs-attach.

**Daemon restart:** old `cleanup()` leaves CLI alive. New daemon reconciles sessions.json then scans `.pgid` files — scan MUST skip sids already adopted (`if (sessions.has(sid)) continue`). All death paths funnel into `reapSession()` in `daemon-core.ts`; it calls `isTurnCompleteExit()` to normalize code to 0 when JSONL tail shows clean turn completion (otherwise every turn-end shows "exit -1" in UI).

**Keep in sync:** `daemon-standalone.ts` (bun binary) + `daemon-source.ts` (JS fallback). Build: `bash scripts/build-daemon.sh`.

**Auto-deploy (use this):** `DaemonConnection` compares local `.version` vs remote `binary --version`; if differs, gzips + chunks binary into 1MB pieces, each via separate SSH connection (bypasses corp proxy that kills >5MB transfers), retries 2x per chunk, falls back to 44KB source deploy if chunked binary fails. Just `npm run build && bash scripts/build-daemon.sh && npm run dev:prod` — next UI send to that host auto-upgrades (old CLI processes survive via Phase C).

**Never scp manually** — corp SSH proxy (WSSH) kills large transfers. That's exactly what the chunked auto-deploy solves.

**Debugging send/delivery latency (quick refs):**
- Both local (`__local__`) AND remote sessions go through the daemon / `RemoteSessionManager`. There is no separate "local" transport — don't assume a stall is SSH-specific.
- Logs: structured JSON at `/tmp/open-walnut/open-walnut-<date>.log` — but **timestamps are UTC** while the **filename is local date**, so a UTC-morning event lands in the *previous* local-day file. Filter by the UTC prefix, not the filename date.
- Daemon's own logs: `/tmp/open-walnut/daemon-d-*.log` (JSON). `state_transition` + `reconcile-adopt` show the long-running process being re-adopted across daemon restarts (proof of long-running CLI).
- Measure end-to-end honestly: `browser [send] dispatching` and `web session message via RPC` share the **same server-logger clock**, so pair them by `sessionId` (not by external `date`/bash time). Stages: `dispatching`→`session message via RPC`→`message enqueued`→`messages batched`→`message delivered`. The `deliveryMs` field only covers enqueue→delivered, so it *misses* any pre-enqueue event-loop lag.
- `scripts/walnut-logs.sh diagnose [sid] | busstorm [sid] | trace <sid> | pipe <sid> | session <sid> | delivery [sid] | slow [ms] | daemon <sid>` — see the log-toolkit section below. **For "send is slow", start with `diagnose <sid>` — it auto-labels the cause (Bug D mid-turn stall / event-loop starvation / slow resume).**

### Subsystem Map

| Subsystem | Entry point | Details |
|---|---|---|
| Agent loop & tools | `src/agent/` | [src/agent/AGENTS.md](./src/agent/AGENTS.md) |
| Sessions (local + SSH) | `src/providers/` | [ARCHITECTURE.md](./ARCHITECTURE.md) |
| Memory & search | `src/core/memory-*.ts` | [ARCHITECTURE.md](./ARCHITECTURE.md) |
| Event bus | `src/core/event-bus.ts` | [ARCHITECTURE.md](./ARCHITECTURE.md) |
| Subagents | `src/providers/` | [ARCHITECTURE.md](./ARCHITECTURE.md) |
| Cron | `src/core/cron/` | [ARCHITECTURE.md](./ARCHITECTURE.md) |
| Plugins | `src/core/integration-*.ts` | [ARCHITECTURE.md](./ARCHITECTURE.md) |
| Web GUI | `src/web/`, `web/src/` | [web/src/AGENTS.md](./web/src/AGENTS.md) |
| Chat history | `src/core/chat-history.ts` | [src/core/AGENTS.md](./src/core/AGENTS.md) |
| Usage tracking | `src/core/usage/` | [ARCHITECTURE.md](./ARCHITECTURE.md) |
| Git sync | `src/integrations/git-sync.ts` | [ARCHITECTURE.md](./ARCHITECTURE.md) |

## Development

```bash
npm run build                 # Build server → dist/
cd web && npx vite build      # Build React SPA
cd web && npx vite            # Frontend hot reload (:5173, proxies to :3456)
npm test                      # All tests (parallel)
```

## E2E-First Development

**Before writing ANY code, design E2E verification first.**

- Bug fix: Playwright repro → fix → verify same flow → commit
- Feature: define E2E scenarios → implement → build → Playwright verify → commit
- **NEVER** commit UI changes without Playwright verification
- **NEVER** use `page.goto()` — use real UI clicks (SPA navigation)
- Use `/verify` after implementation

## Testing

Every feature needs 1+ real E2E test through `startServer({ port: 0, dev: true })`. Only mock the Claude CLI. See [tests/AGENTS.md](./tests/AGENTS.md).

## Conventions

Plans: architecture diagrams first → UX scenarios → pseudocode. No detailed implementation code in plans.

### Frontend logging: `import { log } from '@/utils/log'`

Use the structured logger (`log.info('subsystem', 'message', { sessionId, taskId })`) — never raw `console.log`. IDs must be **full, never truncated** so `grep <sessionId>` traces across browser + server. The logger routes through `console.log`/`warn`/`error` which the browser-logger monkey-patch forwards to `/tmp/open-walnut/`. Never use `console.debug` (invisible to forwarder).

## Log investigation toolkit: `scripts/walnut-logs.sh`

One entry point for digging through Walnut logs (structured JSON at `/tmp/open-walnut/open-walnut-<date>.log`). Needs `jq`.

```bash
scripts/walnut-logs.sh diagnose [sid] [mins]  # ⭐⭐ START HERE for "message is slow": auto-labels each send's cause
scripts/walnut-logs.sh busstorm [sid] [mins]  # ⭐ streaming fan-out per subscriber (verify interest-set / spot a storm)
scripts/walnut-logs.sh trace <sid>       # per-message timeline dispatch→RPC→enqueue→route→delivered + Δms/hasPipe/path
scripts/walnut-logs.sh pipe <sid>        # hasPipe / lifecycle transitions — why a send was queued
scripts/walnut-logs.sh session <sid>     # full timeline for a session
scripts/walnut-logs.sh delivery [sid]    # message enqueue→delivered latency (deliveryMs)
scripts/walnut-logs.sh slow [ms]         # deliveries slower than ms (default 3000) — find lag
scripts/walnut-logs.sh daemon <sid>      # which daemon-d-*.log serves a sid
scripts/walnut-logs.sh jsonl <sid>       # tail the session's CLI .jsonl stream
scripts/walnut-logs.sh req <id> | task <id> | errors [n] | tail [n]
```

**When a user reports "message send is slow", run `diagnose <sid>` first.** It pairs each message's enqueue→route→delivered by `messageId` and prints a labelled cause per message + p50/p90, so you don't hand-grep. Labels it distinguishes (these are the known distinct root causes — don't conflate them):
- **BUG D: mid-turn stall** — `injectMidTurn` on a stale `hasPipe=False` (remote sessions). The felt 30–50s QUEUED. Fixed by delegating to processNext; if this label reappears, the fix regressed.
- **EVENT-LOOP STARVATION** — dispatch→enqueue blocked. Was caused by streaming fan-out to global subscribers; fixed by the event-bus `interest` set. Cross-check with `busstorm`.
- **SLOW RESUME** — CLI dead, cold `--resume` path (inherently slower, not a bug).
- **SLOW DELIVER / STUCK** — catch-alls; fall back to `trace`/`pipe` for the timeline.

Both `diagnose` and `busstorm` default to a **30-min window** (so old historical stalls don't masquerade as "happening now"); pass a 3rd arg `mins` (e.g. `120`, or `0` for all-time) to widen it. Timestamps are UTC.

Message-send latency is logged as `message delivered {deliveryMs, path, messageId}` at every delivery point (`path` = stdin / mid-turn / resume). `messageId` (`qm-…`) is the cross-layer request id — grep it to trace one message end-to-end.

## Debugging the Claude Code CLI (stuck / silent sessions)

When a session goes `idle` with no output, gets stuck mid-turn, or the CLI appears hung, check **Claude Code's own trace log**. Walnut passes `--debug` to every `claude -p` spawn by default, so this log is always available.

```bash
WALNUT_CLAUDE_DEBUG=0 npm run dev:prod    # opt out if you need to
```

The flag is added in `src/providers/claude-code-session.ts`. Works for both local and remote (daemon) sessions; args are forwarded through the daemon unchanged.

**Where logs land:**

| Session type | Path |
|---|---|
| Local | `~/.claude/debug/<claude-session-id>.txt` |
| Remote (daemon on clouddev etc.) | `~/.claude/debug/<claude-session-id>.txt` **on the remote host** |

A `latest` symlink in the same dir always points at the most recent file.

```bash
tail -F ~/.claude/debug/latest                         # follow local
ssh clouddev tail -F '~/.claude/debug/latest'          # follow remote
```

**Verbosity knobs** (also env vars — export before `npm run dev:prod`; for remote, set them where the daemon was started):

- `CLAUDE_CODE_DEBUG_LOG_LEVEL=verbose` — include high-volume diagnostics (statusLine, shell, cwd, stdout/stderr). Default is `debug`, which filters those out.
- `CLAUDE_CODE_DEBUG_LOGS_DIR=/some/path` — override the `~/.claude/debug/` directory.
- `OTEL_LOG_TOOL_DETAILS=1` — capture full tool input/output in OTEL spans (separate from the `--debug` file).

**CLI flags** the fork supports (in case you want to invoke `claude` manually to repro):

- `--debug` / `-d` — enable debug mode (what Walnut injects)
- `--debug-file <path>` — write to a specific file (implicitly enables debug)
- `--debug-to-stderr` / `-d2e` — write debug to stderr instead of a file

The implementation lives in the fork at `~/workplace/myCode/claude-code-fork/claude-code-source-code/src/utils/debug.ts` — `logForDebugging()` is called throughout the CLI. All flags are already compiled into `fork-2.1.88`; no rebuild required.

### The "malware reminder" on every file read

If you're seeing `<system-reminder>Whenever you read a file, you should consider whether it would be considered malware…</system-reminder>` appended to every `Read` tool result, that's **not Walnut** — it's `@anthropic-ai/claude-agent-sdk`'s `CYBER_RISK_MITIGATION_REMINDER`. The SDK injects it unless the active main-loop model is in a hardcoded exempt set. Upstream only lists `claude-opus-4-6`; newer models (4.7, Sonnet, …) get the reminder on every read, eating context.

We maintain a `patch-package` patch at `patches/@anthropic-ai+claude-agent-sdk+<version>.patch` that **disables the reminder for all models** — it rewrites the ternary `X4z()?j4z:""` in the minified bundle to just `""`, so no file read ever appends the reminder regardless of main-loop model. It reapplies automatically on `npm install` via `postinstall`. When bumping the SDK version: re-apply the edit to `node_modules/@anthropic-ai/claude-agent-sdk/cli.js` (grep for `considered malware` to locate the template literal, then find and rewrite the ternary that conditionally appends it) and regenerate with `npx patch-package @anthropic-ai/claude-agent-sdk`.
