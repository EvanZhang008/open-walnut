#!/usr/bin/env bun
'use strict'

/**
 * walnut-daemon — Remote session manager for Open Walnut.
 *
 * Runs as a persistent server on the remote machine.
 * Manages Claude CLI processes and streams output via WebSocket.
 *
 * Usage:
 *   bun daemon-standalone.ts --start      # Start daemon, print port to stdout
 *   bun daemon-standalone.ts --stop       # Stop running daemon
 *   bun daemon-standalone.ts --status     # Check if daemon is running
 *   bun daemon-standalone.ts --version    # Print version and exit
 *
 * Protocol: JSON over WebSocket
 *   Client → Daemon: { id, cmd, ...params }
 *   Daemon → Client: { id, ok, ...data } or { ev, ...data }
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn, execSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import type { ServerWebSocket } from 'bun'
import {
  createDaemonCore,
  defaultReadStartTime,
  shouldAutoRespond,
  buildControlResponse,
  type CoreSessionData,
  type RegistryEntry as CoreRegistryEntry,
  type SessionMode,
  type PendingCtrl,
} from './daemon-core.js'
import { REQUIRED_DAEMON_CAPABILITIES } from './daemon-capabilities.js'
import { computeGitDiff, GitDiffError, type GitDiffBase } from './git-diff-core.js'
import { execFile as execFileCb } from 'node:child_process'

// ── Version ──
// Baked in at compile time via `bun build --define` (see scripts/build-daemon.sh).
const DAEMON_VERSION = process.env.DAEMON_VERSION || 'dev'

if (process.argv.includes('--version')) {
  console.log(DAEMON_VERSION)
  process.exit(0)
}

// ── Constants ──
// DAEMON_DIR default is /tmp/open-walnut; tests override via env var.
// Must mirror daemon-source.ts (the JS fallback) — keep in sync.
const DAEMON_DIR = process.env.WALNUT_DAEMON_DIR || '/tmp/open-walnut'
// Streams live in a sibling dir so an isolated demo daemon (WALNUT_DAEMON_DIR=
// /tmp/open-walnut-demo) gets /tmp/open-walnut-demo-streams automatically, while
// production stays at /tmp/open-walnut-streams (byte-identical default).
const STREAMS_DIR = process.env.WALNUT_STREAMS_DIR || `${DAEMON_DIR}-streams`
// Home dir used to expand `~/...` paths from the app (e.g. ~/.claude/projects/...).
// In production this is the real HOME (daemon runs as the same user as walnut, so both
// resolve `~` identically). WALNUT_HOME_OVERRIDE lets a test point the daemon at the same
// throwaway home its mocked CLAUDE_HOME lives under, so `~/.claude` on both sides agree —
// without it, the daemon (a separate process) would read the real ~/.claude and never see
// the test fixtures. Same env-override pattern as WALNUT_DAEMON_DIR / WALNUT_STREAMS_DIR.
const HOME_DIR = process.env.WALNUT_HOME_OVERRIDE || process.env.HOME || '/root'
const PORT_FILE = path.join(DAEMON_DIR, 'daemon.port')
const PID_FILE = path.join(DAEMON_DIR, 'daemon.pid')
const INSTANCE_ID_FILE = path.join(DAEMON_DIR, 'daemon.instance')
// Written by the RUNNING daemon at startup. This is the source of truth for
// upgrade decisions: DaemonConnection.shouldUpgradeDaemon `cat`s this file
// instead of executing the on-disk binary's --version, because the on-disk
// binary can be stale while a source-deployed (daemon.cjs) daemon is what's
// actually running — probing the binary then caused an infinite
// stop/redeploy loop that killed the live daemon every cycle.
const VERSION_FILE = path.join(DAEMON_DIR, 'daemon.version')
const AGENT_POLL_INTERVAL_MS = 2000
const AGENT_REDISCOVER_INTERVAL_MS = 10000
const HEARTBEAT_INTERVAL_MS = 30_000

// ── Daemon Instance ID ──
// Unique per daemon lifetime. Short hash of port+pid+startTs so it fits in log
// lines without dominating. Written to daemon.instance so clients can verify
// they're talking to the same daemon they expected (detect PID reuse / swap).
const DAEMON_START_TS = Date.now()
const DAEMON_INSTANCE_ID = (() => {
  const seed = `${process.pid}-${DAEMON_START_TS}-${Math.random()}`
  const hash = crypto.createHash('sha256').update(seed).digest('hex').slice(0, 8)
  return `d-${process.pid}-${hash}`
})()
const LOG_FILE = path.join(DAEMON_DIR, `daemon-${DAEMON_INSTANCE_ID}.log`)

// ── PATH setup ──
// When running as a compiled binary, the daemon starts with a bare PATH.
// Discover common tool locations so spawned CLI processes (claude, node) work.
// Claude CLI (#!/usr/bin/env node) needs BOTH claude AND node in PATH.
;(() => {
  const home = process.env.HOME || '/root'
  const extraPaths = [
    // toolbox FIRST: on some hosts it ships a logged-in `claude` that must win
    // over a separate ~/.local/bin/claude install (which may be NOT logged in).
    // These are only a fallback for when RC sourcing fails to provide claude.
    `${home}/.toolbox/bin`,           // toolbox
    `${home}/.local/bin`,              // Claude CLI default install location
    `${home}/.npm-global/bin`,         // npm global
    `${home}/.cargo/bin`,              // Rust tools
    `${home}/.pyenv/shims`,           // pyenv (node via pyenv)
    `${home}/.bun/bin`,               // bun
    // Standard system paths as safety net. Primary source is the user's RC files
    // (.zshrc / .bashrc), which typically include system dirs and are sourced in the
    // extraPaths retrieval above. These fallback paths ensure basic commands work
    // if RC sourcing fails.
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/local/sbin',
    '/usr/sbin',
    '/sbin',
  ]

  // Try sourcing shell RC to get full PATH (nvm, fnm, volta, pyenv, etc.)
  // Try both .zshrc and .bashrc since $SHELL may not be set in daemon context
  const rcFiles = [`${home}/.zshrc`, `${home}/.bashrc`]
  let pathFromRc = ''

  for (const rcFile of rcFiles) {
    try {
      if (!fs.existsSync(rcFile)) continue
      // Use /bin/bash to source (works for both .bashrc and most .zshrc)
      // Some .zshrc uses zsh-specific syntax, so try zsh first if available
      const shells = rcFile.endsWith('.zshrc')
        ? ['/bin/zsh', '/usr/bin/zsh', '/bin/bash']
        : ['/bin/bash', '/bin/sh']
      for (const shell of shells) {
        try {
          if (!fs.existsSync(shell)) continue
          const result = execSync(
            `source ${JSON.stringify(rcFile)} 2>/dev/null; echo "$PATH"`,
            { encoding: 'utf-8', shell, timeout: 5000 },
          ).trim()
          if (result && result.includes('/') && result.length > 20) {
            pathFromRc = result
            break
          }
        } catch { continue }
      }
      if (pathFromRc) break
    } catch { continue }
  }

  // Merge all paths: extras + RC-sourced + current PATH
  // Note: node discovery is NOT done here — it's handled by buildSpawnPreamble()
  // at session spawn time, which properly activates nvm/pyenv shell functions.
  const allPaths = [
    ...extraPaths,
    ...(pathFromRc ? pathFromRc.split(':') : []),
    ...(process.env.PATH || '').split(':'),
  ].filter(Boolean)

  // Deduplicate while preserving order
  const seen = new Set<string>()
  const deduped = allPaths.filter(p => { if (seen.has(p)) return false; seen.add(p); return true })
  process.env.PATH = deduped.join(':')
})()

// ── Types ──
// L2: per-session background-task state. `resourceVersion` = byte offset of the latest
// applied event (monotonic, rebuildable from the jsonl). Served on `getState`.
interface TaskStateEntry { status: string; v: number; t: number; description?: string }
interface TaskState {
  tasks: Record<string, TaskStateEntry>
  resourceVersion: number
  updatedAt: number
  derivedRunning: number
  recentTransitions: Array<{ taskId: string; status: string; v: number; t: number }>
}

interface SessionData {
  proc: ChildProcess | null
  pipePath: string
  jsonlPath: string
  pgidPath: string
  pid: number | null
  offset: number
  // L2: daemon-authoritative background-task state, materialized from task_* events in the
  // watcher loop and served on the `getState` RPC. Rebuilt from jsonl on adopt/discover.
  taskState: TaskState
  // Session-bound file tailer. Lifecycle = session process lifetime. NOT tied
  // to any WebSocket. Closed only by reapSession or daemon shutdown.
  watcher: { pollTimer: ReturnType<typeof setInterval>; offset: number } | null
  // Clients currently receiving push events. Add on cmdAttach/cmdStart,
  // remove on ws.close. Watcher is unaffected by subscriber churn — this
  // replaces the old per-ws watcher Map that tied file-tailing to WS
  // lifetime and caused "no watchers after reconnect" streaming loss.
  subscribers: Set<ServerWebSocket<WsData>>
  exitCode: number | null
  // Phase B/C additions: daemon is the single source of truth for CLI/FIFO
  // lifecycle. `state` is the authoritative flag; `exitCode !== null` was
  // previously the only death signal but 3 different code paths toggled it,
  // which made idempotent cleanup hard. `parented=false` means the session
  // was adopted from the on-disk registry (e.g. across daemon restarts).
  state: 'running' | 'dead'
  exitReason: string | null
  exitedAt: number | null
  parented: boolean
  startTime: string | null  // /proc/<pid>/stat start_time snapshot (Linux)
  cwd: string
  args: string[]
  orphanPollTimer: ReturnType<typeof setInterval> | null
  mode: SessionMode
  pendingCtrl: PendingCtrl | null
  spawnTs?: number   // latency instrumentation: CLI spawn ts
  sawInit?: boolean  // latency instrumentation: first init line seen
}

interface AgentSub {
  files: Map<string, { offset: number }>
  timer: ReturnType<typeof setInterval> | null
  rediscoverTimer: ReturnType<typeof setInterval> | null
  ws: ServerWebSocket<WsData>
  sid: string
  agent: string
  team?: string
}

interface WsData {
  /** Per-socket FIFO of payloads Bun refused to send (backpressure). Flushed on drain. */
  sendQueue?: string[]
  /** Total bytes currently held in sendQueue (for the overflow guard). */
  sendQueueBytes?: number
}

// DUP-DEBUG: per-process counter and lookup map for stable ws ids.
// Lets logs distinguish "same ws received twice" from "two different ws each
// received once" — critical for diagnosing the daemon→walnut duplicate-event
// bug where stderr_tail and tool_use both arrived twice on a single conn.
let __wsIdCounter = 0
const __wsIds = new WeakMap<ServerWebSocket<WsData>, number>()
function wsId(ws: ServerWebSocket<WsData>): number {
  let id = __wsIds.get(ws)
  if (id === undefined) {
    id = ++__wsIdCounter
    __wsIds.set(ws, id)
  }
  return id
}

// ── Logging ──
// Every log line includes DAEMON_INSTANCE_ID so `grep <id> daemon-*.log`
// isolates one daemon's lifetime even when multiple daemons have run.
function logMsg(level: string, msg: string, data?: Record<string, unknown>) {
  const entry = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    instanceId: DAEMON_INSTANCE_ID,
    ...data,
  })
  try { fs.appendFileSync(LOG_FILE, entry + '\n') } catch {}
  if (level === 'error') console.error(msg, data || '')
}

/**
 * Structured state-transition log. Emit BEFORE mutating state so the log line
 * is ordered with the mutation. Every lifecycle flip (session, FIFO, CLI
 * process, daemon itself) should flow through this.
 */
function logStateTransition(
  sid: string,
  oldState: string,
  newState: string,
  reason: string,
  source: string,
  extra?: Record<string, unknown>,
): void {
  logMsg('info', 'state_transition', {
    sid,
    oldState,
    newState,
    reason,
    source,
    ...(extra || {}),
  })
}

// ── Process group helpers ──
// Claude is spawned with detached:true, so pid === PGID.
// kill(-pid) sends signal to the entire process group (Claude + MCP servers).

/** Send a signal to an entire process group. Returns true if signal was delivered. */
function killProcessGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal)
    return true
  } catch {
    return false
  }
}

/** Check if any process in the group is still alive. */
function isProcessGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * 3-phase kill sequence for a process group:
 *   1. SIGINT  → wait 5s (graceful shutdown, on-stop hooks)
 *   2. SIGTERM → wait 2s (forceful but clean)
 *   3. SIGKILL → nuclear (guaranteed death)
 */
function killSessionProcessGroup(pid: number, sid: string) {
  if (!isProcessGroupAlive(pid)) return

  logMsg('info', 'kill sequence: SIGINT', { sid, pid })
  killProcessGroup(pid, 'SIGINT')

  setTimeout(() => {
    if (!isProcessGroupAlive(pid)) return
    logMsg('info', 'kill sequence: SIGTERM', { sid, pid })
    killProcessGroup(pid, 'SIGTERM')

    setTimeout(() => {
      if (!isProcessGroupAlive(pid)) return
      logMsg('warn', 'kill sequence: SIGKILL', { sid, pid })
      killProcessGroup(pid, 'SIGKILL')
    }, 2000)
  }, 5000)
}

// ── Shell helpers ──

/** Shell-quote a string for safe embedding in a sh command. */
function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'"
}

/**
 * Build a shell preamble that activates the user's full dev environment.
 *
 * Mirrors the REMOTE_BASE_PATH approach from session-io.ts:
 *   1. Source shell RC files (.bashrc/.zshrc) to activate nvm/pyenv/volta
 *   2. Fallback: source nvm.sh directly and try each version (with GLIBC check)
 *
 * This ensures `node` is available for Claude CLI (#!/usr/bin/env node),
 * even on hosts where nvm binaries need newer GLIBC than the system provides.
 */
function buildSpawnPreamble(): string {
  return [
    // Source RC files FIRST, then add our paths — RC files may hard-reset PATH
    // (e.g. zsh `export PATH=; path=(...)`) which would clobber earlier prepends.
    // Redirect >/dev/null suppresses stdout only — stderr flows to .jsonl.err
    // for debugging. Stdout suppression is load-bearing: the spawned process's
    // stdout IS the JSONL output file, so interactive plugins (oh-my-zsh, p10k)
    // would corrupt the stream with escape codes.
    'case "$SHELL" in'
      + ' */zsh) [ -f "$HOME/.zshrc" ] && . "$HOME/.zshrc" >/dev/null ;;'
      + ' */bash) [ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc" >/dev/null ;;'
      + ' esac',
    // APPEND (not prepend) common tool dirs as a fallback. Prepending used to
    // shadow a user's RC-ordered `claude` (e.g. ~/.toolbox/bin/claude, which is
    // logged in) with ~/.local/bin/claude (a separate, NOT-logged-in install),
    // causing "Not logged in · Please run /login". The sourced RC above already
    // sets the user's intended PATH order; these dirs only fill gaps when claude
    // /node aren't on the RC PATH at all.
    'export PATH="$PATH:$HOME/.toolbox/bin:$HOME/.local/bin:$HOME/.npm-global/bin"',
    'node -v >/dev/null 2>&1 || {'
      + ' if [ -s "$HOME/.nvm/nvm.sh" ]; then'
      + '   . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1;'
      + '   node -v >/dev/null 2>&1 || {'
      // nvm default may be compiled against a newer GLIBC than the host provides
      // (e.g. node 18+ needs GLIBC 2.27+ but AL2 has 2.26). Try each installed
      // version in reverse order until one actually executes.
      + '     for v in $(ls -1r "$NVM_DIR/versions/node/" 2>/dev/null); do'
      + '       nvm use --delete-prefix "$v" >/dev/null 2>&1 && node -v >/dev/null 2>&1 && break;'
      + '     done; };'
      + ' elif [ -x "$HOME/.fnm/fnm" ]; then eval "$("$HOME/.fnm/fnm" env)" >/dev/null 2>&1;'
      + ' elif [ -d "$HOME/.volta" ]; then export PATH="$HOME/.volta/bin:$PATH";'
      + ' elif [ -s "$HOME/.asdf/asdf.sh" ]; then . "$HOME/.asdf/asdf.sh" >/dev/null 2>&1;'
      + ' fi;'
      + ' true; }',
  ].join('; ')
}

// ── Permission Policy FIFO Writer ──
//
// Used by the auto-allow path (which bypasses cmdSendRaw / daemon-core). Must
// handle payloads larger than PIPE_BUF (512B on macOS) — a control_response
// embedding a tool input can easily exceed that. See writeFifoFully docs in
// daemon-core.ts for why a single non-blocking writeSync isn't safe.
function writeFifoRaw(pipePath: string, raw: string): boolean {
  try {
    const buf = Buffer.from(raw.endsWith('\n') ? raw : raw + '\n')
    let fd: number
    try {
      fd = fs.openSync(pipePath, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENXIO') return false
      throw err
    }
    try {
      let offset = 0
      let consecutiveEagain = 0
      while (offset < buf.length) {
        try {
          const n = fs.writeSync(fd, buf, offset, buf.length - offset)
          if (n > 0) { offset += n; consecutiveEagain = 0; continue }
          consecutiveEagain++
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'EAGAIN') {
            consecutiveEagain++
          } else {
            throw err
          }
        }
        if (consecutiveEagain >= 50) return false
        try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10) } catch {}
      }
      return true
    } finally {
      try { fs.closeSync(fd) } catch {}
    }
  } catch {
    return false
  }
}

// ── Managed Sessions ──
const sessions = new Map<string, SessionData>()

// ── WebSocket connections ──
const wsClients = new Set<ServerWebSocket<WsData>>()

// ── Write-ahead Registry (Phase C) ──
// Persists the daemon's session inventory to disk before returning spawn() to
// the caller. After a daemon crash/restart, reconcile() reads this file and
// for each entry probes kill(pid,0) to decide adopt vs reap. Implementation
// lives in daemon-core.ts (dependency-injected, unit-testable); this file
// only provides Bun-specific I/O bindings.
const REGISTRY_FILE = path.join(DAEMON_DIR, 'sessions.json')
type RegistryEntry = CoreRegistryEntry

// ── Agent subscriptions ──
const agentSubs = new Map<string, AgentSub>()

// Current byte size of a stream file, 0 if missing. Used as the adopt-time
// watcher offset so a new daemon generation never replays history it didn't
// stream itself. Keep in sync with daemon-source.ts (CLAUDE.md).
function statSizeOrZero(p: string): number {
  try { return fs.statSync(p).size } catch { return 0 }
}

// ── L2: daemon-authoritative per-session task state (the k8s `.status` object) ──
// The daemon sits closest to the CLI and persists every event in the append-only jsonl, so
// it is the natural source of truth for background-task state. It materializes `taskState`
// by applying task_* events with the SAME idempotent, terminal-is-terminal rules Walnut uses
// (so the two never disagree), and serves it on the `getState` RPC. Walnut PULLs it to
// reconcile a lost-terminal event WITHOUT guessing liveness. `resourceVersion` = the event's
// byte offset `v` — monotonic, and rebuildable from the jsonl after a daemon restart.
// MUST stay byte-for-byte equivalent to daemon-source.ts (CLAUDE.md). See
// docs/plan/daemon-source-of-truth-versioned-events.md.
const BG_TERMINAL_STATUSES = new Set(['completed', 'failed', 'stopped', 'cancelled'])
const BG_TRANSITION_CAP = 50 // recentTransitions ring buffer bound

function emptyTaskState(): TaskState {
  return { tasks: {}, resourceVersion: 0, updatedAt: 0, derivedRunning: 0, recentTransitions: [] }
}

function runningTaskCount(ts: TaskState): number {
  let n = 0
  for (const id in ts.tasks) if (!BG_TERMINAL_STATUSES.has(ts.tasks[id].status)) n++
  return n
}

// Apply one parsed jsonl line to the task state. Idempotent: duplicate / out-of-order /
// new-kind events all converge. `v` is the line's byte-offset version; `now` is wall-clock.
// Returns true if a task transition was recorded (for logging). Mirrors Walnut's four handlers.
function applyTaskEvent(ts: TaskState, parsed: Record<string, unknown>, v: number, now: number): boolean {
  if (parsed.type !== 'system') return false
  const subtype = parsed.subtype as string | undefined
  const taskId = parsed.task_id as string | undefined
  if (!subtype || !taskId) return false
  const prev = ts.tasks[taskId]
  let nextStatus: string | undefined
  if (subtype === 'task_started') {
    // Terminal is terminal: a late/duplicate start can't revive a finished task.
    nextStatus = prev && BG_TERMINAL_STATUSES.has(prev.status) ? prev.status : 'running'
  } else if (subtype === 'task_progress') {
    nextStatus = prev && BG_TERMINAL_STATUSES.has(prev.status) ? prev.status : 'running'
  } else if (subtype === 'task_updated') {
    const patch = parsed.patch as Record<string, unknown> | undefined
    const ps = patch?.status as string | undefined
    nextStatus = ps ?? prev?.status ?? 'running'
  } else if (subtype === 'task_notification') {
    nextStatus = (parsed.status as string | undefined) ?? prev?.status ?? 'running'
  } else {
    return false
  }
  const wasTerminal = prev ? BG_TERMINAL_STATUSES.has(prev.status) : false
  const isTerminal = BG_TERMINAL_STATUSES.has(nextStatus)
  ts.tasks[taskId] = { status: nextStatus, v, t: now, description: (parsed.description as string | undefined) ?? prev?.description }
  if (v > ts.resourceVersion) ts.resourceVersion = v
  ts.updatedAt = now
  ts.derivedRunning = runningTaskCount(ts)
  // Record only genuine transitions into a terminal state (the bookend that matters for recovery).
  if (!wasTerminal && isTerminal) {
    ts.recentTransitions.push({ taskId, status: nextStatus, v, t: now })
    if (ts.recentTransitions.length > BG_TRANSITION_CAP) ts.recentTransitions.shift()
    return true
  }
  return false
}

// Rebuild task state from scratch by replaying the whole jsonl. Used on adopt/discover (a new
// daemon generation has no in-memory state) — the jsonl is the durable log, so this recovers
// the exact state the previous generation held, including any terminal events Walnut's live
// stream missed. `v` is computed identically to the watcher (end-of-line byte offset).
function rebuildTaskStateFromJsonl(jsonlPath: string, now: number): TaskState {
  const ts = emptyTaskState()
  let text: string
  try { text = fs.readFileSync(jsonlPath, 'utf-8') } catch { return ts }
  let lineStartV = 0
  for (const line of text.split('\n')) {
    const v = lineStartV + Buffer.byteLength(line, 'utf-8') + 1
    lineStartV = v
    if (!line.trim() || !line.includes('"task_')) continue
    try { applyTaskEvent(ts, JSON.parse(line) as Record<string, unknown>, v, now) } catch {}
  }
  return ts
}

// ── daemon-core wiring ──
// SessionData already extends CoreSessionData (same field names). Core reaps,
// persists, and reconciles in pure functions; we inject the Bun-specific
// broadcast + kill + readStartTime deps.
const core = createDaemonCore<SessionData>({
  fs,
  clock: () => Date.now(),
  killFn: (pid, sig) => { process.kill(pid, sig as NodeJS.Signals) },
  readStartTimeFn: (pid) => defaultReadStartTime(fs, pid),
  killProcessGroupFn: killProcessGroup,
  streamsDir: STREAMS_DIR,
  registryFile: REGISTRY_FILE,
  orphanPollIntervalMs: 1000,
  logger: logMsg,
  broadcastSessionStateFn: (payload) => {
    for (const client of wsClients) {
      sendEvent(client, 'session_state', payload)
    }
  },
  broadcastExitToWatchersFn: (session, code, stderrTail) => {
    // Fan exit to all current subscribers, then close watcher + clear set.
    for (const client of session.subscribers) {
      sendEvent(client, 'exit', { sid: sessionSidOf(session), code, stderr: stderrTail })
    }
    stopSessionWatcher(sessionSidOf(session))
    session.subscribers.clear()
  },
  sessions,
  createAdoptedSession: (_sid, entry) => ({
    proc: null,
    pipePath: entry.pipePath,
    jsonlPath: entry.jsonlPath,
    pgidPath: entry.pgidPath,
    pid: entry.pid,
    // Adopt at the CURRENT end of the stream file, not 0. The previous daemon
    // generation already fanned out everything before this point; starting the
    // watcher at 0 made it re-emit the entire file to every subscriber (UI
    // symptom: whole conversation replays after a daemon restart). Subscribers
    // that genuinely need history request it via attach fromOffset.
    offset: statSizeOrZero(entry.jsonlPath),
    // Rebuild task state from the durable jsonl — recovers terminal events the previous
    // daemon generation saw (and Walnut's live stream may have missed across the restart).
    taskState: rebuildTaskStateFromJsonl(entry.jsonlPath, Date.now()),
    watcher: null,
    subscribers: new Set(),
    exitCode: null,
    state: 'running',
    exitReason: null,
    exitedAt: null,
    parented: false,
    startTime: entry.startTime,
    cwd: entry.cwd ?? '',
    args: entry.args ?? [],
    orphanPollTimer: null,
    mode: entry.mode ?? 'default',
    pendingCtrl: entry.pendingCtrl ?? null,
  }),
})

// Back-reference lookup — the exit-watcher broadcast needs sid from session,
// but SessionData doesn't store it. Reverse-index once at call time.
function sessionSidOf(session: SessionData): string {
  for (const [sid, s] of sessions) if (s === session) return sid
  return ''
}

// Expose primitive names for the rest of the file (no large rewrite needed).
const readRegistry = core.readRegistry
const persistRegistry = core.persistRegistry
const readStartTime = core.readStartTime
const broadcastSessionState = core.broadcastSessionState
const reapSession = core.reapSession
const startOrphanPoll = core.startOrphanPoll
const reconcileRegistry = core.reconcileRegistry

// Daemon NEVER auto-exits. It's a permanent process manager on the remote host.
// Mac disconnecting should NOT cause daemon to exit — sessions keep running.
// Session lifecycle is managed by the session idle scanner (scanIdleSessions).

// ── Session management commands ──

function handleCommand(ws: ServerWebSocket<WsData>, msg: string) {
  let cmd: Record<string, unknown>
  try { cmd = JSON.parse(msg) } catch { return sendError(ws, null, 'invalid JSON') }
  const { id } = cmd

  // Structured per-command receive log. Traces (traceId) originate at walnut
  // and propagate through the daemon → CLI spawn. Logging on receive gives us
  // the first server-side timestamp for a command, pairing with walnut's
  // `enqueue` line and the eventual `jsonl` forward.
  const traceId = typeof cmd.traceId === 'string' ? cmd.traceId : undefined
  const sid = typeof cmd.sid === 'string' ? cmd.sid : undefined
  if (cmd.cmd !== 'ping') {
    // ping is high-frequency keepalive — log spam if we trace it
    logMsg('debug', 'cmd_recv', { cmd: cmd.cmd, id, sid, traceId })
  }

  switch (cmd.cmd) {
    case 'start': return cmdStart(ws, id as number, cmd)
    case 'attach': return cmdAttach(ws, id as number, cmd)
    case 'send': return cmdSend(ws, id as number, cmd)
    case 'sendRaw': return cmdSendRaw(ws, id as number, cmd)
    case 'stop': return cmdStop(ws, id as number, cmd)
    case 'setMode': return cmdSetMode(ws, id as number, cmd)
    case 'status': return cmdStatus(ws, id as number, cmd)
    case 'getState': return cmdGetState(ws, id as number, cmd)
    case 'rename': return cmdRename(ws, id as number, cmd)
    case 'read-history': return cmdReadHistory(ws, id as number, cmd)
    case 'subscribe-agent': return cmdSubscribeAgent(ws, id as number, cmd)
    case 'unsubscribe-agent': return cmdUnsubscribeAgent(ws, id as number, cmd)
    case 'write-inbox': return cmdWriteInbox(ws, id as number, cmd)
    case 'fs.read': return cmdFsRead(ws, id as number, cmd)
    case 'fs.write': return cmdFsWrite(ws, id as number, cmd)
    case 'fs.ls': return cmdFsLs(ws, id as number, cmd)
    case 'fs.find': return cmdFsFind(ws, id as number, cmd)
    case 'fs.stat': return cmdFsStat(ws, id as number, cmd)
    case 'fs.readRange': return cmdFsReadRange(ws, id as number, cmd)
    case 'git.diff': return cmdGitDiff(ws, id as number, cmd)
    case 'list': return cmdList(ws, id as number)
    case 'ping': return sendOk(ws, id as number, { pong: true })
    case 'hello': return sendOk(ws, id as number, {
      version: DAEMON_VERSION,
      capabilities: REQUIRED_DAEMON_CAPABILITIES,
      instanceId: DAEMON_INSTANCE_ID,
      startedAt: DAEMON_START_TS,
      uptimeSec: Math.floor((Date.now() - DAEMON_START_TS) / 1000),
    })
    default: return sendError(ws, id as number, 'unknown command: ' + cmd.cmd)
  }
}

// ── Start a Claude session ──
function cmdStart(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const { sid, args, cwd, message, resume, mode } = cmd as {
    sid: string; args: string[]; cwd: string; message: string; resume?: boolean; mode?: string
  }
  if (!sid || !args || !cwd || !message) {
    return sendError(ws, id, 'start: missing required fields (sid, args, cwd, message)')
  }

  // Validate cwd exists before spawning — prevents misleading ENOENT on /bin/bash
  // when the real issue is a non-existent working directory (e.g. local Mac path
  // sent to a remote Linux host).
  if (!fs.existsSync(cwd)) {
    return sendError(ws, id, `start: cwd does not exist on this host (${os.hostname()}): ${cwd}`)
  }

  // If a session with this sid already exists (e.g. adopted orphan still
  // running, or previous turn's process not yet reaped), clean it up BEFORE
  // overwriting sessions.set() below. Otherwise the old orphanPollTimer's
  // captured pid lingers and will misfire `pid-recycled` against our new pid
  // ~1s after spawn, killing every --resume-spawned process in a loop.
  const existing = sessions.get(sid)
  if (existing) {
    logMsg('warn', 'cmdStart: replacing existing session', {
      sid,
      oldPid: existing.pid,
      oldState: existing.state,
      oldHasOrphanPoll: !!existing.orphanPollTimer,
      resume: !!resume,
    })
    if (existing.orphanPollTimer) {
      try { clearInterval(existing.orphanPollTimer) } catch {}
      existing.orphanPollTimer = null
    }
    // Stop the old session's watcher BEFORE sessions.set() replaces the entry.
    // The poll timer looks up sessions.get(sid) fresh each tick — once the new
    // session lands under the same sid (state='running'), the old timer passes
    // the state guard and tails the same jsonl at its own closure offset:
    // TWO watchers fanning every line twice (doubled blocks after respawn),
    // and the old timer leaks forever because nothing else clears it.
    stopSessionWatcher(sid)
    // If the old pid is still alive, kill its process group. This is the old
    // adopted orphan; we must not leave it running while we point `sessions`
    // at a different pid, or the orphan becomes permanently un-reapable.
    if (existing.state === 'running' && existing.pid) {
      let oldAlive = false
      try { process.kill(existing.pid, 0); oldAlive = true } catch {}
      if (oldAlive) {
        logMsg('warn', 'cmdStart: killing old-session process group before respawn', {
          sid, oldPid: existing.pid,
        })
        try { process.kill(-existing.pid, 'SIGTERM') } catch {}
      }
    }
    // Mark dead so any late callbacks (subscribers, watchers) don't act on it.
    existing.state = 'dead'
    existing.exitReason = 'replaced-by-cmdstart'
    existing.exitedAt = Date.now()
  }

  fs.mkdirSync(STREAMS_DIR, { recursive: true })

  const pipePath = path.join(STREAMS_DIR, sid + '.pipe')
  const jsonlPath = path.join(STREAMS_DIR, sid + '.jsonl')
  const stderrPath = jsonlPath + '.err'
  const pgidPath = path.join(STREAMS_DIR, sid + '.pgid')

  // Record offset before spawn (for resume — only stream new data)
  let offset = 0
  if (resume) {
    try { offset = fs.statSync(jsonlPath).size } catch { offset = 0 }
  }

  // Create FIFO
  try { fs.unlinkSync(pipePath) } catch {}
  try { execSync('mkfifo ' + JSON.stringify(pipePath)) } catch (err: unknown) {
    return sendError(ws, id, 'mkfifo failed: ' + (err as Error).message)
  }

  // Open files
  const pipeFd = fs.openSync(pipePath, fs.constants.O_RDWR)
  const outputFd = fs.openSync(jsonlPath, resume ? 'a' : 'w')
  const stderrFd = fs.openSync(stderrPath, resume ? 'a' : 'w')

  // Touch output file on resume so health checks see fresh mtime
  if (resume) {
    try { const now = new Date(); fs.utimesSync(jsonlPath, now, now) } catch {}
  }

  // Spawn Claude via login shell to activate nvm/pyenv/volta shell functions.
  // This matches the proven buildRemotePreamble() approach from session-io.ts —
  // sourcing RC files ensures the full dev environment (including node) is available,
  // even on hosts where nvm binaries need newer GLIBC than the system provides.
  const preamble = buildSpawnPreamble()
  const escapedArgs = args.map((a: string) => shellQuote(a)).join(' ')
  const shellCmd = `${preamble}; exec ${escapedArgs}`

  // Use the user's actual shell to spawn sessions. Hardcoding /bin/bash caused
  // .zshrc to be sourced from bash (via the preamble's `case "$SHELL"`), which
  // fails or partially executes — zsh-specific syntax errors are silently
  // swallowed by `2>/dev/null`, but PATH modifications before the error point
  // can clobber the inherited PATH, losing /usr/bin and other system dirs.
  // Using $SHELL ensures RC files are sourced by the correct shell interpreter.
  // Empirical verification: bash -c 'source .zshrc' on clouddev produces 0 /usr/bin
  // matches, while zsh -c 'source .zshrc' produces 2 matches, proving the bug.
  const userShell = process.env.SHELL || '/bin/bash'
  const proc = spawn(userShell, ['-c', shellCmd], {
    detached: true,
    stdio: [pipeFd, outputFd, stderrFd],
    cwd: cwd,
    // MCP_CONNECTION_NONBLOCKING=1 makes the CLI emit its `init` event immediately
    // instead of blocking up to 5s for MCP servers to connect (they keep connecting
    // in the background). This is the dominant time-to-init cost for Walnut sessions:
    // measured ~6.9s → ~2.9s with no loss of MCP functionality. The CLI only honors
    // this via env (no CLI flag); the daemon's spawn env is the single inject point.
    // CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1: opt into the authoritative
    // session_state_changed (running/idle/requires_action) stream events. idle is
    // the only reliable turn-over signal; a dynamic-workflow turn emits MANY result
    // events (one per background subagent finishing), so result is NOT a turn
    // boundary. Keep in sync with daemon-source.ts.
    //
    // We intentionally DO NOT set CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: background
    // Bash tasks (run_in_background) are a useful capability and there's no reason to
    // amputate them. The original orphan-process worry doesn't hold: the CLI is
    // spawned detached (pid === PGID) and reapSession() kills the whole process group
    // (SIGTERM→SIGKILL), so any background shell is cleaned up with the CLI. Verified
    // by live capture that enabling it leaves the running→idle turn-completion signal
    // intact.
    env: {
      ...process.env,
      MCP_CONNECTION_NONBLOCKING: '1',
      CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1',
    },
  })

  // Detect spawn failure immediately — proc.pid is undefined when posix_spawn fails.
  // This catches cwd-doesn't-exist, shell-not-found, and other synchronous spawn errors
  // BEFORE we send ok:true back to the client.
  if (!proc.pid) {
    logMsg('error', 'spawn failed: no PID (likely bad cwd or missing shell)', { sid, cwd })
    // Clean up files we just created
    try { fs.closeSync(pipeFd) } catch {}
    try { fs.closeSync(outputFd) } catch {}
    try { fs.closeSync(stderrFd) } catch {}
    try { fs.unlinkSync(pipePath) } catch {}
    try { fs.unlinkSync(jsonlPath) } catch {}
    try { fs.unlinkSync(stderrPath) } catch {}
    // Drain the async error event to prevent unhandled rejection
    proc.on('error', () => {})
    return sendError(ws, id, `spawn failed: process could not start on ${os.hostname()} (cwd: ${cwd})`)
  }

  // Handle late spawn errors (shouldn't happen after pid is set, but defensive)
  proc.on('error', (err) => {
    logMsg('error', 'spawn error (post-start)', { sid, error: err.message })
  })

  // Write initial message to FIFO
  const payload = JSON.stringify({
    type: 'user',
    message: { role: 'user', content: message },
  })
  fs.writeSync(pipeFd, Buffer.from(payload + '\n'))
  fs.closeSync(pipeFd)

  // Close fds in parent
  fs.closeSync(outputFd)
  fs.closeSync(stderrFd)

  // Save PID
  const pid = proc.pid
  proc.unref()
  try { fs.writeFileSync(pgidPath, String(pid)) } catch {}

  logStateTransition(sid, 'none', 'running', resume ? 'spawn-resume' : 'spawn-fresh', 'cmdStart', { pid })
  logMsg('info', 'session started', { sid, pid, resume: !!resume })

  // Track session
  const sessionData: SessionData = {
    proc,
    pipePath,
    jsonlPath,
    pgidPath,
    pid,
    offset,
    // Fresh spawn → empty; resume → rebuild from the existing jsonl (its tasks may still be live).
    taskState: resume ? rebuildTaskStateFromJsonl(jsonlPath, Date.now()) : emptyTaskState(),
    watcher: null,
    subscribers: new Set(),
    exitCode: null,
    state: 'running',
    exitReason: null,
    exitedAt: null,
    parented: true,
    startTime: readStartTime(pid),
    cwd,
    args,
    orphanPollTimer: null,
    mode: (mode as SessionMode) || 'default',
    pendingCtrl: null,
    spawnTs: Date.now(),     // latency instrumentation: CLI spawn → first init line
    sawInit: false,
  }

  proc.on('exit', (code) => {
    // SIGCHLD is the fastest (near-0ms) death signal for parented sessions.
    // All cleanup funnels through reapSession so the exit path, missed-exit
    // fallback, and cmdSend-ENXIO path all produce the same side effects.
    //
    // Generation guard: if cmdStart REPLACED this sid (killing this process),
    // the map now holds the replacement session. reapSession(sid) re-resolves
    // by sid, so without this check the OLD process's death reaps the NEW
    // session ~100ms after its spawn (observed live: respawn under the same
    // sid died instantly with "proc-exit code 1").
    if (sessions.get(sid) !== sessionData) return
    reapSession(sid, code ?? 1, 'proc-exit')
  })

  sessions.set(sid, sessionData)
  // Write-ahead: flush registry before returning ok to caller so a crash-after-
  // spawn doesn't orphan the CLI without daemon knowledge.
  try { persistRegistry() } catch {}

  // Announce the new session_state=running to all connected clients, then
  // subscribe the caller to the session-bound watcher (creating it if needed).
  broadcastSessionState(sid, 'running', { pid })
  addSubscriber(ws, sid, offset)

  sendOk(ws, id, { pid, outputFile: jsonlPath, offset })
}

// ── File watching for JSONL streaming ──
//
// Lifecycle: session-bound (NOT ws-bound). One poll timer per session reads
// the JSONL and fans new lines out to every currently-subscribed ws. ws
// connect/disconnect does not affect the watcher. See the SessionData
// interface comment for the full rationale.

// Idempotent: if the session already has a watcher, does nothing.
function ensureWatcher(sid: string) {
  const session = sessions.get(sid)
  if (!session) return
  if (session.watcher) return // already running
  if (session.state !== 'running') return

  let offset = session.offset || 0
  const stderrPath = session.jsonlPath + '.err'

  const pollTimer = setInterval(() => {
    const s = sessions.get(sid)
    if (!s || s.state !== 'running') return
    try {
      const stat = fs.statSync(s.jsonlPath)
      if (stat.size <= offset) return

      const fd = fs.openSync(s.jsonlPath, 'r')
      const bytesToRead = stat.size - offset
      const buf = Buffer.alloc(bytesToRead)
      fs.readSync(fd, buf, 0, bytesToRead, offset)
      fs.closeSync(fd)
      const batchStart = offset
      offset = stat.size
      if (s.watcher) s.watcher.offset = offset // expose for catch-up

      const text = buf.toString('utf-8')
      const lines = text.split('\n')
      let sawResult = false
      // L1 versioned events: `v` is the byte offset at the END of this line in the
      // append-only jsonl — monotonic per session, and identical whether the line is
      // delivered live (here) or via replay (addSubscriber), so the client orders and
      // dedupes by `v` alone. Accumulate across EVERY line (incl. skipped/control) so
      // `v` stays byte-aligned with the file regardless of which lines we forward.
      let lineStartV = batchStart
      for (const line of lines) {
        const v = lineStartV + Buffer.byteLength(line, 'utf-8') + 1 // +1 = the '\n' split() removed
        lineStartV = v
        if (!line.trim()) continue

        // ── Latency instrumentation: time from CLI spawn → first init line ──
        // Pure CLI cold-start (incl. MCP connect) as the daemon sees it, directly
        // comparable to running `claude` by hand. Logged once per session.
        if (!s.sawInit && line.includes('"type":"system"') && line.includes('"init"')) {
          s.sawInit = true
          logMsg('info', 'first init line from CLI', {
            sid, spawnToInitMs: s.spawnTs ? Date.now() - s.spawnTs : null,
          })
        }

        // ── L2: materialize daemon-authoritative task state ──
        // Cheap substring pre-filter (task_* events are `"type":"system"` lines carrying a
        // `task_` subtype) so we JSON.parse only the relevant ~1% of lines. The applied state
        // is served on `getState` so Walnut can reconcile a lost-terminal event without guessing.
        if (line.includes('"task_')) {
          try {
            const parsed = JSON.parse(line) as Record<string, unknown>
            if (applyTaskEvent(s.taskState, parsed, v, Date.now())) {
              logMsg('info', 'task transition', {
                sid, bgTaskId: parsed.task_id, status: s.taskState.tasks[parsed.task_id as string]?.status,
                derivedRunning: s.taskState.derivedRunning, v,
              })
            }
          } catch { /* malformed line — skip */ }
        }

        // ── Permission policy intercept ──
        if (line.includes('"control_request"') || line.includes('"control_response"')) {
          try {
            const parsed = JSON.parse(line) as Record<string, unknown>
            if (parsed.type === 'control_request' && parsed.request_id
              && (parsed.request as Record<string, unknown>)?.subtype === 'can_use_tool') {
              const req = parsed.request as Record<string, unknown>
              const toolName = req.tool_name as string | undefined
              if (shouldAutoRespond(s.mode, toolName)) {
                const resp = buildControlResponse(parsed.request_id as string, req, true)
                writeFifoRaw(s.pipePath, resp)
                s.pendingCtrl = null
                logMsg('info', 'auto-allowed control_request', { sid, tool: toolName, mode: s.mode })
                continue
              }
              s.pendingCtrl = {
                reqId: parsed.request_id as string,
                toolName: toolName ?? 'unknown',
                request: req,
                receivedAt: Date.now(),
              }
            } else if (parsed.type === 'control_response' && s.pendingCtrl) {
              const resp = parsed.response as Record<string, unknown> | undefined
              if (resp?.request_id === s.pendingCtrl.reqId) {
                s.pendingCtrl = null
              }
            }
          } catch { /* parse failed, fall through to normal push */ }
        }

        // Fan out to all current subscribers, GC dead ones opportunistically.
        // DUP-DEBUG: only log fan-out when subscribers > 1 (the duplicate
        // smoking gun) AND only for tool_use lines (cheap to detect via
        // substring). High-frequency text deltas would spam the log.
        const fanCount = s.subscribers.size
        const isToolUseLine = fanCount > 1 && line.includes('"type":"tool_use"')
        const recipientWsIds: number[] = []
        for (const ws of s.subscribers) {
          if (ws.readyState === 1) {
            if (isToolUseLine) recipientWsIds.push(wsId(ws))
            // `v` MUST ride every live line (same as the replay path below and
            // daemon-source.ts): without it the client falls back to relative
            // byte accounting, which drifts on skipped control lines → replay
            // windows + duplicate blocks on reattach.
            try { sendEvent(ws, 'jsonl', { sid, line, v }) } catch {}
          } else {
            logMsg('info', 'GC dead subscriber from watcher fan-out', {
              sid, wsId: wsId(ws), readyState: ws.readyState,
            })
            s.subscribers.delete(ws)
          }
        }
        if (isToolUseLine) {
          logMsg('info', 'jsonl fan-out (tool_use, multi-subscriber)', {
            sid,
            subscriberCount: fanCount,
            recipientWsIds,
            lineSnippet: line.slice(0, 120),
          })
        }
        if (!sawResult && line.includes('"type":"result"')) sawResult = true
      }
      // After a result event, push stderr tail so MCP failures / CLI bails are
      // visible without SSH. Fan to all subscribers.
      if (sawResult) {
        try {
          const errStat = fs.statSync(stderrPath)
          if (errStat.size > 0) {
            const readLen = Math.min(errStat.size, 4096)
            const start = Math.max(0, errStat.size - readLen)
            const efd = fs.openSync(stderrPath, 'r')
            const ebuf = Buffer.alloc(readLen)
            fs.readSync(efd, ebuf, 0, readLen, start)
            fs.closeSync(efd)
            const tail = ebuf.toString('utf-8').trim()
            if (tail) {
              // DUP-DEBUG: stderr_tail is once-per-result. Always log fan-out
              // size + recipient wsIds to confirm whether the daemon is
              // sending to one ws or several.
              const recipientWsIds: number[] = []
              for (const ws of s.subscribers) {
                if (ws.readyState === 1) {
                  recipientWsIds.push(wsId(ws))
                  try { sendEvent(ws, 'stderr_tail', { sid, tail }) } catch {}
                }
              }
              logMsg('info', 'stderr_tail fan-out', {
                sid,
                subscriberCount: s.subscribers.size,
                recipientWsIds,
              })
            }
          }
        } catch {}
      }
    } catch {}
  }, 100)

  session.watcher = { pollTimer, offset }
}

// Stop the session-bound watcher. Only called from reapSession (session died)
// or daemon shutdown. NEVER called from ws.close.
function stopSessionWatcher(sid: string) {
  const session = sessions.get(sid)
  if (!session || !session.watcher) return
  // Save offset back to session so a subsequent ensureWatcher() resumes from
  // here instead of re-streaming the entire jsonl file from byte 0. Matters
  // for cmdRename, where we intentionally tear down + re-create the watcher.
  session.offset = session.watcher.offset
  try { clearInterval(session.watcher.pollTimer) } catch {}
  session.watcher = null
}

// Add ws to the session's subscribers and catch-up-push bytes
// [fromOffset, currentOffset) to this one ws so reconnecting clients see no gap.
function addSubscriber(ws: ServerWebSocket<WsData>, sid: string, fromOffset: number): boolean {
  const session = sessions.get(sid)
  if (!session) return false
  // DUP-DEBUG: capture the subscriber set BEFORE add so we can log who was
  // already attached. If `before` already contains this ws's wsId, we have a
  // double-add bug; if it contains other live wsIds for the same sid, every
  // subsequent push will fan out to all of them, doubling downstream events.
  const before = Array.from(session.subscribers).map((s) => ({
    wsId: wsId(s), readyState: s.readyState,
  }))
  session.subscribers.add(ws)
  ensureWatcher(sid)
  logMsg('info', 'addSubscriber: attached', {
    sid,
    wsId: wsId(ws),
    fromOffset,
    subscribersBefore: before,
    subscribersAfter: session.subscribers.size,
  })

  const currentOffset = session.watcher ? session.watcher.offset : 0
  const start = typeof fromOffset === 'number' && fromOffset >= 0 ? fromOffset : 0
  if (start < currentOffset) {
    const bytesToRead = currentOffset - start
    // Catch-up replay > 256KB is suspicious — it usually means the client
    // passed an offset from a DIFFERENT file (canonical vs stream mismatch),
    // and we're about to spam them with a huge replay that looks like "UI is
    // replaying the whole conversation". Log before doing it so we can trace.
    if (bytesToRead > 256 * 1024) {
      logMsg('warn', 'addSubscriber: large catch-up replay', {
        sid, fromOffset: start, currentOffset, bytesToRead,
      })
    } else {
      logMsg('info', 'addSubscriber: replay', {
        sid, fromOffset: start, currentOffset, bytesToRead,
      })
    }
    try {
      const fd = fs.openSync(session.jsonlPath, 'r')
      const buf = Buffer.alloc(bytesToRead)
      fs.readSync(fd, buf, 0, bytesToRead, start)
      fs.closeSync(fd)
      const text = buf.toString('utf-8')
      // L1: stamp `v` (end-of-line byte offset) identically to the live watcher so the
      // client dedupes a replayed line against the same `v` it may already have seen live.
      let lineStartV = start
      for (const line of text.split('\n')) {
        const v = lineStartV + Buffer.byteLength(line, 'utf-8') + 1
        lineStartV = v
        if (!line.trim() || ws.readyState !== 1) continue
        // Skip transient permission-protocol lines on replay. control_request/
        // control_response are RPC handshake lines, not session history; replaying
        // them resurrects stale permission prompts in the UI. A genuinely-pending
        // request is recovered out-of-band via `pendingCtrl` (returned on attach),
        // NOT via replay — so dropping all control lines here loses nothing.
        // Keep in sync with daemon-source.ts addSubscriber (CLAUDE.md).
        if (line.includes('"control_request"') || line.includes('"control_response"')) continue
        try { sendEvent(ws, 'jsonl', { sid, line, v }) } catch {}
      }
    } catch {}
  } else {
    logMsg('info', 'addSubscriber: no replay (future-only)', {
      sid, fromOffset: start, currentOffset,
    })
  }
  return true
}

// ── Attach to existing session ──
function cmdAttach(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const { sid, fromOffset, mode } = cmd as { sid: string; fromOffset?: number; mode?: string }
  if (!sid) return sendError(ws, id, 'attach: missing sid')

  let session = sessions.get(sid)

  if (!session) {
    // Try to discover from files
    const jsonlPath = path.join(STREAMS_DIR, sid + '.jsonl')
    const pgidPath = path.join(STREAMS_DIR, sid + '.pgid')
    const pipePath = path.join(STREAMS_DIR, sid + '.pipe')

    if (!fs.existsSync(jsonlPath)) {
      return sendError(ws, id, 'attach: session not found: ' + sid)
    }

    let pid: number | null = null
    let alive = false
    try {
      pid = parseInt(fs.readFileSync(pgidPath, 'utf-8').trim(), 10)
      process.kill(pid, 0) // check alive
      alive = true
    } catch { pid = null; alive = false }

    session = {
      proc: null,
      pipePath,
      jsonlPath,
      pgidPath,
      pid,
      // Watcher starts at the CURRENT end of the stream file — same rule as
      // adopt. Catch-up for [fromOffset, end) is addSubscriber's job (it reads
      // the file directly). Using the client's fromOffset here is wrong both
      // ways: 0 re-fans the whole file; MAX_SAFE_INTEGER (future-only
      // sentinel) freezes the watcher forever (stat.size <= offset).
      offset: statSizeOrZero(jsonlPath),
      taskState: rebuildTaskStateFromJsonl(jsonlPath, Date.now()),
      watcher: null,
      subscribers: new Set(),
      exitCode: alive ? null : 0,
      state: alive ? 'running' : 'dead',
      exitReason: alive ? null : 'attach-discovered-dead',
      exitedAt: alive ? null : Date.now(),
      parented: false,  // discovered, not spawned
      startTime: pid && alive ? readStartTime(pid) : null,
      cwd: '',
      args: [],
      orphanPollTimer: null,
      mode: (mode as SessionMode) || 'default',
      pendingCtrl: null,
    }
    sessions.set(sid, session)
    if (alive && pid) {
      // Discovered an orphan — start the 1s tight poll so we detect death
      // within a second (Phase D, layer 3.2).
      startOrphanPoll(sid)
    }
  }

  // Update mode if provided (walnut re-sends mode on reconnect)
  if (mode && session.state === 'running') {
    session.mode = mode as SessionMode
  }

  const offset = fromOffset || 0
  // Hot-path fresh check to avoid lying to a client whose prior daemon state
  // is stale (race with reaper/SIGCHLD).
  let alive = session.state === 'running' && session.pid !== null
  if (alive && session.pid) {
    try { process.kill(session.pid, 0) } catch {
      reapSession(sid, -1, 'attach-kill-check')
      alive = false
    }
  }

  // Subscribe this ws to the session-bound watcher. Does NOT create a new
  // watcher if one exists. Catches up from fromOffset to the watcher's
  // current offset so reconnecting clients see no gap.
  if (alive) addSubscriber(ws, sid, offset)

  sendOk(ws, id, {
    pid: session.pid,
    alive,
    state: session.state,
    exitCode: session.exitCode,
    outputFile: session.jsonlPath,
    currentOffset: session.watcher ? session.watcher.offset : 0,
    pendingCtrl: session.pendingCtrl,
  })
}

// ── Send message ──
// Logic lives in daemon-core.handleSendCommand (strict-ack). This wrapper
// only maps the SendResult envelope onto the WS reply format.
function cmdSend(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const { sid, message } = cmd as { sid: string; message: string }
  const result = core.handleSendCommand(sid, message)
  if ('error' in result) return sendError(ws, id, result.error)
  sendOk(ws, id, result as unknown as Record<string, unknown>)
}

// ── Send raw (permission-prompt-tool control_response passthrough) ──
// Same strict-ack protocol as cmdSend; the FIFO receives `raw` verbatim.
function cmdSendRaw(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const { sid, raw } = cmd as { sid: string; raw: string }
  const result = core.handleSendRawCommand(sid, raw)
  if ('error' in result) return sendError(ws, id, result.error)
  sendOk(ws, id, result as unknown as Record<string, unknown>)
}

// ── Set session mode ──
function cmdSetMode(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const { sid, mode } = cmd as { sid: string; mode: string }
  if (!sid || !mode) return sendError(ws, id, 'setMode: missing sid or mode')
  const session = sessions.get(sid)
  if (!session) return sendError(ws, id, 'setMode: session not found: ' + sid)
  const oldMode = session.mode
  session.mode = mode as SessionMode
  if (session.pendingCtrl && shouldAutoRespond(session.mode, session.pendingCtrl.toolName)) {
    const resp = buildControlResponse(session.pendingCtrl.reqId, session.pendingCtrl.request, true)
    writeFifoRaw(session.pipePath, resp)
    logMsg('info', 'setMode: auto-allowed pending control_request', { sid, tool: session.pendingCtrl.toolName, mode })
    session.pendingCtrl = null
  }
  try { persistRegistry() } catch {}
  sendOk(ws, id, { oldMode, newMode: mode })
}

// ── Stop session ──
function cmdStop(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const { sid } = cmd as { sid: string }
  if (!sid) return sendError(ws, id, 'stop: missing sid')

  const session = sessions.get(sid)
  if (!session || !session.pid) {
    logMsg('info', 'cmdStop: session not in registry (nothing to kill)', {
      sid, hasSession: !!session, hasPid: !!session?.pid,
    })
    return sendOk(ws, id, { stopped: true, noop: true, reason: 'not_in_registry' })
  }

  const pid = session.pid
  logMsg('info', 'cmdStop: stopping session (process group kill)', { sid, pid })

  // 3-phase process group kill: SIGINT → SIGTERM → SIGKILL
  // kill(-pid) targets the entire process group (Claude + MCP servers)
  try {
    killProcessGroup(pid, 'SIGINT')
    let checks = 0
    const checkExit = () => {
      if (!isProcessGroupAlive(pid)) {
        sendOk(ws, id, { stopped: true })
        return
      }
      checks++
      if (checks >= 25) { // 5s elapsed
        killProcessGroup(pid, 'SIGTERM')
        setTimeout(() => {
          if (isProcessGroupAlive(pid)) {
            killProcessGroup(pid, 'SIGKILL')
          }
          sendOk(ws, id, { stopped: true, forced: true })
        }, 2000)
        return
      }
      setTimeout(checkExit, 200)
    }
    setTimeout(checkExit, 200)
  } catch {
    sendOk(ws, id, { stopped: true })
  }
}

// ── Status ──
function cmdStatus(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const { sid } = cmd as { sid: string }
  if (!sid) return sendError(ws, id, 'status: missing sid')

  const session = sessions.get(sid)
  if (!session) return sendOk(ws, id, { exists: false })

  // If daemon already reaped it, trust that — don't go back to kill(pid,0).
  let alive = session.state === 'running'
  if (alive && session.pid) {
    // Hot-path verification: daemon may not have seen SIGCHLD yet for a
    // just-died parented session. A fresh kill(pid,0) closes that window.
    try { process.kill(session.pid, 0) } catch {
      reapSession(sid, -1, 'status-kill-check')
      alive = false
    }
  }

  let mtime: string | null = null, size = 0
  try {
    const stat = fs.statSync(session.jsonlPath)
    mtime = stat.mtime.toISOString()
    size = stat.size
  } catch {}

  sendOk(ws, id, {
    exists: true,
    alive,
    pid: session.pid,
    mtime,
    size,
    state: session.state,
    exitCode: session.exitCode,
    exitReason: session.exitReason,
    pendingCtrl: session.pendingCtrl,
  })
}

// ── L2: getState — daemon-authoritative background-task state (the PULL source of truth) ──
// Returns the materialized task state plus process liveness. Walnut PULLs this to reconcile a
// lost-terminal event: if the daemon (which persisted every event) says a task is terminal that
// Walnut still has 'running', Walnut adopts the daemon's truth and completes the withheld turn —
// no liveness guessing. If the session is unknown but its jsonl exists, rebuild from disk so a
// post-restart PULL still returns truth. Keep in sync with daemon-source.ts (CLAUDE.md).
function cmdGetState(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const { sid } = cmd as { sid: string }
  if (!sid) return sendError(ws, id, 'getState: missing sid')

  const session = sessions.get(sid)
  if (session) {
    return sendOk(ws, id, {
      exists: true,
      alive: session.state === 'running',
      state: session.state,
      taskState: session.taskState,
    })
  }
  // Unknown in memory — rebuild from the durable jsonl if it exists (post-restart PULL).
  const jsonlPath = path.join(STREAMS_DIR, sid + '.jsonl')
  if (!fs.existsSync(jsonlPath)) return sendOk(ws, id, { exists: false })
  const taskState = rebuildTaskStateFromJsonl(jsonlPath, Date.now())
  return sendOk(ws, id, { exists: true, alive: false, state: 'dead', taskState })
}

// ── Rename session files ──
function cmdRename(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const { oldSid, newSid } = cmd as { oldSid: string; newSid: string }
  if (!oldSid || !newSid) return sendError(ws, id, 'rename: missing oldSid or newSid')
  if (oldSid === newSid) return sendOk(ws, id, { renamed: true })

  const session = sessions.get(oldSid)
  if (!session) return sendError(ws, id, 'rename: session not found: ' + oldSid)

  const oldBase = path.join(STREAMS_DIR, oldSid)
  const newBase = path.join(STREAMS_DIR, newSid)

  try {
    for (const ext of ['.jsonl', '.jsonl.err', '.pipe', '.pgid', '.log']) {
      try { fs.renameSync(oldBase + ext, newBase + ext) } catch {}
    }
    session.jsonlPath = newBase + '.jsonl'
    session.pipePath = newBase + '.pipe'
    session.pgidPath = newBase + '.pgid'

    // The session-bound watcher's pollTimer closure captured the OLD sid and
    // looks up sessions.get(oldSid) each tick. After the re-key below, that
    // lookup returns undefined and the watcher silently stops fanning out
    // jsonl lines — users see the session "go deaf" mid-turn (UI stuck on
    // "Walnut is working…" until the whole session ends). Fix: stop the old
    // watcher before re-keying, then re-create it against the new sid so its
    // closure captures the right key. Subscribers stay put — they only hold
    // ws refs, not sid — so no re-attach is needed from the client side.
    stopSessionWatcher(oldSid)

    sessions.delete(oldSid)
    sessions.set(newSid, session)

    ensureWatcher(newSid)

    sendOk(ws, id, { renamed: true })
    logMsg('info', 'session renamed', { oldSid, newSid })
  } catch (err: unknown) {
    sendError(ws, id, 'rename failed: ' + (err as Error).message)
  }
}

// ── Read history ──
function cmdReadHistory(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const { sid, canonicalPath } = cmd as { sid: string; canonicalPath?: string }
  if (!sid) return sendError(ws, id, 'read-history: missing sid')

  try {
    // Read main JSONL
    let mainContent = ''
    const jsonlPath = canonicalPath || path.join(STREAMS_DIR, sid + '.jsonl')
    try { mainContent = fs.readFileSync(jsonlPath, 'utf-8') } catch {}

    // Read subagents
    const subagents: Record<string, string> = {}
    const subagentDir = path.dirname(jsonlPath) + '/' + sid + '/subagents'
    try {
      const files = fs.readdirSync(subagentDir)
      for (const f of files) {
        if (f.endsWith('.jsonl')) {
          try {
            subagents[f] = fs.readFileSync(path.join(subagentDir, f), 'utf-8')
          } catch {}
        }
      }
    } catch {}

    sendOk(ws, id, { main: mainContent, subagents })
  } catch (err: unknown) {
    sendError(ws, id, 'read-history failed: ' + (err as Error).message)
  }
}

// ── Subscribe to subagent ──
function cmdSubscribeAgent(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const { sid, agent, team, offsets } = cmd as {
    sid: string; agent: string; team?: string; offsets?: Record<string, number>
  }
  if (!sid || !agent) return sendError(ws, id, 'subscribe-agent: missing sid or agent')

  const subKey = sid + ':' + agent

  // Unsubscribe existing
  const existing = agentSubs.get(subKey)
  if (existing) {
    if (existing.timer) clearInterval(existing.timer)
    if (existing.rediscoverTimer) clearInterval(existing.rediscoverTimer)
    agentSubs.delete(subKey)
  }

  const sub: AgentSub = {
    files: new Map(),
    timer: null,
    rediscoverTimer: null,
    ws,
    sid,
    agent,
    team,
  }

  // Discover agent JSONL files
  function discoverFiles() {
    try {
      // Look in session subagents dir
      const sessionDir = path.join(STREAMS_DIR, sid, 'subagents')
      try {
        const files = fs.readdirSync(sessionDir)
        for (const f of files) {
          if (!f.endsWith('.jsonl')) continue
          // Match by agent name in filename
          if (f.toLowerCase().includes(agent.toLowerCase()) || f.includes(agent)) {
            const fullPath = path.join(sessionDir, f)
            if (!sub.files.has(fullPath)) {
              const startOffset = (offsets && offsets[f]) || 0
              sub.files.set(fullPath, { offset: startOffset })
            }
          }
        }
      } catch {}
    } catch {}
  }

  // Poll for new data
  function pollData() {
    for (const [filePath, fileState] of sub.files) {
      try {
        const stat = fs.statSync(filePath)
        if (stat.size > fileState.offset) {
          const fd = fs.openSync(filePath, 'r')
          const bytes = stat.size - fileState.offset
          const buf = Buffer.alloc(bytes)
          fs.readSync(fd, buf, 0, bytes, fileState.offset)
          fs.closeSync(fd)
          fileState.offset = stat.size

          const lines = buf.toString('utf-8').split('\n').filter((l: string) => l.trim())
          if (lines.length > 0) {
            sendEvent(ws, 'agent', {
              sid,
              agent,
              file: path.basename(filePath),
              lines,
            })
          }
        }
      } catch {}
    }
  }

  // Initial discovery + data send
  discoverFiles()
  pollData()

  // Start polling
  sub.timer = setInterval(pollData, AGENT_POLL_INTERVAL_MS)
  sub.rediscoverTimer = setInterval(discoverFiles, AGENT_REDISCOVER_INTERVAL_MS)

  agentSubs.set(subKey, sub)
  sendOk(ws, id, { subscribed: true, files: [...sub.files.keys()] })
}

// ── Unsubscribe from subagent ──
function cmdUnsubscribeAgent(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const { sid, agent } = cmd as { sid: string; agent: string }
  const subKey = sid + ':' + agent
  const sub = agentSubs.get(subKey)
  if (sub) {
    if (sub.timer) clearInterval(sub.timer)
    if (sub.rediscoverTimer) clearInterval(sub.rediscoverTimer)
    agentSubs.delete(subKey)
  }
  sendOk(ws, id, { unsubscribed: true })
}

// ── Write to team inbox ──
function cmdWriteInbox(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const { team, agent, from, text, summary } = cmd as {
    team: string; agent: string; from?: string; text: string; summary?: string
  }
  if (!team || !agent || !text) return sendError(ws, id, 'write-inbox: missing fields')

  const inboxPath = path.join(HOME_DIR, '.claude', 'teams', team, 'inboxes', agent + '.json')

  try {
    fs.mkdirSync(path.dirname(inboxPath), { recursive: true })

    let inbox: unknown[] = []
    try { inbox = JSON.parse(fs.readFileSync(inboxPath, 'utf-8')) } catch {}
    if (!Array.isArray(inbox)) inbox = []

    inbox.push({
      from: from || 'walnut',
      text,
      summary: summary || text.slice(0, 100),
      timestamp: new Date().toISOString(),
      read: false,
    })

    fs.writeFileSync(inboxPath, JSON.stringify(inbox, null, 2))
    sendOk(ws, id, { written: true })
  } catch (err: unknown) {
    sendError(ws, id, 'write-inbox failed: ' + (err as Error).message)
  }
}

// ── File system operations ──
// NOTE: use fs.promises.* instead of sync calls — a large file read (e.g. a
// 50MB session JSONL) would otherwise block every queued RPC on this daemon
// until it completes.
async function cmdFsRead(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  let filePath = cmd.path as string
  const encoding = cmd.encoding as string | undefined
  if (!filePath) return sendError(ws, id, 'fs.read: missing path')

  // Expand ~ to home directory (Node fs doesn't do shell expansion)
  if (filePath === '~' || filePath.startsWith('~/')) {
    filePath = HOME_DIR + filePath.slice(1)
  }

  try {
    const enc = encoding || 'base64'
    const data = await fs.promises.readFile(filePath)
    if (enc === 'base64') {
      sendOk(ws, id, { data: data.toString('base64'), encoding: 'base64' })
    } else {
      sendOk(ws, id, { data: data.toString('utf-8'), encoding: 'utf-8' })
    }
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException
    // Tag ENOENT so the server can distinguish "file not found" from transport failure.
    const code = e.code ?? ''
    sendError(ws, id, 'fs.read failed: ' + e.message + (code ? ' (' + code + ')' : ''))
  }
}

async function cmdFsWrite(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const { path: filePath, data, encoding } = cmd as { path: string; data: string; encoding?: string }
  if (!filePath || !data) return sendError(ws, id, 'fs.write: missing path or data')

  try {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true })
    const enc = encoding || 'base64'
    const buf = enc === 'base64' ? Buffer.from(data, 'base64') : Buffer.from(data, 'utf-8')
    await fs.promises.writeFile(filePath, buf)
    sendOk(ws, id, { written: true, size: buf.length })
  } catch (err: unknown) {
    sendError(ws, id, 'fs.write failed: ' + (err as Error).message)
  }
}

async function cmdFsLs(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  let dirPath = cmd.path as string
  if (!dirPath) return sendError(ws, id, 'fs.ls: missing path')

  // Expand ~ to home directory (Node fs doesn't do shell expansion)
  if (dirPath === '~' || dirPath.startsWith('~/')) {
    dirPath = HOME_DIR + dirPath.slice(1)
  }

  try {
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true })
    const result = entries.map(e => ({
      name: e.name,
      type: e.isDirectory() ? 'dir' : e.isFile() ? 'file' : 'other',
    }))
    sendOk(ws, id, { entries: result, resolvedPath: dirPath })
  } catch (err: unknown) {
    sendError(ws, id, 'fs.ls failed: ' + (err as Error).message)
  }
}

async function cmdFsFind(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  let basePath = (cmd.path as string) || '~/.claude/projects'
  const name = cmd.name as string
  const maxDepth = (cmd.maxDepth as number) || 3
  if (!name) return sendError(ws, id, 'fs.find: missing name')

  // Expand ~ to home directory
  if (basePath === '~' || basePath.startsWith('~/')) {
    basePath = HOME_DIR + basePath.slice(1)
  }

  try {
    const found: string[] = []
    async function walk(dir: string, depth: number) {
      if (depth > maxDepth || found.length >= 10) return
      let entries: fs.Dirent[]
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        if (found.length >= 10) return
        const full = path.join(dir, e.name)
        if (e.isFile() && e.name.includes(name)) {
          found.push(full)
          if (found.length >= 10) return
        } else if (e.isDirectory()) {
          await walk(full, depth + 1)
        }
      }
    }
    await walk(basePath, 0)
    sendOk(ws, id, { files: found })
  } catch (err: unknown) {
    sendError(ws, id, 'fs.find failed: ' + (err as Error).message)
  }
}

async function cmdFsStat(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  let filePath = cmd.path as string
  if (!filePath) return sendError(ws, id, 'fs.stat: missing path')

  if (filePath === '~' || filePath.startsWith('~/')) {
    filePath = HOME_DIR + filePath.slice(1)
  }

  try {
    const st = await fs.promises.stat(filePath)
    sendOk(ws, id, { exists: true, mtimeMs: st.mtimeMs, size: st.size })
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'ENOENT') {
      sendOk(ws, id, { exists: false })
      return
    }
    sendError(ws, id, 'fs.stat failed: ' + e.message)
  }
}

// Byte-range read for LARGE files. A whole-file fs.read of a multi-MB session
// JSONL serializes into ONE giant WS frame; corp SSH proxies (WSSH) kill the
// tunnel mid-frame, the client sees only a pong gap, and the read times out
// forever (inc-1783532915925: 11.4MB history → 30s timeout loop). Range reads
// keep every frame small enough to survive the proxy, and double as the
// incremental "only the appended bytes" path for turn deltas.
// Returns base64 (byte-exact — a range can split a UTF-8 char; the CLIENT
// reassembles bytes then decodes). eof lets the caller stop without a stat race.
async function cmdFsReadRange(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  let filePath = cmd.path as string
  const start = typeof cmd.start === 'number' && cmd.start >= 0 ? cmd.start : 0
  const length = typeof cmd.length === 'number' && cmd.length > 0
    ? Math.min(cmd.length as number, 4 * 1024 * 1024) : 1024 * 1024
  if (!filePath) return sendError(ws, id, 'fs.readRange: missing path')

  if (filePath === '~' || filePath.startsWith('~/')) {
    filePath = HOME_DIR + filePath.slice(1)
  }

  let fh: fs.promises.FileHandle | null = null
  try {
    fh = await fs.promises.open(filePath, 'r')
    const st = await fh.stat()
    if (start >= st.size) {
      sendOk(ws, id, { data: '', bytesRead: 0, fileSize: st.size, eof: true })
      return
    }
    const toRead = Math.min(length, st.size - start)
    const buf = Buffer.alloc(toRead)
    const { bytesRead } = await fh.read(buf, 0, toRead, start)
    sendOk(ws, id, {
      data: buf.subarray(0, bytesRead).toString('base64'),
      bytesRead,
      fileSize: st.size,
      eof: start + bytesRead >= st.size,
    })
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException
    const code = e.code ?? ''
    sendError(ws, id, 'fs.readRange failed: ' + e.message + (code ? ' (' + code + ')' : ''))
  } finally {
    try { await fh?.close() } catch { /* already closed */ }
  }
}

// ── Git diff (whole-repo, host-local) ──
// Runs the shared git-diff core HERE on the remote host, so git + the files are
// local — no per-file network round trips. Returns the full {repoRoot,files}
// in one response. This is why remote git-diff goes through the daemon, not SSH.
async function cmdGitDiff(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  let cwd = cmd.cwd as string
  const base = cmd.base as GitDiffBase
  if (!cwd) return sendError(ws, id, 'git.diff: missing cwd')
  if (base !== 'uncommitted' && base !== 'previous' && base !== 'remote') {
    return sendError(ws, id, 'git.diff: invalid base')
  }
  if (cwd === '~' || cwd.startsWith('~/')) cwd = HOME_DIR + cwd.slice(1)

  const exec = (argv: string[], runCwd: string) => new Promise<{ stdout: string; stderr: string; code: number }>((resolve) => {
    execFileCb(argv[0], argv.slice(1), { cwd: runCwd, timeout: 25_000, maxBuffer: 64 * 1024 * 1024, encoding: 'utf-8' },
      (err: NodeJS.ErrnoException | null, stdout: string, stderr: string) => {
        if (!err) return resolve({ stdout, stderr, code: 0 })
        resolve({ stdout: stdout || '', stderr: stderr || err.message, code: typeof err.code === 'number' ? err.code : 1 })
      })
  })
  const readText = async (absPath: string) => {
    try { return await fs.promises.readFile(absPath, 'utf-8') } catch { return '' }
  }

  try {
    const result = await computeGitDiff(base, cwd, exec, readText)
    if (!result) return sendOk(ws, id, { repoRoot: null, files: [] }) // not a git repo
    sendOk(ws, id, { repoRoot: result.repoRoot, files: result.files })
  } catch (err: unknown) {
    if (err instanceof GitDiffError) return sendError(ws, id, err.message)
    sendError(ws, id, 'git.diff failed: ' + (err as Error).message)
  }
}

// ── List all sessions ──
function cmdList(ws: ServerWebSocket<WsData>, id: number) {
  const result: Array<{
    sid: string; pid: number | null; alive: boolean; mtime: string | null; size: number
  }> = []

  // Scan streams dir for PGID files
  try {
    const files = fs.readdirSync(STREAMS_DIR)
    for (const f of files) {
      if (!f.endsWith('.pgid')) continue
      const sid = f.replace('.pgid', '')
      try {
        const pid = parseInt(fs.readFileSync(path.join(STREAMS_DIR, f), 'utf-8').trim(), 10)
        let alive = false
        try { process.kill(pid, 0); alive = true } catch {}

        let mtime: string | null = null, size = 0
        try {
          const stat = fs.statSync(path.join(STREAMS_DIR, sid + '.jsonl'))
          mtime = stat.mtime.toISOString()
          size = stat.size
        } catch {}

        result.push({ sid, pid, alive, mtime, size })
      } catch {}
    }
  } catch {}

  // Also include in-memory sessions not yet persisted
  for (const [sid, session] of sessions) {
    if (!result.find(r => r.sid === sid)) {
      // Prefer the authoritative state field; only fall back to kill(pid,0)
      // if we've never seen a death signal for this record.
      let alive = session.state === 'running' && session.pid !== null
      if (alive && session.pid) {
        try { process.kill(session.pid, 0) } catch { alive = false }
      }
      result.push({
        sid,
        pid: session.pid,
        alive,
        mtime: null,
        size: 0,
      })
    }
  }

  sendOk(ws, id, { sessions: result })
}

// ── Protocol helpers ──
// ALL socket writes MUST go through safeSend. Bun's ServerWebSocket.send()
// SILENTLY DROPS the message (returns 0) once the socket's backpressure buffer
// is saturated — a single ~28MB fs.read response is enough. Raw `try {
// ws.send() } catch {}` therefore lost concurrent RPC replies (walnut → 30s
// "Session file read timeout") and live `jsonl` events for other sessions on
// the same shared connection (UI: frozen streaming until refresh). safeSend
// queues on drop and flushes in FIFO order when Bun fires `drain`.
// Regression: tests/providers/daemon-ws-backpressure.test.ts (real binary).
const SEND_QUEUE_MAX_BYTES = 256 * 1024 * 1024

function enqueueForDrain(ws: ServerWebSocket<WsData>, payload: string) {
  const data = ws.data
  data.sendQueue ??= []
  data.sendQueueBytes ??= 0
  data.sendQueue.push(payload)
  data.sendQueueBytes += payload.length
  if (data.sendQueueBytes > SEND_QUEUE_MAX_BYTES) {
    // A client that stops reading would pin unbounded memory. Closing is safe:
    // the walnut side auto-reconnects and re-attaches (future-only offsets),
    // and an explicit close is honest where a silent drop was the original bug.
    logMsg('error', 'send queue overflow — closing slow client', {
      wsId: wsId(ws), queuedBytes: data.sendQueueBytes, queuedMsgs: data.sendQueue.length,
    })
    data.sendQueue = []
    data.sendQueueBytes = 0
    try { ws.close() } catch {}
  }
}

function safeSend(ws: ServerWebSocket<WsData>, payload: string) {
  // FIFO ordering: once anything is queued, later sends must queue behind it.
  if (ws.data.sendQueue?.length) return enqueueForDrain(ws, payload)
  let result: number
  try { result = ws.send(payload) } catch { return }
  // Bun send(): >0 = sent, -1 = buffered internally (delivered later, drain
  // will fire), 0 = DROPPED because the buffer is full → queue for drain.
  if (result === 0) enqueueForDrain(ws, payload)
}

function flushSendQueue(ws: ServerWebSocket<WsData>) {
  const data = ws.data
  const q = data.sendQueue
  if (!q?.length) return
  while (q.length) {
    let result: number
    try { result = ws.send(q[0]) } catch { return }
    if (result === 0) return // still saturated — next drain resumes here
    data.sendQueueBytes! -= q[0].length
    q.shift()
  }
}

function sendOk(ws: ServerWebSocket<WsData>, id: number | null, data: Record<string, unknown>) {
  safeSend(ws, JSON.stringify({ id, ok: true, ...data }))
}

function sendError(ws: ServerWebSocket<WsData>, id: number | null, error: string) {
  logMsg('error', 'command error', { id, error })
  safeSend(ws, JSON.stringify({ id, ok: false, error }))
}

function sendEvent(ws: ServerWebSocket<WsData>, ev: string, data: Record<string, unknown>) {
  safeSend(ws, JSON.stringify({ ev, ...data }))
}

// ── FIFO write logger ──
// Wraps writeFifoRaw so every FIFO write attempt is observable — essential
// for debugging "message sent but CLI never replied" bugs. Success, EAGAIN
// backpressure, and ENXIO (dead reader) are all distinct signals.
function logFifoWrite(sid: string, bytes: number, result: 'ok' | 'EAGAIN' | 'ENXIO' | 'error', err?: string) {
  logMsg(result === 'ok' ? 'debug' : 'warn', 'fifo_write', { sid, bytes, result, ...(err ? { err } : {}) })
}

// ── Session idle scanner ──
// Runs every 60s, kills orphaned sessions per the decision tree:
//   - Process already dead → cleanup process group (kill MCP residuals)
//   - Has client watching → skip (Mac health monitor manages it)
//   - JSONL < 5min old → skip (active)
//   - JSONL 5min-2hr old → log warning
//   - JSONL > 2hr old + no watcher → kill sequence

// 5min: long enough for model response delays (up to 120s) and MCP tool execution,
// short enough to detect stuck sessions promptly.
const SESSION_IDLE_WARNING_MS = 5 * 60 * 1000     // 5 minutes
// 2hr: conservative — gives plenty of time for legitimate background work (builds,
// long MCP ops, await_human_action), but eventually reclaims resources.
const SESSION_IDLE_KILL_MS = 2 * 60 * 60 * 1000   // 2 hours
const SESSION_SCAN_INTERVAL_MS = 60_000            // every 60s

function scanIdleSessions() {
  const now = Date.now()

  for (const [sid, session] of sessions) {
    const pid = session.pid
    if (!pid) continue

    // 1. Process already dead? Clean up process group (MCP residuals) and skip
    if (session.exitCode !== null) {
      // Ensure any MCP children are also dead
      if (isProcessGroupAlive(pid)) {
        logMsg('info', 'idle scan: cleaning dead session process group', { sid, pid })
        killProcessGroup(pid, 'SIGKILL')
      }
      continue
    }

    // Check if process is actually alive (might have died without triggering exit event)
    let alive = false
    try { process.kill(pid, 0); alive = true } catch {}
    if (!alive) {
      // Process died but we missed the exit event — clean up via the central
      // reaper (handles FIFO unlink, broadcast, registry flush).
      reapSession(sid, -1, 'idle-scan-missed-exit')
      continue
    }

    // 2. Has at least one subscribed ws? Skip idle check — someone cares.
    if (session.subscribers.size > 0) continue

    // 3. Check JSONL file mtime
    let mtimeMs = 0
    try {
      const stat = fs.statSync(session.jsonlPath)
      mtimeMs = stat.mtimeMs
    } catch {
      continue  // Can't stat file — skip
    }

    const idleMs = now - mtimeMs

    if (idleMs < SESSION_IDLE_WARNING_MS) {
      // Active — skip
      continue
    } else if (idleMs < SESSION_IDLE_KILL_MS) {
      // Warning zone (5min - 2hr) — log but don't kill
      const idleMinutes = Math.round(idleMs / 60_000)
      logMsg('warn', 'idle scan: session idle with no subscribers', {
        sid, pid, idleMinutes, threshold: '2hr',
      })
    } else {
      // Kill zone (> 2hr) — no subscribers + 2hr no output → kill
      const idleMinutes = Math.round(idleMs / 60_000)
      logMsg('warn', 'idle scan: killing idle session (no subscribers, no output)', {
        sid, pid, idleMinutes,
      })
      killSessionProcessGroup(pid, sid)
    }
  }
}

/**
 * Startup cleanup: scan .pgid files for process groups not registered in the
 * sessions map. Two outcomes per .pgid file:
 *   - Process alive, sid NOT in sessions map → legacy/half-spawned orphan
 *     (daemon was killed between writing .pgid and persisting sessions.json).
 *     Adopt it so the session survives across daemon restarts instead of
 *     being silently killed. Mirrors daemon-source.ts's post-fix behavior.
 *   - Process dead → stale pgid file, remove it.
 *
 * IMPORTANT: sids already present in `sessions` were adopted by
 * reconcileRegistry() — DO NOT touch them here. This check is the fix for the
 * bug where cleanup killed sessions that reconcile had just adopted.
 */
function cleanupOrphanedProcessGroups() {
  let scanned = 0
  let skippedAdopted = 0
  let adoptedLegacy = 0
  let removedStale = 0
  try {
    const files = fs.readdirSync(STREAMS_DIR)
    for (const f of files) {
      if (!f.endsWith('.pgid')) continue
      scanned++
      const sid = f.replace('.pgid', '')

      // reconcileRegistry() already adopted this one with authoritative state.
      // Skipping here is load-bearing: without it, cleanup kills every session
      // reconcile just adopted (the bug that dropped 7 live clouddev sessions).
      if (sessions.has(sid)) {
        skippedAdopted++
        continue
      }

      try {
        const pgidPath = path.join(STREAMS_DIR, f)
        const pid = parseInt(fs.readFileSync(pgidPath, 'utf-8').trim(), 10)
        if (isNaN(pid) || pid <= 0) {
          try { fs.unlinkSync(pgidPath) } catch {}
          removedStale++
          continue
        }

        if (isProcessGroupAlive(pid)) {
          // Live process with no sessions.json entry — legacy pgid-only
          // (daemon died mid-spawn before persistRegistry). Adopt instead of
          // kill: the Claude CLI and its JSONL are intact, only the registry
          // entry was lost. Orphan poll will reap it if the process later dies.
          const jsonlPath = path.join(STREAMS_DIR, sid + '.jsonl')
          const pipePath = path.join(STREAMS_DIR, sid + '.pipe')
          logMsg('info', 'startup: adopting live session from previous daemon (legacy pgid-only)', { sid, pid })
          sessions.set(sid, {
            proc: null,
            pipePath,
            jsonlPath,
            pgidPath,
            pid,
            // Watcher starts at the CURRENT end of the jsonl — same rule as
            // registry adopt and attach-discover. 0 here would live-fan the
            // entire multi-MB history to the first subscriber AND poison the
            // client cursor (attach reply currentOffset=0 adopted as valid).
            offset: statSizeOrZero(jsonlPath),
            taskState: rebuildTaskStateFromJsonl(jsonlPath, Date.now()),
            watcher: null,
            subscribers: new Set(),
            exitCode: null,
            state: 'running',
            exitReason: null,
            exitedAt: null,
            parented: false,
            startTime: readStartTime(pid),
            cwd: '',
            args: [],
            orphanPollTimer: null,
            mode: 'default',
            pendingCtrl: null,
          })
          startOrphanPoll(sid)
          adoptedLegacy++
        } else {
          // Process gone — clean up the stale pgid file
          logMsg('info', 'startup cleanup: removing stale pgid for dead session', { sid, pid })
          try { fs.unlinkSync(pgidPath) } catch {}
          removedStale++
        }
      } catch (err) {
        logMsg('warn', 'startup cleanup: error processing pgid file', { sid, error: (err as Error).message })
      }
    }
  } catch (err) {
    logMsg('warn', 'startup cleanup: readdir failed', { streamsDir: STREAMS_DIR, error: (err as Error).message })
  }
  logMsg('info', 'startup cleanup: done', {
    scanned, skippedAdopted, adoptedLegacy, removedStale,
    sessionsAfter: sessions.size,
  })
}

// ── Cleanup ──
function cleanup() {
  // Phase C change: preserve running sessions across a graceful daemon
  // restart. The next daemon's reconcileRegistry() will adopt them as
  // orphans via the 1s poll. Previously we killed everything on SIGTERM
  // which defeated the orphan-survival property the plan requires.
  //
  // We still stop the session-bound file tailers so the SSH tunnel can close
  // cleanly, but we leave the CLI process groups alive — the successor daemon
  // will adopt them and spin new watchers on first attach.
  for (const [sid, session] of sessions) {
    stopSessionWatcher(sid)
    session.subscribers.clear()
    if (session.orphanPollTimer) {
      try { clearInterval(session.orphanPollTimer) } catch {}
    }
  }

  // Flush the registry one more time so the successor daemon sees the latest
  // state. We do NOT delete the registry — the next daemon reads it.
  try { persistRegistry() } catch {}

  // Stop all agent subs
  for (const [, sub] of agentSubs) {
    if (sub.timer) clearInterval(sub.timer)
    if (sub.rediscoverTimer) clearInterval(sub.rediscoverTimer)
  }
  // Remove port/pid/instance files (but NOT the sessions registry — successor needs it).
  // Instance file gets replaced by the successor's own id on the next --start.
  // ONLY if we still own the dir: when a zombie daemon exits via the heartbeat
  // self-check, daemon.pid already names the successor — unlinking would
  // destroy the live daemon's files and knock IT offline too.
  let ownsFiles = true
  try {
    const ownerPid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10)
    if (ownerPid > 0 && ownerPid !== process.pid) ownsFiles = false
  } catch {}
  if (ownsFiles) {
    try { fs.unlinkSync(PORT_FILE) } catch {}
    try { fs.unlinkSync(PID_FILE) } catch {}
    try { fs.unlinkSync(INSTANCE_ID_FILE) } catch {}
    try { fs.unlinkSync(VERSION_FILE) } catch {}
  }
  logMsg('info', 'daemon cleanup complete', { uptimeSec: Math.floor((Date.now() - DAEMON_START_TS) / 1000) })
}

// ── Handle disconnect for a WebSocket client ──
function handleDisconnect(ws: ServerWebSocket<WsData>) {
  wsClients.delete(ws)

  // DUP-DEBUG: count subscriber entries removed across all sessions for this
  // ws. If a subscriber leak shows up, this number tells us how many sids
  // were holding stale references to a now-closed ws.
  let removedFromSubs = 0
  const sidsWithRemoval: string[] = []
  // Remove this ws from every session's subscribers. The session-bound watcher
  // keeps running — it's independent of any ws. Next attach re-subscribes.
  for (const [sid, session] of sessions) {
    const had = session.subscribers.has(ws)
    if (had) {
      session.subscribers.delete(ws)
      removedFromSubs++
      sidsWithRemoval.push(sid)
    }
  }

  // Clean up agent subs for this client
  for (const [key, sub] of agentSubs) {
    if (sub.ws === ws) {
      if (sub.timer) clearInterval(sub.timer)
      if (sub.rediscoverTimer) clearInterval(sub.rediscoverTimer)
      agentSubs.delete(key)
    }
  }

  logMsg('info', 'client disconnected', {
    wsId: wsId(ws),
    clients: wsClients.size,
    removedFromSubs,
    sidsWithRemoval,
  })
}

// ── Main ──
const action = process.argv[2]

if (action === '--stop') {
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10)
    process.kill(pid, 'SIGTERM')
    console.log('daemon stopped (pid=' + pid + ')')
  } catch {
    console.log('daemon not running')
  }
  process.exit(0)
}

if (action === '--status') {
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10)
    process.kill(pid, 0)
    const port = fs.readFileSync(PORT_FILE, 'utf-8').trim()
    let instanceId: string | undefined
    try { instanceId = fs.readFileSync(INSTANCE_ID_FILE, 'utf-8').trim() } catch {}
    console.log(JSON.stringify({ running: true, pid, port: parseInt(port, 10), instanceId }))
  } catch {
    console.log(JSON.stringify({ running: false }))
  }
  process.exit(0)
}

if (action === '--start') {
  // Check if already running
  try {
    const existingPid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10)
    process.kill(existingPid, 0)
    const existingPort = fs.readFileSync(PORT_FILE, 'utf-8').trim()
    console.log(existingPort) // Already running — return port
    process.exit(0)
  } catch {
    // Not running, continue to start. `logMsg` below will use THIS process's
    // DAEMON_INSTANCE_ID; any leftover instance file from a crashed predecessor
    // gets overwritten at the end of startup.
  }

  fs.mkdirSync(DAEMON_DIR, { recursive: true })
  fs.mkdirSync(STREAMS_DIR, { recursive: true })

  // Phase C: startup reconcile — adopts live orphans (1s poll) and reaps
  // any entries whose pids are gone or recycled. Runs BEFORE the legacy
  // cleanup sweep so the registry's "known good" pids aren't misclassified
  // as orphan process groups to kill.
  logMsg('info', 'startup: reconcile begin', { registryFile: REGISTRY_FILE, streamsDir: STREAMS_DIR })
  try { reconcileRegistry() } catch (err) {
    logMsg('error', 'reconcileRegistry failed', { error: (err as Error).message })
  }
  logMsg('info', 'startup: reconcile done', {
    adoptedFromRegistry: sessions.size,
    sids: [...sessions.keys()],
  })

  // Clean up orphaned process groups from a previous daemon crash. reconcile()
  // already handled everything in sessions.json; this picks up .pgid files
  // that were never registered (e.g. half-spawned sessions from E13 window).
  cleanupOrphanedProcessGroups()
  logMsg('info', 'startup: complete — sessions ready', {
    totalSessions: sessions.size,
    sids: [...sessions.keys()],
  })

  // Start Bun.serve() with built-in WebSocket support
  const server = Bun.serve<WsData>({
    port: 0, // random port
    hostname: '127.0.0.1',

    fetch(req, server) {
      // Upgrade WebSocket requests
      if (server.upgrade(req, { data: {} })) {
        return undefined
      }
      return new Response('walnut-daemon ok')
    },

    websocket: {
      open(ws) {
        wsClients.add(ws)
        // DUP-DEBUG: assign + log a stable wsId so subsequent logs can
        // distinguish per-ws activity. Pair this with the matching close()
        // log; if a sid still has subscribers tagged with a wsId that has
        // already been closed, the daemon's GC of dead subscribers is broken.
        logMsg('info', 'client connected', { wsId: wsId(ws), clients: wsClients.size })
      },

      message(ws, msg) {
        handleCommand(ws, typeof msg === 'string' ? msg : Buffer.from(msg).toString())
      },

      // Socket buffer drained — flush messages that Bun dropped (send() === 0)
      // while it was saturated. See safeSend/enqueueForDrain.
      drain(ws) {
        flushSendQueue(ws)
      },

      close(ws) {
        handleDisconnect(ws)
      },
    },
  })

  const port = server.port
  fs.writeFileSync(PORT_FILE, String(port))
  fs.writeFileSync(PID_FILE, String(process.pid))
  fs.writeFileSync(VERSION_FILE, DAEMON_VERSION)
  // Instance ID file — lets clients detect PID recycling / daemon swap by
  // comparing the on-disk value against what `hello` returns. Stable for the
  // lifetime of this daemon; removed on graceful cleanup().
  fs.writeFileSync(INSTANCE_ID_FILE, DAEMON_INSTANCE_ID)
  console.log(port) // Print port for parent to capture
  logMsg('info', 'daemon started', {
    port,
    pid: process.pid,
    startedAt: DAEMON_START_TS,
  })

  // Start session idle scanner (every 60s)
  setInterval(scanIdleSessions, SESSION_SCAN_INTERVAL_MS)

  // Heartbeat: one JSON line every 30s with daemon vitals. Absence = wedged
  // daemon (event loop blocked, OOM, etc). Cheap to emit, huge diagnostic
  // value: `tail -F daemon-*.log | grep heartbeat` tells you a daemon is
  // alive even when it has no sessions.
  setInterval(() => {
    const mem = process.memoryUsage()
    logMsg('info', 'heartbeat', {
      sessions: sessions.size,
      wsClients: wsClients.size,
      agentSubs: agentSubs.size,
      uptimeSec: Math.floor((Date.now() - DAEMON_START_TS) / 1000),
      rssMb: Math.round(mem.rss / 1024 / 1024),
      heapMb: Math.round(mem.heapUsed / 1024 / 1024),
    })
    // Single-instance self-check: if daemon.pid no longer names US, a newer
    // daemon has taken over this dir and we are a zombie — two daemons sharing
    // one registry/streams dir corrupt each other (the loser keeps running
    // idle-kill timers against sessions it no longer owns; observed as a
    // 9-day-old parallel daemon). The PID file is authoritative: exit
    // gracefully and leave CLI processes alive for the winner to adopt.
    // Missing/unreadable file is NOT a takeover (could be transient fs error
    // or manual cleanup) — only a DIFFERENT live pid means we lost the dir.
    try {
      const ownerPid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10)
      if (ownerPid > 0 && ownerPid !== process.pid) {
        logMsg('warn', 'self-check: daemon.pid taken over by another instance — exiting', {
          ourPid: process.pid, ownerPid,
        })
        cleanup()
        process.exit(0)
      }
    } catch {}
  }, HEARTBEAT_INTERVAL_MS)

  // Handle signals
  process.on('SIGTERM', () => { cleanup(); process.exit(0) })
  process.on('SIGINT', () => { cleanup(); process.exit(0) })

  // Detach from terminal (close stdin so SSH doesn't hold)
  if (process.stdin.isTTY === false) {
    process.stdin.resume()
    process.stdin.on('end', () => {}) // Don't exit on stdin close
  }
} else {
  console.error('Usage: bun daemon-standalone.ts --start | --stop | --status | --version')
  process.exit(1)
}
