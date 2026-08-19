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
  decideBridgeRestart,
  detectCronFires,
  hasDiskCronInterest,
  isDurableCronRequest,
  durableCronDenyMessage,
  durableCronCorrectionMessage,
  cronFireMarkerText,
  stripCronTaskById,
  parseTurnErrorLine,
  resolveTurnRetryConfig,
  decideTurnRetry,
  applyTurnRetry,
  clearTurnRetryStreak,
  newTurnRetryState,
  turnRetryMessage,
  turnRetryMarkerText,
  turnRetryGiveUpText,
  type TurnRetryState,
  type CoreSessionData,
  type RegistryEntry as CoreRegistryEntry,
  type SessionMode,
  type PendingCtrl,
} from './daemon-core.js'
import { ADVERTISED_DAEMON_CAPABILITIES } from './daemon-capabilities.js'
import {
  foldLine,
  initialFoldState,
  assembleSnapshot,
  snapshotDiffers,
  type FoldState,
  type SessionSnapshot,
} from './daemon-fold.js'
import { createAcpDaemon, type AcpStartParams } from './acp-daemon.js'
import { computeGitDiff, GitDiffError, type GitDiffBase } from './git-diff-core.js'
import {
  computeHostLocalChanges,
  toLightChangesResult,
  type HostLocalComputeOutput,
  type FileAccum as ChangesFileAccum,
} from './session-changes-core.js'
import { scanExternalSessions } from './external-session-scan-core.js'
import { resolvePathHostLocal } from './path-resolve-core.js'
import {
  GATEWAY_SOCKET_FILENAME,
  GATEWAY_MAX_LINE_BYTES,
  gatewayHubTimeoutMs,
  parseGatewayLine,
  resolveCallerSid,
  type GatewayErrorCode,
  type GatewayResponse,
} from './gateway-core.js'
import { execFile as execFileCb } from 'node:child_process'

process.umask(0o077)

// ── Version ──
// Baked in at compile time via `bun build --define` (see scripts/build-daemon.sh).
const DAEMON_VERSION = process.env.DAEMON_VERSION || 'dev'

// `wn ...` argv is user text (peer messages) — it must never trigger the
// version fast-path (e.g. `wn peers send abc "--version"`).
if (process.argv.includes('--version') && process.argv[2] !== 'wn') {
  console.log(DAEMON_VERSION)
  process.exit(0)
}

// ── Constants ──
// DAEMON_DIR default is /tmp/open-walnut; tests override via env var.
// Must mirror daemon-source.ts (the JS fallback) — keep in sync.
// PROD_DAEMON_DIR is duplicated from local-daemon.ts (the daemon is a standalone
// binary and cannot import it); any dir OTHER than this one is "isolated" —
// sandbox, test, ephemeral demo — which decides CLI-reap-on-exit.
const PROD_DAEMON_DIR = '/tmp/open-walnut'
const DAEMON_DIR = process.env.WALNUT_DAEMON_DIR || PROD_DAEMON_DIR
// Home dir used to expand `~/...` paths from the app (e.g. ~/.claude/projects/...).
// In production this is the real HOME (daemon runs as the same user as walnut, so both
// resolve `~` identically). WALNUT_HOME_OVERRIDE lets a test point the daemon at the same
// throwaway home its mocked CLAUDE_HOME lives under, so `~/.claude` on both sides agree —
// without it, the daemon (a separate process) would read the real ~/.claude and never see
// the test fixtures. Same env-override pattern as WALNUT_DAEMON_DIR / WALNUT_STREAMS_DIR.
const HOME_DIR = process.env.WALNUT_HOME_OVERRIDE || process.env.HOME || '/root'
// Streams live under the user's HOME so they SURVIVE REBOOTS — /tmp is wiped on
// macOS/Linux restarts, which vaporized every stream file mid-session and left
// walnut's stored byte watermarks pointing into dead files (incident 019a7fe5:
// the stale 85 MB watermark silently vetoed every snapshot of the recreated
// file). Isolated daemons (tests/sandbox/demo — any non-prod WALNUT_DAEMON_DIR)
// keep the sibling-dir derivation so their streams stay in the throwaway area.
// LEGACY_STREAMS_DIR is the pre-2026-08 location; startup migrates dead-session
// files from it and live sessions keep their registry-recorded absolute paths.
const PROD_STREAMS_DIR = path.join(HOME_DIR, '.open-walnut', 'tmp', 'streams')
// Env override is for TESTS ONLY (never set in prod) — without it a spawned
// test daemon would migrate the REAL production /tmp/open-walnut-streams.
const LEGACY_STREAMS_DIR = process.env.WALNUT_LEGACY_STREAMS_DIR || '/tmp/open-walnut-streams'
const STREAMS_DIR = process.env.WALNUT_STREAMS_DIR
  || (DAEMON_DIR === PROD_DAEMON_DIR ? PROD_STREAMS_DIR : `${DAEMON_DIR}-streams`)
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
// Env override exists so tests can exercise heartbeat-driven behavior (the
// parent-liveness watchdog) without waiting 30s. Production leaves it unset.
const HEARTBEAT_INTERVAL_MS = (() => {
  const ms = parseInt(process.env.WALNUT_DAEMON_HEARTBEAT_MS || '', 10)
  return Number.isFinite(ms) && ms > 0 ? ms : 30_000
})()
// Parent-liveness watchdog (isolated-dir daemons only — see the heartbeat).
// 0 / unset / garbage → disabled, which is always the case for production.
const WATCHDOG_PARENT_PID = (() => {
  const pid = parseInt(process.env.WALNUT_DAEMON_PARENT_PID || '', 10)
  return Number.isFinite(pid) && pid > 0 ? pid : 0
})()

function ensureOwnerOnlyStorage(): void {
  const repair = (entryPath: string): void => {
    let stat: fs.Stats
    try { stat = fs.lstatSync(entryPath) } catch { return }
    if (stat.isSymbolicLink()) return
    if (stat.isDirectory()) {
      fs.chmodSync(entryPath, 0o700)
      let names: string[] = []
      try { names = fs.readdirSync(entryPath) } catch { return }
      for (const name of names) repair(path.join(entryPath, name))
      return
    }
    fs.chmodSync(entryPath, stat.mode & 0o111 ? 0o700 : 0o600)
  }

  fs.mkdirSync(DAEMON_DIR, { recursive: true, mode: 0o700 })
  fs.mkdirSync(STREAMS_DIR, { recursive: true, mode: 0o700 })
  fs.chmodSync(DAEMON_DIR, 0o700)
  fs.chmodSync(STREAMS_DIR, 0o700)
  for (const root of [DAEMON_DIR, STREAMS_DIR]) {
    for (const name of fs.readdirSync(root)) repair(path.join(root, name))
  }
}

// ── Legacy streams migration (/tmp/open-walnut-streams → HOME) ─────────────
// One-way, loss-averse, idempotent. Runs at startup BEFORE reconcileRegistry
// so adopted sessions see their files at the final location. Rules:
//   - Only when STREAMS_DIR is the prod HOME location and the legacy dir exists.
//   - A sid with a LIVE process group (per its .pgid) is SKIPPED ENTIRELY: the
//     CLI holds an O_APPEND fd on the old inode — moving the path would split
//     writer and readers. Its registry entry stores absolute paths, so it keeps
//     working from the legacy dir until that process dies; a later restart
//     migrates the files then.
//   - Never overwrite: a same-named file already in the new dir wins (it is
//     newer by construction — this daemon or a successor created it).
//   - rename() first (atomic, same volume); EXDEV falls back to copy + size
//     verify + unlink. A failed verify keeps the original in place.
//   - .pipe files are dead FIFOs from previous daemon lives — recreated at
//     spawn; deleted, not migrated.
function migrateLegacyStreams(): void {
  // Force flag is TEST-ONLY: prod triggers via the dir identity; isolated test
  // daemons opt in explicitly with their own temp legacy/streams dirs.
  if (STREAMS_DIR !== PROD_STREAMS_DIR && !process.env.WALNUT_FORCE_STREAMS_MIGRATION) return
  let names: string[] = []
  try { names = fs.readdirSync(LEGACY_STREAMS_DIR) } catch { return } // no legacy dir — done
  if (names.length === 0) return

  // Live-pgid sids: their whole file family stays put.
  const liveSids = new Set<string>()
  for (const f of names) {
    if (!f.endsWith('.pgid')) continue
    try {
      const pid = parseInt(fs.readFileSync(path.join(LEGACY_STREAMS_DIR, f), 'utf-8').trim(), 10)
      if (Number.isInteger(pid) && pid > 1 && isProcessGroupAlive(pid)) liveSids.add(f.slice(0, -'.pgid'.length))
    } catch {}
  }

  let migrated = 0, skippedLive = 0, skippedExists = 0, dropped = 0, failed = 0
  for (const f of names) {
    const src = path.join(LEGACY_STREAMS_DIR, f)
    const sid = f.replace(/\.(jsonl\.err|jsonl|pgid|pipe|log)$/, '')
    if (liveSids.has(sid)) { skippedLive++; continue }
    let st: fs.Stats
    try { st = fs.lstatSync(src) } catch { continue }
    if (st.isFIFO()) { try { fs.unlinkSync(src) } catch {}; dropped++; continue }
    if (!st.isFile()) continue // symlinks/dirs: not ours — leave untouched
    const dst = path.join(STREAMS_DIR, f)
    if (fs.existsSync(dst)) { skippedExists++; continue }
    try {
      fs.renameSync(src, dst)
      migrated++
    } catch {
      try {
        fs.copyFileSync(src, dst, fs.constants.COPYFILE_EXCL)
        if (fs.statSync(dst).size !== st.size) throw new Error('size mismatch after copy')
        fs.unlinkSync(src)
        migrated++
      } catch (err) {
        failed++
        try { fs.unlinkSync(dst) } catch {} // never leave a half-copy shadowing the original
        logMsg('warn', 'legacy streams migration: file failed (kept in place)', {
          file: f, error: (err as Error).message,
        })
      }
    }
  }
  logMsg('info', 'legacy streams migration: done', {
    from: LEGACY_STREAMS_DIR, to: STREAMS_DIR,
    migrated, skippedLive, skippedExists, droppedPipes: dropped, failed,
    liveSids: [...liveSids],
  })
}

// ── Dead-stream retention (3 months) ────────────────────────────────────────
// Streams now live under HOME and survive reboots, so they need a lifecycle:
// hourly, delete the file family of any sid that (a) is not in the live
// sessions map, (b) has no live process group, and (c) hasn't been written for
// RETENTION_MS. The conversation's real record lives in ~/.claude/projects/ —
// the stream file is status/replay plumbing, safe to reap after the window.
// Env overrides are TEST-ONLY (drive the sweep inside a test's timeframe).
const STREAM_RETENTION_MS = parseInt(process.env.WALNUT_STREAM_RETENTION_MS || '', 10)
  || 90 * 24 * 60 * 60 * 1000
const STREAM_RETENTION_SWEEP_MS = parseInt(process.env.WALNUT_STREAM_SWEEP_MS || '', 10)
  || 60 * 60 * 1000
function sweepDeadStreams(): void {
  let names: string[] = []
  try { names = fs.readdirSync(STREAMS_DIR) } catch { return }
  const now = Date.now()
  const reaped = new Set<string>()
  for (const f of names) {
    if (!f.endsWith('.jsonl')) continue
    const sid = f.slice(0, -'.jsonl'.length)
    if (sessions.has(sid)) continue
    const jsonlPath = path.join(STREAMS_DIR, f)
    let st: fs.Stats
    try { st = fs.statSync(jsonlPath) } catch { continue }
    if (now - st.mtimeMs < STREAM_RETENTION_MS) continue
    // Paranoia: a live pgid means a process still owns this family — skip.
    try {
      const pid = parseInt(fs.readFileSync(path.join(STREAMS_DIR, sid + '.pgid'), 'utf-8').trim(), 10)
      if (Number.isInteger(pid) && pid > 1 && isProcessGroupAlive(pid)) continue
    } catch {}
    for (const ext of ['.jsonl', '.jsonl.err', '.pgid', '.pipe', '.log']) {
      try { fs.unlinkSync(path.join(STREAMS_DIR, sid + ext)) } catch {}
    }
    reaped.add(sid)
  }
  if (reaped.size > 0) {
    logMsg('info', 'dead-stream retention sweep: reaped', { count: reaped.size, sids: [...reaped] })
  }
}

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
interface TaskStateEntry { status: string; v: number; t: number; description?: string; isBackgrounded?: boolean }
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
  // C1: incremental fold of the stream file → authoritative SessionSnapshot
  // (docs/plan/session-snapshot-source-of-truth.md §4). Maintains its own v
  // and bg map — coexists with taskState L2 (retirement is C4's call).
  foldState: FoldState
  // Last snapshot pushed to subscribers — change detection ignores bare v advance.
  lastPushedSnapshot?: SessionSnapshot | null
  // 50ms coalesce timer for snapshot pushes (death pushes skip it).
  snapshotTimer?: ReturnType<typeof setTimeout> | null
  spawnTs?: number   // latency instrumentation: CLI spawn ts
  sawInit?: boolean  // latency instrumentation: first init line seen
  // Scheduled-task (CLI cron) fire detection — see daemon-core detectCronFires.
  // Dedup map `${taskId}:${lastFiredAt}` → detectedAtMs; in-memory only.
  cronWarned?: Record<string, number>
  lastCronCheckTs?: number
  // Disk-side cron interest cache for the idle scan (60s scans × N sessions
  // would otherwise re-read scheduled_tasks.json every minute forever).
  diskCronCache?: { at: number; armed: boolean; reason: 'creator' | 'lock_holder' | null }
  // durable:true CronCreate corrections already injected, keyed by tool_use id.
  durableCronNudged?: Record<string, number>
  // Tailer self-heal: last forced watcher rebuild ts. Session-level (not watcher
  // closure) so the rebuilt watcher inherits the cooldown — a persistent error
  // (EMFILE) can't thrash rebuild every few seconds.
  lastWatcherHealAt?: number
  // Identity of the stream FILE (dev:ino:birthtimeMs, computed at spawn/adopt).
  // Rides every snapshot so walnut can tell "same file, higher v" from "the
  // file was recreated and v restarted at 0" (incident 019a7fe5). null when
  // stat failed; recomputed lazily by streamEpochOf.
  streamEpoch?: string | null
  // Turn-error auto-retry (see daemon-core decideTurnRetry). Streak bookkeeping
  // persists in the registry so a daemon restart can't reset a 12h budget to 0.
  turnRetry?: TurnRetryState
  // Pending retry timer — cleared by any real send (the human took over) and by
  // reapSession, so a resume can never fire behind a user's back or after death.
  turnRetryTimer?: ReturnType<typeof setTimeout> | null
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
  /**
   * 'bridge' = the cloud dial-out socket. The cloud box is a semi-trusted
   * PUBLIC relay, so its inbound frames are restricted to the phone-proxy
   * command set (BRIDGE_ALLOWED_COMMANDS) — the full privileged RPC surface
   * (fs.write/start/bridge.configure/…) is reachable ONLY over the trusted
   * SSH-tunneled client path. Absent = trusted local/SSH client.
   */
  origin?: 'bridge'
}

/**
 * Commands the cloud bridge is allowed to invoke. This MUST stay a subset of
 * what routes/session-stream-v1.ts + ws/bridge-registry.ts actually send:
 * status/appendUserMarker/send/attach/read-history/ping. Anything else from a
 * bridge socket is a compromised-cloud-box escalation attempt and is rejected.
 */
const BRIDGE_ALLOWED_COMMANDS = new Set([
  'status', 'appendUserMarker', 'send', 'attach', 'read-history', 'ping', 'bridgeResume', 'stt',
  // Narrow image fetch (extension allowlist + size cap) — lets the cloud box
  // proxy session-referenced pictures to phones. NOT fs.read: a compromised
  // cloud box must never get arbitrary file reads on exec hosts.
  'fs.readImage',
  // Narrow image save (mediaType allowlist + decoded-size cap + magic-byte
  // check, fixed daemon-owned directory, generated filename) — lets a phone
  // attach pictures to a session over the cloud box. NOT fs.write: a
  // compromised cloud box must never get arbitrary file writes on exec hosts.
  'image.save',
  // Narrow bounded file read (2MB cap + host-side path sandbox: traversal
  // rejection, realpath resolution, secret-path denylist) — lets the cloud
  // box serve phone file previews (HTML/text) for files on this host. NOT
  // fs.read: a compromised cloud box must never get unbounded arbitrary
  // reads (keys, configs) off exec hosts.
  'fs.readBounded',
  // Narrow launch relay: forwarded UP to the connected walnut server (same
  // relay shape as stt), which runs its full quick-start validation chain —
  // the daemon spawns NOTHING from this command. NOT the raw spawn command:
  // a compromised cloud box must never hand this daemon arbitrary argv.
  'session.launch',
  // Narrow control relay (model/effort/fork/model-options): same forward-to-
  // walnut-server shape as session.launch — the daemon executes NOTHING
  // itself, the primary re-validates everything.
  'session.control',
  // Narrow message relay: forwarded UP to the connected walnut server, which
  // enqueues into the DURABLE session message queue (same store + reconnect
  // redelivery as web sends). The asymmetry fix for the 2026-08-13 phone-send
  // data-loss family — a daemon death mid-sequence becomes delayed delivery,
  // not loss. The daemon writes NOTHING itself from this command.
  'session.message',
])

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
  // debug lines (cmd_recv per status poll ≈ 3/sec) are each a SYNCHRONOUS
  // appendFileSync — 60k+ writes/day of pure polling noise. Gate them behind
  // an env opt-in; info/warn/error always land. Keep in sync with daemon-source.ts.
  if (level === 'debug' && process.env.WALNUT_DAEMON_DEBUG !== '1') return
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

// ── Exit breadcrumb + last-resort crash guards ──
// The daemon died SILENTLY ≥7 times over 2026-08-11..13 (mid phone-bridge
// sends): no log line, no exit trace, stderr discarded by the spawner. This
// mirrors the server's /tmp/open-walnut-exit.log pattern: every JS-visible
// death appends one line to daemon-exit-<instanceId>.log in the daemon dir.
// A crash with NO breadcrumb but a stderr tail (local-daemon.ts now captures
// it) = a runtime-level death (OOM / native abort) that JS can never see.
// Keep in sync with daemon-source.ts.
const EXIT_BREADCRUMB_FILE = path.join(DAEMON_DIR, `daemon-exit-${DAEMON_INSTANCE_ID}.log`)
function writeExitBreadcrumb(kind: string, err: unknown): void {
  try {
    const mem = process.memoryUsage()
    let sessionCount = -1
    try { sessionCount = sessions.size } catch { /* module-init crash: map not born yet */ }
    fs.appendFileSync(EXIT_BREADCRUMB_FILE, JSON.stringify({
      ts: new Date().toISOString(),
      kind,
      pid: process.pid,
      instanceId: DAEMON_INSTANCE_ID,
      uptimeSec: Math.floor((Date.now() - DAEMON_START_TS) / 1000),
      rssMb: Math.round(mem.rss / 1024 / 1024),
      heapMb: Math.round(mem.heapUsed / 1024 / 1024),
      sessions: sessionCount,
      error: err instanceof Error ? err.message : (err === undefined ? undefined : String(err)),
      stack: err instanceof Error ? err.stack : undefined,
    }) + '\n')
  } catch { /* the breadcrumb must never be the thing that crashes */ }
}

/** Fatal-path funnel: structured log + breadcrumb, then exit(1) so the
 *  supervisor (LocalDaemon.ensureRunning / next Mac reconnect) respawns a
 *  clean process instead of us limping on with unknown state. */
function daemonCrash(kind: 'uncaughtException' | 'unhandledRejection', err: unknown): void {
  try {
    logMsg('error', 'FATAL: ' + kind + ' — daemon exiting', {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    })
  } catch {}
  writeExitBreadcrumb(kind, err)
  process.exit(1)
}

// Registered at module scope so even a startup-phase crash (reconcile,
// migration) leaves a breadcrumb. exit(1), never limp on: after an arbitrary
// throw the in-memory session state is unknowable, and a clean respawn
// re-adopts every live CLI from the registry (Phase C reconcile).
process.on('uncaughtException', (err) => daemonCrash('uncaughtException', err))
process.on('unhandledRejection', (reason) => daemonCrash('unhandledRejection', reason))

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
  // pid ≤ 1 can only be corrupted bookkeeping (a stale registry/pgid file).
  // kill(-1, sig) does NOT throw — POSIX broadcasts it to every process the
  // user can signal; on 2026-08-09 that tore down an entire GUI session.
  if (!Number.isInteger(pid) || pid <= 1) return false
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

/** Block the thread without spinning the event loop (cleanup() has no timers). */
function sleepSync(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Is this an isolated-dir daemon (sandbox / test / ephemeral demo) whose CLI
 * children must die with it? Derived from DAEMON_DIR — the same definition
 * local-daemon.ts uses for parentWatchdogEnv/stopIfIsolated — NOT from
 * WALNUT_DAEMON_PARENT_PID. Deriving it means test launchers that spawn the
 * daemon directly (7 of them) get the leak fix without opting in, and a stale
 * inherited PARENT_PID can never trick the PRODUCTION daemon into killing live
 * sessions. Keep in sync with daemon-source.ts.
 */
function shouldReapOnExit(): boolean {
  try {
    return path.resolve(DAEMON_DIR) !== path.resolve(PROD_DAEMON_DIR)
  } catch {
    return false // unresolvable → treat as prod (never kill)
  }
}

/**
 * Synchronous kill-all for isolated-dir daemon exit (cleanup() runs right
 * before process.exit, so the async ladder in killSessionProcessGroup would
 * never fire). Mirrors that ladder's phases — SIGINT (on-stop hooks) → SIGTERM
 * → SIGKILL — with a budget sized above the CLI's ~3.5-5s graceful-shutdown
 * window so hooks are not truncated (CLAUDE.md: never force-kill the CLI).
 * Production daemons never call this — see cleanup().
 */
function reapAllSessionGroupsSync() {
  const pids: number[] = []
  for (const [sid, session] of sessions) {
    // Only LIVE sessions. A dead session's `pid` is never nulled, and macOS
    // recycles pids — signalling a stale one can hit an unrelated process
    // group that inherited the number (another agent's daemon, a browser).
    if (session.state !== 'running' || session.exitCode !== null) continue
    if (!session.pid || !isProcessGroupAlive(session.pid)) continue
    logMsg('info', 'isolated-dir exit: SIGINT session group', { sid, pid: session.pid })
    killProcessGroup(session.pid, 'SIGINT')
    pids.push(session.pid)
  }
  if (pids.length === 0) return

  // Phase 1 — SIGINT grace. The CLI needs ~3.5s (2s cleanup race + 1.5s
  // SessionEnd hooks); poll so a fast exit doesn't cost the full budget.
  const sigintDeadline = Date.now() + 5000
  while (Date.now() < sigintDeadline && pids.some(isProcessGroupAlive)) sleepSync(200)

  // Phase 2 — SIGTERM the stragglers.
  const stillAlive = pids.filter(isProcessGroupAlive)
  if (stillAlive.length === 0) return
  for (const pid of stillAlive) {
    logMsg('info', 'isolated-dir exit: SIGTERM session group', { pid })
    killProcessGroup(pid, 'SIGTERM')
  }
  const termDeadline = Date.now() + 2000
  while (Date.now() < termDeadline && stillAlive.some(isProcessGroupAlive)) sleepSync(200)

  // Phase 3 — SIGKILL whatever refuses to die (orphan CLIs blocked on FIFO
  // stdin ignore SIGTERM entirely; observed 2026-07-25).
  for (const pid of stillAlive) {
    if (isProcessGroupAlive(pid)) {
      logMsg('warn', 'isolated-dir exit: SIGKILL session group', { pid })
      killProcessGroup(pid, 'SIGKILL')
    }
  }
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
    // GATEWAY_SHIM_DIR is appended at runtime (string concat, not a $HOME
    // template) so `wn` — the peer-session CLI shim — is on every session's
    // PATH. Keep in sync with daemon-source.ts.
    'export PATH="$PATH:$HOME/.toolbox/bin:$HOME/.local/bin:$HOME/.npm-global/bin:'
      + GATEWAY_SHIM_DIR + '"',
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
// embedding a tool input can easily exceed that. See writeFifoFullyAsync docs
// in daemon-core.ts for why a single non-blocking writeSync isn't safe. This
// SYNC variant (500ms busy-wait budget) is only safe here because auto-allow
// fires while the CLI is provably alive and draining stdin (it just emitted
// the control_request); user sends go through the async path in daemon-core.
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
const BG_TERMINAL_STATUSES = new Set(['completed', 'failed', 'stopped', 'cancelled', 'killed'])
const BG_TRANSITION_CAP = 50 // recentTransitions ring buffer bound

function emptyTaskState(): TaskState {
  return { tasks: {}, resourceVersion: 0, updatedAt: 0, derivedRunning: 0, recentTransitions: [] }
}

// GATING count: tasks the CLI flagged is_backgrounded are excluded — the CLI's own
// turn-end does not wait for them (it emits result+idle while they run), so a daemon
// derivedRunning that counted one would veto Walnut's turn-over convergence for the
// task's whole lifetime (incident 07fffbe5: a 16-min backgrounded grep).
function runningTaskCount(ts: TaskState): number {
  let n = 0
  for (const id in ts.tasks) {
    if (ts.tasks[id].isBackgrounded) continue
    if (!BG_TERMINAL_STATUSES.has(ts.tasks[id].status)) n++
  }
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
  let isBackgrounded = prev ? prev.isBackgrounded === true : false
  if (subtype === 'task_started') {
    // Terminal is terminal: a late/duplicate start can't revive a finished task.
    nextStatus = prev && BG_TERMINAL_STATUSES.has(prev.status) ? prev.status : 'running'
  } else if (subtype === 'task_progress') {
    nextStatus = prev && BG_TERMINAL_STATUSES.has(prev.status) ? prev.status : 'running'
  } else if (subtype === 'task_updated') {
    const patch = parsed.patch as Record<string, unknown> | undefined
    const ps = patch?.status as string | undefined
    nextStatus = ps ?? prev?.status ?? 'running'
    // Sticky: is_backgrounded=true detaches the task from turn-over gating forever
    // (no CLI path un-backgrounds a task). See runningTaskCount.
    if (patch?.is_backgrounded === true) isBackgrounded = true
  } else if (subtype === 'task_notification') {
    nextStatus = (parsed.status as string | undefined) ?? prev?.status ?? 'running'
  } else {
    return false
  }
  const wasTerminal = prev ? BG_TERMINAL_STATUSES.has(prev.status) : false
  const isTerminal = BG_TERMINAL_STATUSES.has(nextStatus)
  ts.tasks[taskId] = { status: nextStatus, v, t: now, description: (parsed.description as string | undefined) ?? prev?.description, isBackgrounded: isBackgrounded || undefined }
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
//
// STREAMED, never readFileSync: the old whole-file read materialized a whale
// jsonl (156MB observed) as one string + a split() array on every
// attach/resume/adopt — RSS 104MB→789MB in ~30s before a silent Bun death
// (the 2026-08-13 phone-send data-loss family). Same 1MB-chunk + byte-carry
// shape as rebuildFoldStateFromJsonl; the '"task_' substring pre-filter means
// almost no line is ever decoded. Keep in sync with daemon-source.ts.
const TASK_LINE_MARKER = Buffer.from('"task_')
function rebuildTaskStateFromJsonl(jsonlPath: string, now: number): TaskState {
  const ts = emptyTaskState()
  let fd: number
  try { fd = fs.openSync(jsonlPath, 'r') } catch { return ts }
  try {
    const buf = Buffer.alloc(FOLD_REBUILD_CHUNK)
    let filePos = 0
    let v = 0
    let carry: Buffer = Buffer.alloc(0)
    let discardThroughNextNewline = false
    for (;;) {
      const n = fs.readSync(fd, buf, 0, FOLD_REBUILD_CHUNK, filePos)
      if (n <= 0) break
      filePos += n
      const chunk = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n)
      let start = 0
      for (;;) {
        const nl = chunk.indexOf(10, start)
        if (nl === -1) break
        v += (nl - start) + 1
        if (discardThroughNextNewline) discardThroughNextNewline = false
        // Byte-level pre-filter on JUST this line's slice (no copy): only
        // task_* lines are ever decoded to a string.
        else if (chunk.subarray(start, nl).includes(TASK_LINE_MARKER)) {
          const line = chunk.subarray(start, nl).toString('utf-8')
          if (line.trim() && line.includes('"task_')) {
            try { applyTaskEvent(ts, JSON.parse(line), v, now) } catch {}
          }
        }
        start = nl + 1
      }
      carry = Buffer.from(chunk.subarray(start))
      if (carry.length > TAILER_CARRY_MAX) {
        logMsg('error', 'task rebuild carry overflow — dropping oversized partial line', {
          jsonlPath, carryBytes: carry.length, cap: TAILER_CARRY_MAX, filePos,
        })
        v = filePos
        carry = Buffer.alloc(0)
        discardThroughNextNewline = true
      }
    }
  } catch { /* partial rebuild is still safe — recent state wins on the live stream */ } finally {
    try { fs.closeSync(fd) } catch {}
  }
  return ts
}

// ── C1: session-snapshot fold (docs/plan/session-snapshot-source-of-truth.md §4) ──
// The daemon folds the stream file line-by-line into an authoritative
// SessionSnapshot (foldLine/assembleSnapshot from daemon-fold.ts) and pushes
// {ev:'snapshot'} to subscribers on change. Coexists with taskState L2 —
// retirement of L2 is C4's call. Keep in sync with daemon-source.ts.
const SNAPSHOT_COALESCE_MS = 50

// Upper bound on the tailer's in-memory torn-tail carry (see ensureWatcher).
// A single stream line larger than this cannot be assembled, so we log and
// realign rather than growing the buffer without limit.
const TAILER_CARRY_MAX = 32 * 1024 * 1024

// Result of a fold rebuild: the folded state PLUS the byte offset of the last
// COMPLETE-line boundary it stopped at. Every adopt/attach/resume site must seed
// the watcher from `boundary`, never from a raw stat().size (contract §4
// "Rebuild boundary rule").
interface FoldRebuild {
  state: FoldState
  /** Absolute offset after the last complete (newline-terminated) line. */
  boundary: number
}

// Stream the whole jsonl through foldLine, from byte 0. Used by every rebuild
// site (daemon start / adopt / attach-discover / resume / unknown-sid getState).
// Reads in 1MB chunks and carries the torn tail as BYTES (a UTF-8 char split
// across chunks must not be decoded twice) so whale files never materialize as
// one string.
//
// A final unterminated segment (the CLI was mid-write when we read) is NOT
// folded and NOT counted in `boundary` — same rule as the live tailer's carry.
// Folding it would (a) parse a fragment as a whole line and (b) advance `v` past
// the real line end, so when the newline finally arrives the tailer's
// `v > foldState.v` guard skips the COMPLETE line forever. Reporting `boundary`
// (rather than stat().size) is what lets the caller start the watcher on a line
// boundary so the torn region is simply re-read.
//
// Carry cap: identical to the tailer's. A single line larger than the cap can't
// be assembled, so we drop it and realign on the next newline instead of
// re-concatenating an unbounded buffer (the old loop grew it with O(n²) copying).
// Keep in sync with daemon-source.ts.
const FOLD_REBUILD_CHUNK = 1024 * 1024
function rebuildFoldStateFromJsonl(jsonlPath: string): FoldRebuild {
  let state = initialFoldState(0)
  let fd: number
  // Running end-of-line byte offset — same coordinate as the tailer's v. Only
  // ever advanced past COMPLETE lines, so it doubles as the boundary.
  let v = 0
  try { fd = fs.openSync(jsonlPath, 'r') } catch { return { state, boundary: 0 } }
  try {
    const buf = Buffer.alloc(FOLD_REBUILD_CHUNK)
    let filePos = 0
    let carry: Buffer = Buffer.alloc(0)
    let discardThroughNextNewline = false
    for (;;) {
      const n = fs.readSync(fd, buf, 0, FOLD_REBUILD_CHUNK, filePos)
      if (n <= 0) break
      filePos += n
      const chunk = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n)
      let start = 0
      for (;;) {
        const nl = chunk.indexOf(10, start) // '\n'
        if (nl === -1) break
        v += (nl - start) + 1
        if (discardThroughNextNewline) discardThroughNextNewline = false
        else {
          const line = chunk.subarray(start, nl).toString('utf-8')
          if (line.trim()) state = foldLine(state, line, v)
        }
        start = nl + 1
      }
      // Copy the torn tail — `buf` is reused by the next readSync.
      carry = Buffer.from(chunk.subarray(start))
      if (carry.length > TAILER_CARRY_MAX) {
        logMsg('error', 'fold rebuild carry overflow — dropping oversized partial line', {
          jsonlPath, carryBytes: carry.length, cap: TAILER_CARRY_MAX, filePos,
        })
        v = filePos
        carry = Buffer.alloc(0)
        discardThroughNextNewline = true
      }
    }
    // A trailing unterminated fragment is deliberately left unfolded — see above.
  } catch { /* partial fold is still monotone-safe — serve what we have */ } finally {
    try { fs.closeSync(fd) } catch {}
  }
  return { state, boundary: v }
}

// ── C18: synchronous pre-death fold drain ──
// The CLI writes its final `result` + companion `idle` lines microseconds before
// exiting, and the tailer's 100ms poll does nothing once `state !== 'running'`
// (reapSession flips that first). Without this drain the death snapshot — and
// every later getState pull, which just re-assembles the same frozen fold —
// reports turnActive=true for a turn that provably ended on disk.
//
// Reads from the last complete-line boundary the watcher published (its in-memory
// carry died with it, so the torn region is simply re-read) to EOF, folds every
// COMPLETE line, and re-publishes the boundary. Bounded by the same carry cap.
// Keep in sync with daemon-source.ts drainSessionFold.
function drainSessionFold(session: SessionData): void {
  const from = session.watcher ? session.watcher.offset : (session.offset || 0)
  let size = 0
  try { size = fs.statSync(session.jsonlPath).size } catch { return }
  if (size <= from) return
  const boundary = drainFoldRange(session, from, size)
  session.offset = boundary
  if (session.watcher) session.watcher.offset = boundary
}

// Fold [from, to) into session.foldState, honoring the `v > foldState.v` guard
// (bytes already folded out-of-band must not fold twice). Returns the new
// complete-line boundary. Keep in sync with daemon-source.ts.
function drainFoldRange(session: SessionData, from: number, to: number): number {
  let boundary = from
  let fd: number
  try { fd = fs.openSync(session.jsonlPath, 'r') } catch { return boundary }
  try {
    const buf = Buffer.alloc(FOLD_REBUILD_CHUNK)
    let filePos = from
    let carry: Buffer = Buffer.alloc(0)
    let discardThroughNextNewline = false
    while (filePos < to) {
      const want = Math.min(FOLD_REBUILD_CHUNK, to - filePos)
      const n = fs.readSync(fd, buf, 0, want, filePos)
      if (n <= 0) break
      filePos += n
      const chunk = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n)
      let start = 0
      for (;;) {
        const nl = chunk.indexOf(10, start)
        if (nl === -1) break
        boundary += (nl - start) + 1
        if (discardThroughNextNewline) discardThroughNextNewline = false
        else {
          const line = chunk.subarray(start, nl).toString('utf-8')
          if (line.trim() && boundary > session.foldState.v) {
            session.foldState = foldLine(session.foldState, line, boundary)
          }
        }
        start = nl + 1
      }
      carry = Buffer.from(chunk.subarray(start))
      if (carry.length > TAILER_CARRY_MAX) {
        logMsg('error', 'fold drain carry overflow — dropping oversized partial line', {
          jsonlPath: session.jsonlPath, carryBytes: carry.length, cap: TAILER_CARRY_MAX, filePos,
        })
        boundary = filePos
        carry = Buffer.alloc(0)
        discardThroughNextNewline = true
      }
    }
  } catch { /* partial drain is still monotone-safe */ } finally {
    try { fs.closeSync(fd) } catch {}
  }
  return boundary
}

// Stream-file identity: dev:ino:birthtimeMs. Changes exactly when the FILE is
// recreated (reboot wiped /tmp, manual delete) — the event that resets v to 0
// and invalidates every consumer-side watermark. Cached on the session; a
// failed stat leaves null (walnut treats null as "epoch unknown, no reset").
// Keep in sync with daemon-source.ts.
function streamEpochOf(session: SessionData): string | null {
  if (session.streamEpoch) return session.streamEpoch
  try {
    const st = fs.statSync(session.jsonlPath)
    session.streamEpoch = `${st.dev}:${st.ino}:${Math.floor(st.birthtimeMs)}`
  } catch {
    session.streamEpoch = null
  }
  return session.streamEpoch
}

// Combine the pure fold with imperatively-tracked daemon facts. exitCode is
// already normalized by reapSession (isTurnCompleteExit) by the time state
// flips to 'dead'.
function assembleSessionSnapshot(session: SessionData): SessionSnapshot {
  const ctrl = session.pendingCtrl
  const snap = assembleSnapshot({
    foldState: session.foldState,
    pendingCtrl: ctrl
      ? { requestId: ctrl.reqId, toolName: ctrl.toolName, sinceTs: ctrl.receivedAt }
      : null,
    dead: session.state === 'dead',
    pid: session.pid,
    exitCode: session.exitCode,
    streamEpoch: streamEpochOf(session),
  })
  // Disk-side durable crons arm cronActive too (fold only sees CronCreate in
  // THIS stream file — blind after wipe/--resume/adoption). One-way OR: the
  // walnut health monitor treats snapshot cronActive as arm-only, so a stale
  // cache never *unarms* anything. Cache is filled by the idle scan (60s).
  if (!snap.cronActive && session.diskCronCache && session.diskCronCache.armed) snap.cronActive = true
  return snap
}

// snapshotDiffers (the change-compare that ignores a bare v advance) is
// imported from daemon-fold.ts — it is pure + zero-dep, so it rides the same
// injection path into the source template instead of being hand-mirrored there.

function emitSnapshot(sid: string, session: SessionData): void {
  const snapshot = assembleSessionSnapshot(session)
  const prev = session.lastPushedSnapshot
  if (prev && !snapshotDiffers(prev, snapshot)) return
  session.lastPushedSnapshot = snapshot
  for (const ws of session.subscribers) {
    if (ws.readyState === 1) {
      try { sendEvent(ws, 'snapshot', { sid, snapshot }) } catch {}
    }
  }
}

// Push entry point: coalesce within a 50ms window; death snapshots skip the
// coalesce (immediate=true) so a dead session is never reported late.
function pushSnapshot(sid: string, immediate: boolean): void {
  const session = sessions.get(sid)
  if (!session) return
  if (immediate) {
    if (session.snapshotTimer) { clearTimeout(session.snapshotTimer); session.snapshotTimer = null }
    emitSnapshot(sid, session)
    return
  }
  if (session.snapshotTimer) return // window already open — coalesce
  session.snapshotTimer = setTimeout(() => {
    session.snapshotTimer = null
    // Generation guard: cmdStart may have replaced the session under this sid.
    if (sessions.get(sid) !== session) return
    emitSnapshot(sid, session)
  }, SNAPSHOT_COALESCE_MS)
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
  // C1 snapshot hooks — appendUserMarker overlays its marker immediately; reap /
  // pendingCtrl-clear paths push through the coalescer (death = immediate).
  foldAppendedLineFn: (session, rawLine) => {
    // Optimistic overlay at the CURRENT v — NO v advance (contract §4 "Feed").
    // Any offset computed here would race the concurrently-appending CLI and
    // could push foldState.v past a line the tailer hasn't read yet, which the
    // `v > foldState.v` guard would then skip forever. The tailer re-folds this
    // marker at its true v; re-anchoring is idempotent. Keep in sync with
    // daemon-source.ts cmdAppendUserMarker.
    session.foldState = foldLine(session.foldState, rawLine, session.foldState.v)
  },
  pushSnapshotFn: (sid, immediate) => pushSnapshot(sid, immediate),
  // C18: synchronous pre-death fold drain (see drainSessionFold).
  drainFoldFn: (session) => drainSessionFold(session),
  createAdoptedSession: (_sid, entry) => {
    // C1: rebuild fold state from the durable jsonl (streamed, whale-safe) AND
    // take the watcher offset from the SAME rebuild's complete-line boundary.
    // Contract §4 "Rebuild boundary rule": a raw stat().size here would start
    // the watcher MID-LINE whenever the CLI was writing during adopt — the
    // rebuild would have consumed the fragment's first half and the completed
    // line would never be folded whole (C3/C7).
    const adoptFold = rebuildFoldStateFromJsonl(entry.jsonlPath)
    return {
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
      offset: adoptFold.boundary,
      // Rebuild task state from the durable jsonl — recovers terminal events the previous
      // daemon generation saw (and Walnut's live stream may have missed across the restart).
      taskState: rebuildTaskStateFromJsonl(entry.jsonlPath, Date.now()),
      foldState: adoptFold.state,
      watcher: null,
      subscribers: new Set(),
      exitCode: null,
      state: 'running' as const,
      exitReason: null,
      exitedAt: null,
      parented: false,
      startTime: entry.startTime,
      cwd: entry.cwd ?? '',
      args: entry.args ?? [],
      orphanPollTimer: null,
      mode: entry.mode ?? 'default',
      pendingCtrl: entry.pendingCtrl ?? null,
    }
  },
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

// ── ACP worker supervision (in-process model; see acp-daemon.ts) ──
const acp = createAcpDaemon<ServerWebSocket<WsData>>({
  streamsDir: STREAMS_DIR,
  daemonDir: DAEMON_DIR,
  sendEvent,
  isWsOpen: (ws) => ws.readyState === 1,
  log: logMsg,
})

// Daemon NEVER auto-exits. It's a permanent process manager on the remote host.
// Mac disconnecting should NOT cause daemon to exit — sessions keep running.
// Session lifecycle is managed by the session idle scanner (scanIdleSessions).

// ── Session management commands ──

function handleCommand(ws: ServerWebSocket<WsData>, msg: string) {
  let cmd: Record<string, unknown>
  try { cmd = JSON.parse(msg) } catch { return sendError(ws, null, 'invalid JSON') }
  // Valid JSON ≠ a command frame: "null"/"42"/"\"x\"" parse fine but the
  // destructure below would THROW on null (a poison frame that predates the
  // dispatch guard — one bad client frame killed the whole daemon).
  if (!cmd || typeof cmd !== 'object') return sendError(ws, null, 'invalid JSON')
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

  // Cloud bridge is a PUBLIC relay: restrict it to the phone-proxy command set.
  // A frame outside the allowlist on a bridge socket means the cloud box was
  // compromised and is trying to escalate to fs.write/start/etc — refuse it.
  if (ws.data?.origin === 'bridge' && !BRIDGE_ALLOWED_COMMANDS.has(cmd.cmd as string)) {
    logMsg('warn', 'bridge: rejected non-allowlisted command', { cmd: cmd.cmd, id })
    return sendError(ws, id as number, 'command not permitted over bridge: ' + cmd.cmd)
  }

  // One command must never kill the daemon: a throw anywhere in a handler
  // (the pre-guard era: a whale-file rebuild OOM inside cmdAttach took the
  // whole process down MID phone-send — marker written, message lost) becomes
  // an error reply to the caller. Async handlers (fs.*) return promises — a
  // rejection there would otherwise surface as unhandledRejection and trip
  // the fatal guard above, so it is caught here too.
  // Keep in sync with daemon-source.ts.
  const replyError = (err: unknown) => {
    logMsg('error', 'handleCommand: handler threw — replying with error instead of dying', {
      cmd: cmd.cmd, id, sid,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    })
    sendError(ws, id as number, 'internal daemon error handling ' + cmd.cmd + ': '
      + (err instanceof Error ? err.message : String(err)))
  }
  try {
    const out = dispatchCommand(ws, id as number, cmd) as unknown
    if (out && typeof (out as Promise<unknown>).then === 'function') {
      (out as Promise<unknown>).catch(replyError)
    }
    return
  } catch (err) {
    return replyError(err)
  }
}

function dispatchCommand(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  switch (cmd.cmd) {
    case 'start': return cmdStart(ws, id as number, cmd)
    case 'attach': return cmdAttach(ws, id as number, cmd)
    case 'send': return cmdSend(ws, id as number, cmd)
    case 'sendRaw': return cmdSendRaw(ws, id as number, cmd)
    case 'appendUserMarker': return cmdAppendUserMarker(ws, id as number, cmd)
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
    case 'fs.readImage': return cmdFsReadImage(ws, id as number, cmd)
    case 'fs.readBounded': return cmdFsReadBounded(ws, id as number, cmd)
    case 'image.save': return cmdImageSave(ws, id as number, cmd)
    case 'fs.write': return cmdFsWrite(ws, id as number, cmd)
    case 'fs.mkdir': return cmdFsMkdir(ws, id as number, cmd)
    case 'fs.ls': return cmdFsLs(ws, id as number, cmd)
    case 'fs.find': return cmdFsFind(ws, id as number, cmd)
    case 'fs.stat': return cmdFsStat(ws, id as number, cmd)
    case 'fs.resolvePath': return cmdFsResolvePath(ws, id as number, cmd)
    case 'fs.readRange': return cmdFsReadRange(ws, id as number, cmd)
    case 'git.diff': return cmdGitDiff(ws, id as number, cmd)
    case 'list': return cmdList(ws, id as number)
    case 'sessions.discoverExternal': return cmdDiscoverExternalSessions(ws, id as number, cmd)
    case 'bridge.configure': return cmdBridgeConfigure(ws, id as number, cmd)
    case 'bridgeResume': return cmdBridgeResume(ws, id as number, cmd)
    case 'stt': return cmdSttRelay(ws, id as number, cmd)
    case 'stt-result': return cmdSttResult(ws, id as number, cmd)
    case 'session.launch': return cmdLaunchRelay(ws, id as number, cmd)
    case 'changes.compute': return cmdChangesCompute(ws, id as number, cmd)
    case 'changes.file': return cmdChangesFile(ws, id as number, cmd)
    case 'launch-result': return cmdLaunchResult(ws, id as number, cmd)
    case 'session.control': return cmdControlRelay(ws, id as number, cmd)
    case 'control-result': return cmdControlResult(ws, id as number, cmd)
    case 'session.message': return cmdMessageRelay(ws, id as number, cmd)
    // NOT in BRIDGE_ALLOWED_COMMANDS: only the trusted SSH-tunneled walnut
    // client may answer message relays (same rule as control-result).
    case 'message-result': return cmdMessageResult(ws, id as number, cmd)
    // NOT in BRIDGE_ALLOWED_COMMANDS: reverse direction — the trusted walnut
    // server pushes slim mobile feed events DOWN, the daemon relays them to
    // the cloud bridge (see cmdMobileEvent).
    case 'mobile-event': return cmdMobileEvent(ws, id as number, cmd)
    // NOT in BRIDGE_ALLOWED_COMMANDS: only the trusted SSH-tunneled walnut
    // client may answer agent-gateway relays (see the gateway section).
    case 'gateway-result': return cmdGatewayResult(ws, id as number, cmd)
    case 'acpStart': return cmdAcpStart(ws, id as number, cmd)
    case 'acpSend': return cmdAcpOp(ws, id as number, cmd, 'prompt')
    case 'acpCancel': return cmdAcpOp(ws, id as number, cmd, 'cancel')
    case 'acpRespond': return cmdAcpOp(ws, id as number, cmd, 'permissionResponse')
    case 'acpSetConfigOption': return cmdAcpOp(ws, id as number, cmd, 'setConfigOption')
    case 'acpState': return cmdAcpOp(ws, id as number, cmd, 'getState')
    case 'acpNewSession': return cmdAcpOp(ws, id as number, cmd, 'newSession')
    case 'acpStop': return cmdAcpStop(ws, id as number, cmd)
    case 'acpSubscribe': return cmdAcpSubscribe(ws, id as number, cmd)
    case 'ping': return sendOk(ws, id as number, { pong: true })
    case 'hello': return sendOk(ws, id as number, {
      version: DAEMON_VERSION,
      capabilities: ADVERTISED_DAEMON_CAPABILITIES,
      instanceId: DAEMON_INSTANCE_ID,
      startedAt: DAEMON_START_TS,
      uptimeSec: Math.floor((Date.now() - DAEMON_START_TS) / 1000),
    })
    default: return sendError(ws, id as number, 'unknown command: ' + cmd.cmd)
  }
}

// ── Bridge-safe resume: respawn a dead session with --resume <sid> ──
// Unlike `start` (which takes arbitrary argv from the caller — unsafe over
// the public bridge), `bridgeResume` only accepts {sid, message, cwd?, model?}
// and builds the argv itself: either the registry's stored args (patched to
// --resume this sid) or, when the record is gone (daemon restarted — the
// registry only persists RUNNING sessions), a fixed default `claude --resume`
// command. Gated on the session's jsonl existing in STREAMS_DIR, which proves
// the session genuinely lived on this host — so a compromised cloud box still
// can't run arbitrary commands, only wake conversations that were here.
function cmdBridgeResume(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const { sid, message, cwd: cwdHint, model } = cmd as {
    sid: string; message: string; cwd?: string; model?: string
  }
  if (!sid || !message) {
    return sendError(ws, id, 'bridgeResume: missing sid or message')
  }

  const session = sessions.get(sid)

  if (session && session.state === 'running') {
    // Already alive — just send the message directly.
    return cmdSend(ws, id, { cmd: 'send', sid, message })
  }

  // The jsonl is the proof-of-residence: without it this sid never ran here.
  const jsonlPath = path.join(STREAMS_DIR, sid + '.jsonl')
  if (!fs.existsSync(jsonlPath)) {
    return sendError(ws, id, 'bridgeResume: session not found: ' + sid)
  }

  // cwd: registry record → caller's projection hint. --resume only finds the
  // conversation when the cwd matches the original, so a wrong hint just
  // yields a "No conversation found" turn error, not a security problem.
  const cwd = (session?.cwd && session.cwd !== '') ? session.cwd : cwdHint
  if (!cwd) {
    return sendError(ws, id, 'bridgeResume: no cwd known for session (record lost, no hint)')
  }

  // argv: stored args when the record survived; otherwise the standard
  // resume command (mirrors the Mac's spawn-time construction).
  let args: string[]
  if (session?.args && session.args.length > 0) {
    // Ensure --resume <sid>: fresh-start args lack it (replaying them
    // verbatim would spawn a NEW conversation); stale values get rewritten.
    args = [...session.args]
    // Bypass CAPABILITY only. The bare --dangerously-skip-permissions also
    // SELECTS bypass and outranks --permission-mode, so injecting it here would
    // silently resume a plan/accept/default session in full-trust bypass.
    if (!args.includes('--allow-dangerously-skip-permissions')) {
      args.splice(1, 0, '--allow-dangerously-skip-permissions')
    }
    const bare = args.indexOf('--dangerously-skip-permissions')
    if (bare >= 0) args.splice(bare, 1)
    const ri = args.indexOf('--resume')
    if (ri >= 0 && ri + 1 < args.length) {
      args[ri + 1] = sid
    } else {
      args.push('--resume', sid)
    }
  } else {
    args = [
      'claude', '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--debug',
      '--allow-dangerously-skip-permissions',
      '--permission-mode', session?.mode ? MODE_CLI[session.mode] || 'default' : 'default',
      ...(model ? ['--model', model] : []),
      '--resume', sid,
      '--input-format', 'stream-json',
      '--permission-prompt-tool', 'stdio',
    ]
  }

  logMsg('info', 'bridgeResume: respawning dead session', {
    sid, cwd, recordLost: !session || !session.args || session.args.length === 0,
  })
  // cmdStart is async (FIFO write continuation) — return the promise so the
  // dispatcher's rejection handler owns any throw.
  return cmdStart(ws, id, {
    cmd: 'start',
    sid,
    args,
    cwd,
    message,
    resume: true,
    mode: session?.mode ?? 'default',
  })
}

// ── STT relay: bridge audio → the connected walnut server's local engine ──
// The daemon has no transcription engine of its own. A bridge `stt` request
// is relayed as an `stt-request` event to a TRUSTED (non-bridge) client — the
// walnut server holding this daemon's WS — which runs its configured engine
// and answers with an `stt-result` command carrying the same relayId. No
// trusted client connected (Mac down) → fail fast so the cloud box falls back
// to its own OpenAI path. Audio payloads are never logged.

const STT_RELAY_TIMEOUT_MS = 90_000
let sttRelayCounter = 0
const sttRelayPending = new Map<number, {
  ws: ServerWebSocket<WsData>; id: number; timer: ReturnType<typeof setTimeout>
}>()

function cmdSttRelay(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const { audio, format, language } = cmd as { audio?: string; format?: string; language?: string }
  if (!audio || !format) {
    return sendError(ws, id, 'stt: missing audio or format')
  }
  // Pick any trusted client (never the bridge adapter — that would bounce the
  // request straight back to the cloud). Normally there is exactly one: the
  // walnut server's DaemonConnection.
  let target: ServerWebSocket<WsData> | null = null
  for (const client of wsClients) {
    if (client.data?.origin !== 'bridge') { target = client; break }
  }
  if (!target) {
    return sendError(ws, id, 'stt: no transcription host connected')
  }
  const relayId = ++sttRelayCounter
  const timer = setTimeout(() => {
    sttRelayPending.delete(relayId)
    sendError(ws, id, 'stt: transcription timed out')
  }, STT_RELAY_TIMEOUT_MS)
  sttRelayPending.set(relayId, { ws, id, timer })
  logMsg('info', 'stt: relaying to transcription host', { relayId, format, audioB64Len: audio.length })
  sendEvent(target, 'stt-request', { relayId, audio, format, language })
}

function cmdSttResult(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const { relayId, text, durationMs, error } = cmd as {
    relayId?: number; text?: string; durationMs?: number; error?: string
  }
  const pending = typeof relayId === 'number' ? sttRelayPending.get(relayId) : undefined
  if (!pending) {
    // Late result after timeout — ack and drop.
    return sendOk(ws, id, { stale: true })
  }
  sttRelayPending.delete(relayId as number)
  clearTimeout(pending.timer)
  if (typeof text === 'string' && !error) {
    logMsg('info', 'stt: relay complete', { relayId, chars: text.length, durationMs })
    sendOk(pending.ws, pending.id, { text, durationMs: durationMs ?? 0 })
  } else {
    sendError(pending.ws, pending.id, 'stt: ' + (error ?? 'transcription failed'))
  }
  sendOk(ws, id, {})
}

// ── Launch relay: bridge session-create request → the connected walnut server ──
// The daemon has no session-record store — records live on the walnut server
// (session-tracker), and quickStartSession is the only correct creation core.
// A bridge `session.launch` request is relayed as a `launch-request` event to
// a TRUSTED (non-bridge) client — the walnut server holding this daemon's WS
// — which validates + creates and answers with a `launch-result` command
// carrying the same relayId. The daemon spawns NOTHING here; a compromised
// cloud box gets exactly one verb: "ask the primary to run its own launch
// validation". No trusted client (walnut server down) → fail fast.

const LAUNCH_RELAY_TIMEOUT_MS = 45_000
let launchRelayCounter = 0
const launchRelayPending = new Map<number, {
  ws: ServerWebSocket<WsData>; id: number; timer: ReturnType<typeof setTimeout>
}>()

function cmdLaunchRelay(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const { action, params } = cmd as { action?: string; params?: Record<string, unknown> }
  if (!action) {
    return sendError(ws, id, 'session.launch: missing action')
  }
  // Pick any trusted client (never the bridge adapter — that would bounce the
  // request straight back to the cloud). Normally there is exactly one: the
  // walnut server's DaemonConnection.
  let target: ServerWebSocket<WsData> | null = null
  for (const client of wsClients) {
    if (client.data?.origin !== 'bridge') { target = client; break }
  }
  if (!target) {
    return sendError(ws, id, 'session.launch: no primary server connected')
  }
  const relayId = ++launchRelayCounter
  const timer = setTimeout(() => {
    launchRelayPending.delete(relayId)
    sendError(ws, id, 'session.launch: primary server timed out')
  }, LAUNCH_RELAY_TIMEOUT_MS)
  launchRelayPending.set(relayId, { ws, id, timer })
  logMsg('info', 'session.launch: relaying to primary server', { relayId, action })
  sendEvent(target, 'launch-request', { relayId, action, params: params ?? {} })
}

function cmdLaunchResult(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const { relayId, result, error, errorKind } = cmd as {
    relayId?: number; result?: Record<string, unknown>; error?: string; errorKind?: string
  }
  const pending = typeof relayId === 'number' ? launchRelayPending.get(relayId) : undefined
  if (!pending) {
    // Late result after timeout — ack and drop.
    return sendOk(ws, id, { stale: true })
  }
  launchRelayPending.delete(relayId as number)
  clearTimeout(pending.timer)
  if (result && !error) {
    logMsg('info', 'session.launch: relay complete', { relayId })
    sendOk(pending.ws, pending.id, { result })
  } else {
    // Carry errorKind through so the cloud route maps the precise 4xx.
    safeSend(pending.ws, JSON.stringify({
      id: pending.id, ok: false,
      error: error ?? 'launch failed',
      errorKind: errorKind ?? 'internal',
    }))
  }
  sendOk(ws, id, {})
}

// ── Control relay: bridge session-control request → the connected walnut server ──
// Mirror of the launch relay above (same trusted-client pick, same timeout
// map, same errorKind passthrough) for model/effort/fork/model-options. The
// daemon executes NOTHING here — the walnut server re-validates and runs the
// shared session-controls core, answering with a `control-result` command
// carrying the same relayId. Keep in sync with daemon-source.ts.

const CONTROL_RELAY_TIMEOUT_MS = 45_000
let controlRelayCounter = 0
const controlRelayPending = new Map<number, {
  ws: ServerWebSocket<WsData>; id: number; timer: ReturnType<typeof setTimeout>
}>()

function cmdControlRelay(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const { action, sid, sessionId, params } = cmd as {
    action?: string; sid?: string; sessionId?: string; params?: Record<string, unknown>
  }
  if (!action) {
    return sendError(ws, id, 'session.control: missing action')
  }
  const targetSid = sessionId ?? sid
  if (!targetSid) {
    return sendError(ws, id, 'session.control: missing sessionId')
  }
  // Pick any trusted client (never the bridge adapter — that would bounce the
  // request straight back to the cloud). Normally there is exactly one: the
  // walnut server's DaemonConnection.
  let target: ServerWebSocket<WsData> | null = null
  for (const client of wsClients) {
    if (client.data?.origin !== 'bridge') { target = client; break }
  }
  if (!target) {
    return sendError(ws, id, 'session.control: no primary server connected')
  }
  const relayId = ++controlRelayCounter
  const timer = setTimeout(() => {
    controlRelayPending.delete(relayId)
    sendError(ws, id, 'session.control: primary server timed out')
  }, CONTROL_RELAY_TIMEOUT_MS)
  controlRelayPending.set(relayId, { ws, id, timer })
  logMsg('info', 'session.control: relaying to primary server', { relayId, action, sid: targetSid })
  sendEvent(target, 'control-request', { relayId, action, sessionId: targetSid, params: params ?? {} })
}

function cmdControlResult(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const { relayId, result, error, errorKind, errorCode } = cmd as {
    relayId?: number; result?: Record<string, unknown>; error?: string; errorKind?: string; errorCode?: string
  }
  const pending = typeof relayId === 'number' ? controlRelayPending.get(relayId) : undefined
  if (!pending) {
    // Late result after timeout — ack and drop.
    return sendOk(ws, id, { stale: true })
  }
  controlRelayPending.delete(relayId as number)
  clearTimeout(pending.timer)
  if (result && !error) {
    logMsg('info', 'session.control: relay complete', { relayId })
    sendOk(pending.ws, pending.id, { result })
  } else {
    // Carry errorKind/errorCode through so the cloud route maps the precise 4xx.
    safeSend(pending.ws, JSON.stringify({
      id: pending.id, ok: false,
      error: error ?? 'control failed',
      errorKind: errorKind ?? 'internal',
      ...(errorCode ? { errorCode } : {}),
    }))
  }
  sendOk(ws, id, {})
}

// ── Message relay: bridge phone send → the connected walnut server's durable queue ──
// Mirror of the control relay above (same trusted-client pick, same timeout
// map, same errorKind passthrough). The daemon writes NOTHING itself — the
// walnut server enqueues the message into the SAME durable queue web sends
// use (sendMessageToSession), so a daemon/CLI death anywhere after the
// enqueue converts to delayed redelivery instead of loss (the 2026-08-13
// phone-send data-loss family). messageId (qm-mobile-*) rides through for
// end-to-end idempotence. Keep in sync with daemon-source.ts.

const MESSAGE_RELAY_TIMEOUT_MS = 45_000
let messageRelayCounter = 0
const messageRelayPending = new Map<number, {
  ws: ServerWebSocket<WsData>; id: number; timer: ReturnType<typeof setTimeout>
}>()

function cmdMessageRelay(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const { sid, sessionId, message, messageId } = cmd as {
    sid?: string; sessionId?: string; message?: string; messageId?: string
  }
  const targetSid = sessionId ?? sid
  if (!targetSid || typeof message !== 'string' || message === '' || !messageId) {
    return sendError(ws, id, 'session.message: missing sessionId, message, or messageId')
  }
  // Pick any trusted client (never the bridge adapter — that would bounce the
  // request straight back to the cloud). Normally there is exactly one: the
  // walnut server's DaemonConnection.
  let target: ServerWebSocket<WsData> | null = null
  for (const client of wsClients) {
    if (client.data?.origin !== 'bridge') { target = client; break }
  }
  if (!target) {
    return sendError(ws, id, 'session.message: no primary server connected')
  }
  const relayId = ++messageRelayCounter
  const timer = setTimeout(() => {
    messageRelayPending.delete(relayId)
    sendError(ws, id, 'session.message: primary server timed out')
  }, MESSAGE_RELAY_TIMEOUT_MS)
  messageRelayPending.set(relayId, { ws, id, timer })
  logMsg('info', 'session.message: relaying to primary server', { relayId, sid: targetSid, messageId })
  sendEvent(target, 'message-request', { relayId, sessionId: targetSid, message, messageId })
}

function cmdMessageResult(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const { relayId, result, error, errorKind } = cmd as {
    relayId?: number; result?: Record<string, unknown>; error?: string; errorKind?: string
  }
  const pending = typeof relayId === 'number' ? messageRelayPending.get(relayId) : undefined
  if (!pending) {
    // Late result after timeout — ack and drop.
    return sendOk(ws, id, { stale: true })
  }
  messageRelayPending.delete(relayId as number)
  clearTimeout(pending.timer)
  if (result && !error) {
    logMsg('info', 'session.message: relay complete', { relayId })
    sendOk(pending.ws, pending.id, { result })
  } else {
    // Carry errorKind through so the cloud route maps the precise 4xx/503.
    safeSend(pending.ws, JSON.stringify({
      id: pending.id, ok: false,
      error: error ?? 'message enqueue failed',
      errorKind: errorKind ?? 'internal',
    }))
  }
  sendOk(ws, id, {})
}

// ── Mobile events relay: walnut server → cloud bridge (reverse direction) ──
// The primary's mobile events feed (src/web/routes/events-v1.ts) pushes slim
// `{kind, data}` frames here; the daemon forwards them verbatim to the cloud
// bridge as `{ev:'mobile-event', ...}` so phones connected to the cloud box
// get the same live feed. Fire-and-forget: no bridge = ack-and-drop (the
// phone's snapshot frame on reconnect heals the gap). Trusted clients only —
// this case is deliberately NOT in BRIDGE_ALLOWED_COMMANDS (a compromised
// cloud box must not be able to inject fake feed events back at itself, and
// the direction is walnut → daemon → bridge, never bridge → daemon).
// Keep in sync with daemon-source.ts.

function cmdMobileEvent(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const { kind, data } = cmd as { kind?: string; data?: unknown }
  if (typeof kind !== 'string' || !kind) {
    return sendError(ws, id, 'mobile-event: missing kind')
  }
  if (!bridgeAdapter) {
    return sendOk(ws, id, { relayed: false })
  }
  safeSend(bridgeAdapter, JSON.stringify({ ev: 'mobile-event', kind, data: data ?? null }))
  sendOk(ws, id, { relayed: true })
}

// ── Agent gateway: on-host unix socket → Mac hub relay ──
// A `wn` CLI inside a Walnut-spawned claude session writes one NDJSON request
// line to ${DAEMON_DIR}/agent-gateway.sock; the daemon resolves the caller's
// CURRENT sid (env sid is only a lookup key — fresh spawns use a tmp sid that
// cmdRename re-keys) and relays the request to the Mac hub with the same
// reverse-RPC shape as cmdLaunchRelay/cmdLaunchResult: relayId + pending map +
// `gateway-request` event answered by a `gateway-result` command. Shared pure
// logic (parse/validate/alias resolution) lives in gateway-core.ts.
// Keep in sync with daemon-source.ts gateway section (hand-inlined there).

const GATEWAY_SOCK_PATH = path.join(DAEMON_DIR, GATEWAY_SOCKET_FILENAME)
const GATEWAY_SHIM_DIR = path.join(DAEMON_DIR, 'bin')
const GATEWAY_SHIM_PATH = path.join(GATEWAY_SHIM_DIR, 'wn')

// oldSid → newSid, maintained by cmdRename. resolveCallerSid follows the
// chain (max 5 hops) to map a CLI's spawn-time WALNUT_SESSION_ID to the sid
// the daemon currently tracks.
const gatewaySidAliases = new Map<string, string>()

let gatewayRelayCounter = 0
const gatewayRelayPending = new Map<number, {
  respond: (resp: GatewayResponse) => void; timer: ReturnType<typeof setTimeout>
}>()

function gatewayError(code: GatewayErrorCode, message: string): GatewayResponse {
  return { ok: false, error: { code, message } }
}

function sendGatewayRequest(
  capability: string,
  callerSid: string,
  payload: Record<string, unknown>,
  respond: (resp: GatewayResponse) => void,
) {
  // Pick any trusted client (never the bridge adapter) — same rule as
  // cmdLaunchRelay: normally exactly one, the walnut server's DaemonConnection.
  let target: ServerWebSocket<WsData> | null = null
  for (const client of wsClients) {
    if (client.data?.origin !== 'bridge') { target = client; break }
  }
  if (!target) {
    return respond(gatewayError('hub_unreachable', 'no primary server connected'))
  }
  const relayId = ++gatewayRelayCounter
  const timer = setTimeout(() => {
    gatewayRelayPending.delete(relayId)
    respond(gatewayError('hub_timeout', 'primary server timed out'))
  }, gatewayHubTimeoutMs())
  gatewayRelayPending.set(relayId, { respond, timer })
  logMsg('info', 'gateway: relaying to primary server', { relayId, capability, callerSid })
  sendEvent(target, 'gateway-request', { relayId, capability, callerSid, payload })
}

// `gateway-result` is deliberately NOT in BRIDGE_ALLOWED_COMMANDS — only a
// trusted (SSH-tunneled) walnut client may answer a gateway relay.
function cmdGatewayResult(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const { relayId, result, error, errorCode, detail } = cmd as {
    relayId?: number; result?: Record<string, unknown>; error?: string
    errorCode?: string; detail?: unknown
  }
  const pending = typeof relayId === 'number' ? gatewayRelayPending.get(relayId) : undefined
  if (!pending) {
    // Late result after timeout — ack and drop (same as cmdLaunchResult).
    return sendOk(ws, id, { stale: true })
  }
  gatewayRelayPending.delete(relayId as number)
  clearTimeout(pending.timer)
  if (result && !error) {
    pending.respond({ ok: true, result })
  } else {
    const errObj: GatewayResponse & { ok: false } = {
      ok: false,
      error: {
        code: (errorCode as GatewayErrorCode) || 'internal',
        message: error || 'gateway request failed',
      },
    }
    if (detail !== undefined) {
      errObj.error.detail = detail
      const ra = (detail as { retryAfterMs?: unknown } | null)?.retryAfterMs
      if (typeof ra === 'number') errObj.error.retryAfterMs = ra
    }
    pending.respond(errObj)
  }
  sendOk(ws, id, {})
}

/** One parsed NDJSON line from the agent socket → local reject or hub relay. */
function handleGatewayLine(line: string, respond: (resp: GatewayResponse) => void) {
  const parsed = parseGatewayLine(line)
  if (!parsed.ok) return respond({ ok: false, error: parsed.error })
  const req = parsed.request
  const callerSid = resolveCallerSid(req.sid, sessions, gatewaySidAliases)
  if (!callerSid) {
    // Unknown sid (CLI adopted from before a daemon restart) — refuse locally,
    // the request never leaves this host. A respawn self-heals (plan §5).
    return respond(gatewayError('unknown_caller', 'session is not tracked by this daemon (a respawn self-heals)'))
  }
  sendGatewayRequest(req.op, callerSid, req.args, respond)
}

/** Second listener: owner-only unix socket, raw NDJSON, one request per conn. */
function startGatewayListener() {
  // Unlink a stale socket from a crashed predecessor — bind fails on EADDRINUSE
  // otherwise (the file outlives the process).
  try { fs.unlinkSync(GATEWAY_SOCK_PATH) } catch {}
  try {
    type GwSockData = { buf: string; done: boolean }
    const reply = (socket: { write(s: string): number; end(): void }, resp: GatewayResponse) => {
      try { socket.write(JSON.stringify(resp) + '\n') } catch {}
      try { socket.end() } catch {}
    }
    Bun.listen<GwSockData>({
      unix: GATEWAY_SOCK_PATH,
      socket: {
        open(socket) { socket.data = { buf: '', done: false } },
        data(socket, chunk) {
          const d = socket.data
          if (d.done) return
          d.buf += chunk.toString('utf-8')
          if (Buffer.byteLength(d.buf, 'utf8') > GATEWAY_MAX_LINE_BYTES) {
            d.done = true
            reply(socket, gatewayError('bad_request', 'request line too large'))
            return
          }
          const nl = d.buf.indexOf('\n')
          if (nl === -1) return
          d.done = true
          handleGatewayLine(d.buf.slice(0, nl), (resp) => reply(socket, resp))
        },
        error() { /* client went away — pending timer self-cleans */ },
      },
    })
    // Owner-only IS the credential: don't rely on umask, chmod explicitly.
    fs.chmodSync(GATEWAY_SOCK_PATH, 0o600)
    logMsg('info', 'agent gateway listening', { sock: GATEWAY_SOCK_PATH })
  } catch (err) {
    // The gateway is additive — never fail daemon startup over it.
    logMsg('warn', 'agent gateway listener failed', { error: (err as Error).message })
  }
}

/** PATH shim so `wn` inside spawned sessions reaches this daemon's wn dispatch. */
function writeWnShim() {
  try {
    fs.mkdirSync(GATEWAY_SHIM_DIR, { recursive: true, mode: 0o700 })
    // Compiled binary: argv[1] is a bunfs VIRTUAL path (embedded, must never
    // leak into the shim) → exec the binary itself, argv[2]='wn'. Dev run
    // (`bun daemon-standalone.ts`): argv[1] is the real script on disk → keep
    // it so the shim reaches the same code.
    const entry = process.argv[1] || ''
    const isVirtualEntry = entry.includes('$bunfs') || entry.includes('~BUN')
    const script = entry && !isVirtualEntry && entry !== process.execPath && fs.existsSync(entry)
      ? ' ' + shellQuote(entry)
      : ''
    const shim = '#!/bin/sh\nexec ' + shellQuote(process.execPath) + script + ' wn "$@"\n'
    fs.writeFileSync(GATEWAY_SHIM_PATH, shim, { mode: 0o755 })
    fs.chmodSync(GATEWAY_SHIM_PATH, 0o755)
  } catch (err) {
    logMsg('warn', 'wn shim write failed', { error: (err as Error).message })
  }
}

// ── ACP session commands (engine=codex etc; see acp-daemon.ts) ──
// sid here is the Walnut runtimeId; journal = STREAMS_DIR/<sid>.acp.jsonl.

function cmdAcpStart(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const params = cmd as unknown as AcpStartParams
  if (!params.sid || !params.cwd) return sendError(ws, id, 'acpStart: missing sid/cwd')
  void acp.acpStart(ws, params).then((resp) => {
    if (resp.ok) sendOk(ws, id, resp.result ?? {})
    else safeSend(ws, JSON.stringify({ id, ok: false, error: resp.error, errorKind: resp.errorKind }))
  })
}

function cmdAcpOp(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>, op: string) {
  const { sid, ...params } = cmd as { sid?: string; cmd?: string }
  if (!sid) return sendError(ws, id, op + ': missing sid')
  delete (params as Record<string, unknown>).cmd
  delete (params as Record<string, unknown>).id
  delete (params as Record<string, unknown>).traceId
  void acp.acpOp(sid, op, params as Record<string, unknown>).then((resp) => {
    if (resp.ok) sendOk(ws, id, { result: resp.result })
    else safeSend(ws, JSON.stringify({ id, ok: false, error: resp.error?.message ?? 'acp op failed', errorKind: resp.error?.kind }))
  })
}

function cmdAcpStop(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const { sid } = cmd as { sid?: string }
  if (!sid) return sendError(ws, id, 'acpStop: missing sid')
  void acp.acpStop(sid).then(() => sendOk(ws, id, { stopped: true }))
}

function cmdAcpSubscribe(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const { sid, fromOffset } = cmd as { sid?: string; fromOffset?: number }
  if (!sid) return sendError(ws, id, 'acpSubscribe: missing sid')
  const ok = acp.subscribe(ws, sid, typeof fromOffset === 'number' ? fromOffset : 0)
  if (ok) sendOk(ws, id, { subscribed: true })
  else safeSend(ws, JSON.stringify({ id, ok: false, error: 'no live ACP worker for ' + sid, errorKind: 'no_worker' }))
}

// ── Start a Claude session ──
async function cmdStart(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const { sid, args, cwd, message, resume, mode } = cmd as {
    sid: string; args: string[]; cwd: string; message?: string; resume?: boolean; mode?: string
  }
  // `message` is OPTIONAL: an empty/absent message spawns the CLI without writing
  // any user turn to the FIFO — the process emits `init` (+ SessionStart hook, fresh
  // settings/skills/MCP load) then blocks on stdin, idle. This is the "restart to
  // re-initialize, don't run a turn" path (POST /restart with an empty queue). A
  // present message keeps the classic behavior (spawn + deliver the first turn).
  if (!sid || !args || !cwd) {
    return sendError(ws, id, 'start: missing required fields (sid, args, cwd)')
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
    // Live-adopt guard: a resume-with-message against a STILL-RUNNING CLI means
    // the caller lost track of the process (walnut restart race, stale hasPipe),
    // not that the process needs replacing. Killing it here aborts whatever the
    // CLI is doing mid-turn (observed: a 369K-token compaction). Deliver the
    // message to the live FIFO and adopt instead — exactly what cmdSend would
    // have done had the caller known the process was alive. An explicit restart
    // (reinitialize) sends message='' and still takes the respawn path below.
    if (resume && message && existing.state === 'running' && existing.pid) {
      let oldAlive = false
      try { process.kill(existing.pid, 0); oldAlive = true } catch {}
      if (oldAlive) {
        const sendResult = await core.handleSendCommand(sid, message)
        if (sendResult.ok) {
          if (mode) existing.mode = mode as SessionMode
          // Hand out a COMPLETE-line boundary, never a raw stat().size: this
          // value becomes the client's cursor AND addSubscriber's replay start,
          // and a mid-line start fans a JSON fragment to the client (contract §4
          // boundary rule). The live watcher already publishes the boundary.
          const curSize = existing.watcher ? existing.watcher.offset : statSizeOrZero(existing.jsonlPath)
          logMsg('info', 'cmdStart: adopted live session — message delivered via FIFO, respawn skipped', {
            sid, pid: existing.pid, offset: curSize,
          })
          addSubscriber(ws, sid, curSize)
          return sendOk(ws, id, { pid: existing.pid, outputFile: existing.jsonlPath, offset: curSize, adopted: true })
        }
        // Delivery failed. Only fall through to respawn if handleSendCommand
        // actually reaped the session (ENXIO / precheck-dead / partial-write).
        // A transient EAGAIN (pipe full, process alive) must NOT kill the CLI —
        // fail the start; the message stays queued and the caller retries.
        const afterSend = sessions.get(sid)
        if (afterSend && afterSend.state === 'running') {
          logMsg('warn', 'cmdStart: live-adopt delivery failed but process alive — refusing respawn', {
            sid, pid: existing.pid, reason: sendResult.reason ?? sendResult.error,
          })
          return sendError(ws, id, `start: session ${sid} is alive but FIFO delivery failed (${sendResult.reason ?? sendResult.error}); retry send`)
        }
        logMsg('warn', 'cmdStart: live-adopt delivery failed — falling back to respawn', {
          sid, reason: sendResult.reason ?? sendResult.error,
        })
      }
    }
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
        killProcessGroup(existing.pid, 'SIGTERM')
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

  // Record offset before spawn (for resume — only stream new data).
  // C1: on resume the fold is rebuilt from the surviving jsonl, and the watcher
  // offset comes from THAT rebuild's complete-line boundary — never a raw
  // stat().size, which can sit mid-line if the previous CLI died mid-write
  // (contract §4 "Rebuild boundary rule").
  let offset = 0
  let resumeFold: FoldRebuild | null = null
  if (resume) {
    resumeFold = rebuildFoldStateFromJsonl(jsonlPath)
    offset = resumeFold.boundary
  }

  // Create FIFO
  try { fs.unlinkSync(pipePath) } catch {}
  try { execSync('mkfifo ' + JSON.stringify(pipePath)) } catch (err: unknown) {
    return sendError(ws, id, 'mkfifo failed: ' + (err as Error).message)
  }

  // Open files. The CLI's stdout fd MUST be O_APPEND ('a'): the daemon also
  // appends turn-start marker lines (appendUserMarker) to this file, and a
  // positional 'w' fd would overwrite them on the CLI's next write. With both
  // writers in O_APPEND every write() lands at the true EOF. Fresh spawns
  // truncate explicitly first ('a' alone never truncates).
  const pipeFd = fs.openSync(pipePath, fs.constants.O_RDWR)
  // Fresh spawn: unlink+recreate (NOT truncate-in-place) so the file gets a NEW
  // inode → new streamEpoch. Truncation keeps the inode, and a same-sid relaunch
  // would then reset v to 0 under an UNCHANGED epoch — walnut's stale watermark
  // from the previous incarnation would veto every snapshot (the 019a7fe5 class).
  if (!resume) {
    try { fs.unlinkSync(jsonlPath) } catch {}
    try { fs.writeFileSync(jsonlPath, '') } catch {}
  }
  const outputFd = fs.openSync(jsonlPath, 'a')
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
  // CLAUDE_CODE_MAX_RETRIES: harden against upstream Bedrock degradation windows.
  // Forensics found degradation windows of 10-103 min; the CLI's default 10 API
  // retries only cover a ~3min budget, so a turn dies with "Request timed out"
  // mid-outage. The persistent-retry env (CLAUDE_CODE_UNATTENDED_RETRY) is compiled
  // OUT of external CLI builds, so we raise the finite retry ceiling instead.
  // Retries past 10 back off ~35s each, so 60 covers roughly a 30-min outage.
  // Precedence: respect an explicit process-env override; else WALNUT_CLI_MAX_RETRIES;
  // else default '60'. Keep in sync with daemon-source.ts.
  const cliMaxRetries =
    process.env.CLAUDE_CODE_MAX_RETRIES ?? process.env.WALNUT_CLI_MAX_RETRIES ?? '60'
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
      CLAUDE_CODE_MAX_RETRIES: cliMaxRetries,
      // Agent gateway (peer sessions): the `wn` CLI inside this session reads
      // these two to reach the on-host gateway socket. The sid may be a fresh
      // spawn's tmp id — gatewaySidAliases (cmdRename) resolves it to the
      // current sid on every request. Keep in sync with daemon-source.ts.
      WALNUT_AGENT_SOCKET: GATEWAY_SOCK_PATH,
      WALNUT_SESSION_ID: sid,
      // Never let OUR watchdog pid leak into the CLI's env. A CLI session that
      // runs `npm run dev:prod` would otherwise hand this stale pid to the
      // PRODUCTION daemon, whose watchdog would trip on the long-dead pid and
      // (with the isolated-dir reap) kill live prod sessions. Same env-carrier
      // chain as the VITEST_* leak. Keep in sync with daemon-source.ts.
      WALNUT_DAEMON_PARENT_PID: undefined,
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

  // Write initial message to FIFO — only when one was provided. An empty message
  // means "spawn idle" (restart-to-reinitialize): the CLI still opens stdin and
  // emits its init event, but runs no turn. We keep the pipeFd open across the
  // O_RDWR lifetime like the send path, so the FIFO survives until the first real
  // message; closing it here (as the message path does after writing) is fine
  // because the CLI already holds its own read end.
  if (message) {
    const payload = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: message },
    })
    fs.writeSync(pipeFd, Buffer.from(payload + '\n'))
  }
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
    // C1: fresh spawn starts an empty fold; resume streams the surviving jsonl.
    foldState: resumeFold ? resumeFold.state : initialFoldState(0),
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
// ── Scheduled-task (CLI cron) fire detection ──
// A cron fire in headless mode delivers its prompt STRAIGHT to the model —
// nothing appears in the stream-json stdout except a bare turn start
// (session_state_changed{running} + init), so neither the Mac nor the UI can
// see it happened. The daemon is the only component with the cwd + the files,
// so it checks {cwd}/.claude/scheduled_tasks.json on turn-start lines
// (30s-throttled) and, when a recently-fired task was created by a DIFFERENT
// session (directory-scoped lock adoption — upstream #50300/#66509):
//   1. appends a scheduled_task_fire system marker to the stream file
//      (history + live UI render it), and
//   2. injects a provenance warning into the FIFO so the MODEL knows the
//      prompt is an adopted cron, not the human.
// Same-session fires get only the marker (normal /loop operation).
const CRON_CHECK_THROTTLE_MS = 30_000

// ── OPT-IN policy: session-scoped crons only ──
// Full rationale + the experiment that established it: daemon-core.ts, the
// block above isDurableCronRequest. OFF by default for the public build —
// denying tool calls, injecting corrective messages, and rewriting
// .claude/scheduled_tasks.json on death are opinionated interventions a
// generic user did not ask for. Walnut sets WALNUT_ENFORCE_SESSION_CRON=1
// at daemon spawn when config `session.cron_policy: 'session-only'`.
// (WALNUT_ALLOW_DURABLE_CRON=1 is honored as an override for back-compat
// with daemons already deployed with the old default.)
const ALLOW_DURABLE_CRON = process.env.WALNUT_ENFORCE_SESSION_CRON !== '1'
  || process.env.WALNUT_ALLOW_DURABLE_CRON === '1'

// Enforcement point 2 (corrective): a bypassPermissions session never emits a
// can_use_tool control_request, so the deny in the permission intercept can't
// fire — the durable job is already on disk by the time we see the tool_use
// echo. Tell the model to swap it for a session-scoped one. Once per tool_use
// id so a re-read of the same line can't nag in a loop; `durableCronNudged` is
// in-memory only (a respawn re-nudges, which is correct — the durable task is
// still on disk). The FIFO write lands as queued stdin, so the model reads it
// after the current turn, exactly like the foreign-fire provenance warning.
function checkDurableCronCreate(sid: string, session: SessionData, line: string) {
  if (ALLOW_DURABLE_CRON) return
  let parsed: Record<string, unknown>
  try { parsed = JSON.parse(line) as Record<string, unknown> } catch { return }
  if (parsed.type !== 'assistant') return
  const content = (parsed.message as { content?: unknown })?.content
  if (!Array.isArray(content)) return
  for (const block of content as Array<Record<string, unknown>>) {
    if (block?.type !== 'tool_use') continue
    if (!isDurableCronRequest(block.name as string | undefined, block.input)) continue
    const key = String(block.id ?? 'unknown')
    if (!session.durableCronNudged) session.durableCronNudged = {}
    if (session.durableCronNudged[key]) continue
    session.durableCronNudged[key] = Date.now()
    // Task id isn't in the tool_use (the CLI mints it) — the model knows it
    // from its own tool_result, so the message asks it to delete "that task id".
    const payload = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: durableCronCorrectionMessage(undefined) },
    })
    const ok = writeFifoRaw(session.pipePath, payload)
    logMsg(ok ? 'warn' : 'error',
      'durable CronCreate observed in stream — correction ' + (ok ? 'injected' : 'FIFO write FAILED'),
      { sid, toolUseId: key, mode: session.mode })
  }
}
// ── Turn-error auto-retry (policy in daemon-core: decideTurnRetry) ──
//
// Read ONCE at boot: the Mac sets these in the daemon spawn env from user
// config, so a config change takes effect on the next daemon restart (same
// contract as WALNUT_ENFORCE_SESSION_CRON — see DAEMON_RESTART_NOTE).
const TURN_RETRY_CFG = resolveTurnRetryConfig(process.env)

/**
 * A turn ended with is_error. Decide whether to resume it, and if so schedule
 * the resume after a backoff.
 *
 * Called from the tailer on every `result` line. Two jobs:
 *   - a CLEAN result clears the failure streak (so the 12h budget bounds ONE
 *     outage, not the session's lifetime), and
 *   - an ERROR result runs the policy and either schedules a resume or writes a
 *     "gave up" marker for the human.
 *
 * The retry is delivered as a normal FIFO user message when the CLI is still
 * alive, and as a --resume respawn when it died — reusing the exact paths a
 * human "continue" would take, so no delivery invariant is special-cased.
 */
function checkTurnRetry(sid: string, session: SessionData, line: string, v: number) {
  if (!TURN_RETRY_CFG.enabled) return
  const { isTurnError, text } = parseTurnErrorLine(line)

  if (!isTurnError) {
    // Clean turn-over → the streak is over. Only persist when something changed.
    if (line.includes('"type":"result"') && session.turnRetry) {
      if (clearTurnRetryStreak(session.turnRetry)) {
        logMsg('info', 'turn-retry streak cleared by a successful turn', { sid })
        persistRegistry()
      }
    }
    return
  }

  if (!session.turnRetry) session.turnRetry = newTurnRetryState()
  const now = Date.now()
  const decision = decideTurnRetry({ errorText: text, state: session.turnRetry, cfg: TURN_RETRY_CFG, nowMs: now, v })

  if (!decision.retry) {
    if (decision.reason === 'duplicate-line') return
    logMsg('warn', 'turn-retry declined', {
      sid, reason: decision.reason, errorText: text,
      attempts: session.turnRetry.attempts,
    })
    // Only tell the human when we actually STOPPED a retry cycle we had begun,
    // or when the error was retryable-looking but out of budget. A plain
    // terminal error on a session that never retried needs no extra row: the
    // CLI's own error is already in the timeline.
    if (decision.reason !== 'terminal' || session.turnRetry.attempts > 0) {
      appendSystemMarker(sid, session, 'turn_retry_stopped', turnRetryGiveUpText(decision.reason, text))
    }
    return
  }

  applyTurnRetry(session.turnRetry, now, v)
  persistRegistry()
  logMsg('warn', 'turn-retry scheduled', {
    sid, attempt: decision.attempt, delayMs: decision.delayMs,
    elapsedMs: decision.elapsedMs, budgetMs: TURN_RETRY_CFG.budgetMs, errorText: text,
  })
  appendSystemMarker(sid, session, 'turn_retry', turnRetryMarkerText({
    attempt: decision.attempt, delayMs: decision.delayMs, errorText: text,
    budgetMs: TURN_RETRY_CFG.budgetMs, elapsedMs: decision.elapsedMs,
  }))

  // Replace any pending timer — the newest failure owns the schedule.
  if (session.turnRetryTimer) { clearTimeout(session.turnRetryTimer); session.turnRetryTimer = null }
  const attempt = decision.attempt
  session.turnRetryTimer = setTimeout(() => {
    session.turnRetryTimer = null
    try { fireTurnRetry(sid, attempt, text) } catch (err) {
      logMsg('error', 'turn-retry fire threw', { sid, error: (err as Error).message })
    }
  }, decision.delayMs)
}

/**
 * Deliver the retry.
 *
 * Re-resolves the session from the map rather than closing over it: across a
 * 10-minute backoff the entry can be reaped and REPLACED (a new CLI for the
 * same sid), and nudging a stale object would write to a dead FIFO.
 */
function fireTurnRetry(sid: string, attempt: number, errorText: string | null) {
  const session = sessions.get(sid)
  if (!session) {
    logMsg('info', 'turn-retry aborted — session gone', { sid, attempt })
    return
  }
  const message = turnRetryMessage(attempt, errorText)

  // Live CLI → plain FIFO write, exactly like a user message.
  if (session.state === 'running' && session.pid) {
    let alive = true
    try { process.kill(session.pid, 0) } catch { alive = false }
    if (alive) {
      const payload = JSON.stringify({ type: 'user', message: { role: 'user', content: message } })
      const ok = writeFifoRaw(session.pipePath, payload)
      logMsg(ok ? 'info' : 'error', 'turn-retry ' + (ok ? 'injected via FIFO' : 'FIFO write FAILED'), { sid, attempt })
      if (ok) return
      // FIFO gone but the process looked alive — fall through to the respawn path.
    }
  }

  // Dead CLI → cold resume. bridgeResume rebuilds argv from the registry record
  // (patched to --resume this sid), which is the same path the Mac uses when it
  // finds a session dead, so mode/model/permission flags are preserved.
  logMsg('info', 'turn-retry resuming dead session', { sid, attempt })
  cmdBridgeResume(RETRY_WS_SINK, 0, { cmd: 'bridgeResume', sid, message })
}

/**
 * A retry is daemon-initiated, so there is no client socket to answer. The
 * command handlers all take a ws to reply on, so give them a sink that drops
 * the reply but still records failures — a silent drop would hide a broken
 * resume for 12 hours.
 */
const RETRY_WS_SINK = {
  readyState: 1,
  send: (raw: string) => {
    try {
      const parsed = JSON.parse(raw) as { error?: string }
      if (parsed?.error) logMsg('error', 'turn-retry resume returned an error', { error: parsed.error })
    } catch { /* non-JSON reply — nothing to report */ }
    return 1
  },
  close: () => {},
} as unknown as ServerWebSocket<WsData>

/** Append a `type:"system"` marker to the stream file so the session timeline
 *  shows what the daemon did. Same pattern as the cron-fire marker: stream file
 *  only, never the canonical JSONL. */
function appendSystemMarker(sid: string, session: SessionData, subtype: string, content: string) {
  try {
    const marker = JSON.stringify({
      type: 'system', subtype, content,
      uuid: crypto.randomUUID(), session_id: sid,
      timestamp: new Date().toISOString(),
    }) + '\n'
    fs.appendFileSync(session.jsonlPath, marker)
  } catch (err) {
    logMsg('warn', 'system marker append failed', { sid, subtype, error: (err as Error).message })
  }
}

/** Cancel a pending retry. Called when a REAL send arrives (the human took over
 *  — never inject behind them) and from the death funnel. */
function cancelTurnRetry(sid: string, reason: string) {
  const session = sessions.get(sid)
  if (!session?.turnRetryTimer) return
  clearTimeout(session.turnRetryTimer)
  session.turnRetryTimer = null
  logMsg('info', 'turn-retry canceled', { sid, reason })
}

function checkCronFires(sid: string, session: SessionData) {
  const now = Date.now()
  if (session.lastCronCheckTs && now - session.lastCronCheckTs < CRON_CHECK_THROTTLE_MS) return
  session.lastCronCheckTs = now
  if (!session.cwd) return
  const base = path.join(session.cwd, '.claude')
  let tasksJson: string | null = null
  let lockJson: string | null = null
  try { tasksJson = fs.readFileSync(path.join(base, 'scheduled_tasks.json'), 'utf-8') } catch { return }
  try { lockJson = fs.readFileSync(path.join(base, 'scheduled_tasks.lock'), 'utf-8') } catch {}
  if (!session.cronWarned) session.cronWarned = {}
  const fires = detectCronFires({ sid, tasksJson, lockJson, nowMs: now, warned: session.cronWarned })
  for (const fire of fires) {
    logMsg(fire.foreign ? 'warn' : 'info', 'scheduled-task fire detected', {
      sid, taskId: fire.taskId, foreign: fire.foreign,
      createdBySessionId: fire.createdBySessionId, lastFiredAt: fire.lastFiredAt,
    })
    // 1. Stream-file marker — same append pattern as handleAppendUserMarker
    // (never the canonical JSONL). The tailer folds it (unknown system subtype
    // = v-only, safe) and fans it out; session-history renders
    // scheduled_task_fire as a system info row.
    try {
      const marker = JSON.stringify({
        type: 'system',
        subtype: 'scheduled_task_fire',
        content: cronFireMarkerText(fire),
        cron_task_id: fire.taskId,
        cron_created_by: fire.createdBySessionId ?? null,
        cron_foreign: fire.foreign,
        uuid: crypto.randomUUID(),
        session_id: sid,
        timestamp: new Date(now).toISOString(),
      }) + '\n'
      fs.appendFileSync(session.jsonlPath, marker)
    } catch (err) {
      logMsg('warn', 'scheduled-task fire: marker append failed', { sid, error: (err as Error).message })
    }
    // 2. Foreign fire = an ORPHANED durable cron just hijacked this session.
    // EVICT it from disk. We deliberately do NOT talk to the model here:
    // injecting a provenance warning (the original design) cost a turn + context
    // every hour and could not actually stop anything — the model is entitled to
    // ignore an automated message, and one verifiably did (2026-08-11). A
    // foreign fire means the creating session is not this one, so nobody in this
    // process will ever CronDelete it; removing the row is the only thing that
    // ends the loop. The stream marker above still tells the HUMAN what happened.
    if (fire.foreign && !ALLOW_DURABLE_CRON) {
      try {
        const tasksPath = path.join(base, 'scheduled_tasks.json')
        const strip = stripCronTaskById(tasksJson, fire.taskId)
        if (strip.changed && strip.text != null) {
          const tmp = tasksPath + '.walnut-' + String(process.pid) + '.tmp'
          fs.writeFileSync(tmp, strip.text, { mode: 0o600 })
          fs.renameSync(tmp, tasksPath)
          logMsg('warn', 'evicted orphaned foreign cron (Walnut policy: session-scoped crons only)', {
            sid, taskId: fire.taskId, createdBySessionId: fire.createdBySessionId, tasksPath,
          })
        }
      } catch (err) {
        logMsg('warn', 'foreign cron eviction failed', { sid, taskId: fire.taskId, error: (err as Error).message })
      }
    }
  }
}

function ensureWatcher(sid: string) {
  const session = sessions.get(sid)
  if (!session) return
  if (session.watcher) return // already running
  if (session.state !== 'running') return

  let offset = session.offset || 0
  const stderrPath = session.jsonlPath + '.err'
  // ── Torn-tail carry (contract §4 "Feed", adjudicated 2026-08-05) ──
  // A poll can land MID-LINE: the CLI appends a >64KB whale tool_result while
  // we read, so `stat.size` cuts the line in half. Such a fragment must NEVER
  // be processed — not folded, not fanned out:
  //   * fold: two unparseable fragments each advance foldState.v past the real
  //     line end, and the `v > foldState.v` guard then skips the COMPLETE line
  //     forever → a torn result/idle wedges the snapshot at turnActive=true.
  //   * fan-out (pre-existing bug this also fixes): the client received half a
  //     JSON line, failed to parse it, then received the whole line again.
  // So the fragment waits here in `carry` (BYTES — a UTF-8 char split across
  // polls must not be decoded twice) until its newline arrives.
  //
  // Offset semantics: `offset` is the READ cursor (every byte we've read, incl.
  // the carry). `carryStartV` is the absolute offset of the carry's first byte,
  // i.e. the last COMPLETE-line boundary, and satisfies
  // `carryStartV + carryLen === offset` at all times. We publish
  // `watcher.offset = carryStartV`, not the read cursor, so that
  //   * addSubscriber replay + the attach `currentOffset` reply never hand a
  //     client a mid-line boundary, and
  //   * stopSessionWatcher persists a complete-line boundary — a rebuilt
  //     watcher (self-heal, cmdRename) simply re-reads the torn region from
  //     there, so the carry is pure memory and nothing is lost when it dies.
  //
  // The carry is a PART LIST, not one Buffer (C26): a whale line arrives across
  // many polls, and concatenating (carry + new bytes) then searching for a
  // newline from byte 0 every tick re-copied and re-scanned the same megabytes
  // (quadratic). Instead: no newline in the NEW bytes ⇒ nothing can be
  // completed, so just append to the list; concat once, and start the newline
  // search at `carryLen` (the carry holds no newline by invariant), only when a
  // newline actually appears.
  let carryParts: Buffer[] = []
  let carryLen = 0
  let carryStartV = offset
  // Set after a carry-overflow drop: the remainder of the oversized line is
  // still coming, so skip everything up to and including its newline.
  let discardThroughNextNewline = false
  // Tailer self-heal state (incident 6c8428ac): a per-tick exception (e.g. EMFILE
  // on the openSync below) swallowed by the old empty catch froze `offset` forever
  // while the CLI kept writing — walnut showed idle for a running session. Track
  // consecutive failures; persistent failure = stalled tailer → log + rebuild.
  let consecutiveErrors = 0
  let lastErrorLogTs = 0
  const STALL_ERRORS_BEFORE_HEAL = 50 // ~5s of 100ms ticks failing back-to-back
  const HEAL_COOLDOWN_MS = 60_000

  const pollTimer = setInterval(() => {
    const s = sessions.get(sid)
    if (!s || s.state !== 'running') return
    try {
      const stat = fs.statSync(s.jsonlPath)
      if (stat.size <= offset) { consecutiveErrors = 0; return }

      const fd = fs.openSync(s.jsonlPath, 'r')
      const bytesToRead = stat.size - offset
      const buf = Buffer.alloc(bytesToRead)
      fs.readSync(fd, buf, 0, bytesToRead, offset)
      fs.closeSync(fd)
      consecutiveErrors = 0
      // The read cursor advances past ALL read bytes, including the torn tail we
      // are about to park in the carry (the carry is memory-only, see above).
      offset = stat.size

      // Assemble COMPLETE lines only. `v` is the byte offset at the END of the
      // line in the append-only jsonl — monotonic per session, and identical
      // whether the line is delivered live (here) or via replay
      // (addSubscriber), so the client orders and dedupes by `v` alone. It is
      // computed from absolute file positions (carryStartV), so parking a
      // fragment in the carry across polls changes no line's `v`.
      const batch: Array<{ line: string; v: number }> = []
      // C26 fast path: if the NEW bytes hold no newline, no line can complete —
      // so skip the concat + full rescan entirely.
      if (buf.indexOf(10) === -1) {
        if (discardThroughNextNewline) {
          // Still inside an over-cap line: these bytes can never complete a line
          // and re-buffering them would just re-trip the cap. Drop them and keep
          // the carryStartV + carryLen === offset invariant.
          carryStartV = offset
        } else {
          carryParts.push(buf)
          carryLen += buf.length
        }
      } else {
        // A newline arrived. Concat once; the carry itself holds no newline (that
        // is why it was carried), so the first search may start at `carryLen`.
        const chunk = carryLen ? Buffer.concat([...carryParts, buf], carryLen + buf.length) : buf
        let searchFrom = carryLen
        let lineEnd = carryStartV
        let cut = 0
        for (;;) {
          const nl = chunk.indexOf(10, searchFrom) // '\n'
          if (nl === -1) break
          lineEnd += (nl - cut) + 1
          const line = chunk.subarray(cut, nl).toString('utf-8')
          // A discarded whale (carry overflow below) ends at this newline: `v` is
          // now realigned, so resume normal processing with the NEXT line.
          if (discardThroughNextNewline) discardThroughNextNewline = false
          else batch.push({ line, v: lineEnd })
          cut = nl + 1
          searchFrom = cut
        }
        // Copy the torn tail — `chunk` may alias `buf`, which the next tick reuses.
        const tail = Buffer.from(chunk.subarray(cut))
        carryParts = tail.length ? [tail] : []
        carryLen = tail.length
        carryStartV = lineEnd
      }
      if (carryLen > TAILER_CARRY_MAX) {
        // A single line larger than the cap can't be assembled. Drop it and
        // realign on the next newline; `carryStartV` stays absolute so every
        // later line keeps its true `v`.
        logMsg('error', 'tailer carry overflow — dropping oversized partial line', {
          sid, carryBytes: carryLen, cap: TAILER_CARRY_MAX, offset,
        })
        carryStartV = offset
        carryParts = []
        carryLen = 0
        discardThroughNextNewline = true
      }
      // Publish the last COMPLETE-line boundary (not the read cursor) so
      // replay/attach never hand a client a mid-line offset.
      if (s.watcher) s.watcher.offset = carryStartV

      let sawResult = false
      for (const { line, v } of batch) {
        if (!line.trim()) continue

        // ── C1: incremental snapshot fold — EVERY complete line, BEFORE any
        // intercept `continue`s past fan-out. foldLine keeps its own v; the
        // `v > foldState.v` guard dedupes bytes already folded out-of-band
        // (appendUserMarker's optimistic overlay, watcher-heal overlap re-reads).
        if (v > s.foldState.v) s.foldState = foldLine(s.foldState, line, v)

        // ── Latency instrumentation: time from CLI spawn → first init line ──
        // Pure CLI cold-start (incl. MCP connect) as the daemon sees it, directly
        // comparable to running `claude` by hand. Logged once per session.
        if (!s.sawInit && line.includes('"type":"system"') && line.includes('"init"')) {
          s.sawInit = true
          logMsg('info', 'first init line from CLI', {
            sid, spawnToInitMs: s.spawnTs ? Date.now() - s.spawnTs : null,
          })
        }

        // ── TTFT instrumentation (inc-1786665503510): send → first output ──
        // Anchored by handleSendCommand (ttftSendTs). Two one-shot lines per
        // turn: first stream_event of any kind (model started answering — the
        // Bedrock TTFB proxy), and first text_delta (user-visible prose began).
        // A huge sendToFirstTextMs with a normal sendToFirstLineMs = the model
        // spent the gap thinking/tooling (upstream behavior, not a walnut bug).
        // Substring gates keep the hot path parse-free; cleared at result.
        if (s.ttftSendTs && line.includes('"type":"stream_event"')) {
          if (!s.ttftSawFirstLine) {
            s.ttftSawFirstLine = true
            logMsg('info', 'ttft: first stream_event after send', {
              sid, sendToFirstLineMs: Date.now() - s.ttftSendTs,
            })
          }
          if (line.includes('"text_delta"')) {
            logMsg('info', 'ttft: first text_delta after send', {
              sid, sendToFirstTextMs: Date.now() - s.ttftSendTs,
            })
            s.ttftSendTs = null // one-shot: only the FIRST text of the turn
          }
        }

        // ── Scheduled-task fire detection (see checkCronFires) ──
        // A cron fire's ONLY stream evidence is a bare turn start: the CLI
        // re-emits init + session_state_changed{running} with no user line.
        // Check the on-disk scheduled_tasks.json on those lines (30s throttle
        // inside makes this cheap; substring gate keeps the hot path free).
        if (line.includes('"init"') || line.includes('"session_state_changed"')) {
          try { checkCronFires(sid, s) } catch {}
        }

        // ── Durable-cron invariant, corrective half (see checkDurableCronCreate) ──
        if (line.includes('CronCreate')) {
          try { checkDurableCronCreate(sid, s, line) } catch {}
        }

        // ── Turn-error auto-retry (see checkTurnRetry) ──
        // Gate on the result-line substring only; the parse + is_error check
        // lives in the policy. Clean results come through too, because a
        // successful turn is what clears the failure streak.
        if (line.includes('"type":"result"')) {
          s.ttftSendTs = null // turn over — a stale TTFT anchor must not leak into replays
          try { checkTurnRetry(sid, s, line, v) } catch (err) {
            logMsg('warn', 'turn-retry check threw', { sid, error: (err as Error).message })
          }
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
        if (line.includes('"control_request"') || line.includes('"control_response"')
          || line.includes('"control_cancel_request"')) {
          try {
            const parsed = JSON.parse(line) as Record<string, unknown>
            if (parsed.type === 'control_request' && parsed.request_id
              && (parsed.request as Record<string, unknown>)?.subtype === 'can_use_tool') {
              const req = parsed.request as Record<string, unknown>
              const toolName = req.tool_name as string | undefined
              // ── INVARIANT: no durable crons (see daemon-core.ts) ──
              // Deny BEFORE the auto-allow check: a bypass-mode session would
              // otherwise be waved through, and a durable job outlives this
              // session to fire inside a stranger sharing the directory.
              if (!ALLOW_DURABLE_CRON && isDurableCronRequest(toolName, req.input)) {
                const resp = buildControlResponse(
                  parsed.request_id as string, req, false, durableCronDenyMessage(),
                )
                if (writeFifoRaw(s.pipePath, resp)) {
                  s.pendingCtrl = null
                  try { persistRegistry() } catch {}
                  logMsg('warn', 'denied durable CronCreate (Walnut policy: session-scoped crons only)', {
                    sid, mode: s.mode,
                  })
                  continue
                }
                logMsg('error', 'durable CronCreate deny could not be written to FIFO', { sid })
              }
              if (shouldAutoRespond(s.mode, toolName)) {
                const resp = buildControlResponse(parsed.request_id as string, req, true)
                if (writeFifoRaw(s.pipePath, resp)) {
                  s.pendingCtrl = null
                  try { persistRegistry() } catch {}
                  logMsg('info', 'auto-allowed control_request', { sid, tool: toolName, mode: s.mode })
                  continue
                }
              }
              s.pendingCtrl = {
                reqId: parsed.request_id as string,
                toolName: toolName ?? 'unknown',
                request: req,
                receivedAt: Date.now(),
              }
              try { persistRegistry() } catch {}
            } else if (parsed.type === 'control_response' && s.pendingCtrl) {
              const resp = parsed.response as Record<string, unknown> | undefined
              if (resp?.request_id === s.pendingCtrl.reqId) {
                s.pendingCtrl = null
                try { persistRegistry() } catch {}
              }
            } else if (parsed.type === 'control_cancel_request' && s.pendingCtrl) {
              // CLI withdrew the request (turn aborted / restart). Without this
              // branch pendingCtrl stays set forever → snapshot waiting=true and
              // the UI shows a permanent Waiting badge (incident a172ce49).
              if (parsed.request_id === s.pendingCtrl.reqId) {
                s.pendingCtrl = null
                try { persistRegistry() } catch {}
                logMsg('info', 'control_cancel_request cleared pendingCtrl', { sid, requestId: parsed.request_id })
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
      // ── C1: after each tailer batch, push the snapshot if it changed (this
      // also covers pendingCtrl set/clear — both happen inside this loop).
      pushSnapshot(sid, false)
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
    } catch (err) {
      // ENOENT is benign: a fresh session's jsonl doesn't exist until the CLI
      // writes its first line (cold start can take seconds). Not a stall.
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') { consecutiveErrors = 0; return }
      // NO-SILENT-FAILURES: the old empty catch here is what turned a per-tick
      // error into a permanently frozen tailer with zero log evidence. Log
      // (rate-limited — this fires every 100ms while the error persists) and
      // self-heal after sustained failure.
      consecutiveErrors++
      const now = Date.now()
      if (now - lastErrorLogTs > 10_000) {
        lastErrorLogTs = now
        logMsg('error', 'watcher poll tick failed', {
          sid, consecutiveErrors, offset,
          err: err instanceof Error ? `${(err as NodeJS.ErrnoException).code ?? ''} ${err.message}` : String(err),
        })
      }
      if (consecutiveErrors >= STALL_ERRORS_BEFORE_HEAL
        && now - (s.lastWatcherHealAt ?? 0) > HEAL_COOLDOWN_MS) {
        // Generation guard: only heal if WE are still the session's watcher.
        // If cmdStart replaced the session (new watcher), this timer is a leak —
        // kill only ourselves and leave the replacement alone.
        if (!s.watcher || s.watcher.pollTimer !== pollTimer) {
          logMsg('warn', 'stalled watcher is orphaned (session replaced) — clearing self', { sid })
          clearInterval(pollTimer)
          return
        }
        s.lastWatcherHealAt = now
        logMsg('error', 'watcher stalled — forcing rebuild', { sid, offset, carryStartV, consecutiveErrors })
        // Persist the last COMPLETE-line boundary (NOT the read cursor), tear
        // down, recreate. The in-memory carry dies with this watcher, so the
        // rebuilt one must re-read the torn region — resuming at `offset` would
        // swallow the fragment's first half. If the root cause (e.g. fd
        // exhaustion) has cleared, tailing continues from a clean line boundary
        // — no bytes lost (append-only file), and client-side `v` dedup absorbs
        // any overlap.
        s.offset = carryStartV
        stopSessionWatcher(sid)
        ensureWatcher(sid)
      }
    }
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
        // Prefix match: '"control_request"' misses control_request_progress
        // (heartbeats for in-flight side_question requests, inc-1786165723472)
        // and any future control_* variant — the whole family is plumbing.
        // Keep in sync with daemon-source.ts addSubscriber (CLAUDE.md).
        if (line.includes('"type":"control_')) continue
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

    const discovered = rebuildFoldStateFromJsonl(jsonlPath)
    session = {
      proc: null,
      pipePath,
      jsonlPath,
      pgidPath,
      pid,
      // Watcher starts at the fold rebuild's COMPLETE-line boundary — same rule
      // as adopt. Catch-up for [fromOffset, end) is addSubscriber's job (it reads
      // the file directly). Using the client's fromOffset here is wrong both
      // ways: 0 re-fans the whole file; MAX_SAFE_INTEGER (future-only
      // sentinel) freezes the watcher forever (stat.size <= offset). And a raw
      // stat().size would sit mid-line whenever the CLI is writing during
      // attach — the rebuild consumed the fragment's first half, so the
      // completed line would never be folded whole (contract §4 boundary rule).
      offset: discovered.boundary,
      taskState: rebuildTaskStateFromJsonl(jsonlPath, Date.now()),
      foldState: discovered.state,
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
async function cmdSend(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const { sid, message } = cmd as { sid: string; message: string }
  // A real send means someone (the user, a task hook, the Mac) is driving this
  // session now — drop any pending auto-retry so we never inject behind them.
  // The retry's own delivery does NOT come through here (it writes the FIFO
  // directly / goes via cmdBridgeResume), so this can't cancel itself.
  cancelTurnRetry(sid, 'superseded-by-send')
  const result = await core.handleSendCommand(sid, message)
  if ('error' in result) return sendError(ws, id, result.error)
  sendOk(ws, id, result as unknown as Record<string, unknown>)
}

// ── Send raw (permission-prompt-tool control_response passthrough) ──
// Same strict-ack protocol as cmdSend; the FIFO receives `raw` verbatim.
async function cmdSendRaw(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const { sid, raw } = cmd as { sid: string; raw: string }
  const result = await core.handleSendRawCommand(sid, raw)
  if ('error' in result) return sendError(ws, id, result.error)
  sendOk(ws, id, result as unknown as Record<string, unknown>)
}

// ── Append turn-start user marker to the stream file ──
// Logic lives in daemon-core.handleAppendUserMarker. Keep in sync with daemon-source.ts.
function cmdAppendUserMarker(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const { sid, message, messageId } = cmd as { sid: string; message: string; messageId: string }
  const result = core.handleAppendUserMarker(sid, message, messageId)
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
    if (writeFifoRaw(session.pipePath, resp)) {
      logMsg('info', 'setMode: auto-allowed pending control_request', { sid, tool: session.pendingCtrl.toolName, mode })
      session.pendingCtrl = null
      pushSnapshot(sid, false) // C1: pendingCtrl cleared → waiting resolves
    } else {
      logMsg('warn', 'setMode: failed to write pending control_response', { sid, tool: session.pendingCtrl.toolName, mode })
    }
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

  // An explicit stop is a human decision — it must never be undone by a pending
  // auto-retry respawning the CLI a few minutes later. Cancel the timer AND
  // clear the streak so an in-flight `result` line can't re-arm one either.
  cancelTurnRetry(sid, 'session-stopped')
  if (session.turnRetry) clearTurnRetryStreak(session.turnRetry)

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
      // The reaper's OWN keep-alive verdict, with its source — so what a
      // debugger sees here is exactly what the kill path will use.
      protection: deriveSessionProtection(session, sid, Date.now()),
      // C1: assembled on demand — the PULL half of snapshot flow.
      snapshot: assembleSessionSnapshot(session),
    })
  }
  // Unknown in memory — rebuild from the durable jsonl if it exists (post-restart PULL).
  const jsonlPath = path.join(STREAMS_DIR, sid + '.jsonl')
  if (!fs.existsSync(jsonlPath)) return sendOk(ws, id, { exists: false })
  const taskState = rebuildTaskStateFromJsonl(jsonlPath, Date.now())
  // C1: disk-rebuild snapshot. No live process backs this sid (it would be in
  // the map) → dead, no pendingCtrl, unknown pid/exitCode. The epoch is stamped
  // from the on-disk file so a pull against a dead session still lets walnut
  // detect a recreated file (incident 019a7fe5 — this IS the reconcile path).
  let diskEpoch: string | null = null
  try {
    const st = fs.statSync(jsonlPath)
    diskEpoch = `${st.dev}:${st.ino}:${Math.floor(st.birthtimeMs)}`
  } catch {}
  const snapshot = assembleSnapshot({
    foldState: rebuildFoldStateFromJsonl(jsonlPath).state,
    pendingCtrl: null,
    dead: true,
    pid: null,
    exitCode: null,
    streamEpoch: diskEpoch,
  })
  return sendOk(ws, id, { exists: true, alive: false, state: 'dead', taskState, snapshot })
}

// ── Rename session files ──
function cmdRename(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const { oldSid, newSid } = cmd as { oldSid: string; newSid: string }
  if (!oldSid || !newSid) return sendError(ws, id, 'rename: missing oldSid or newSid')
  if (oldSid === newSid) return sendOk(ws, id, { renamed: true })

  const session = sessions.get(oldSid)
  if (!session) return sendError(ws, id, 'rename: session not found: ' + oldSid)

  // Derive from the session's ACTUAL file location, not STREAMS_DIR: a live
  // session spawned before the /tmp→HOME move still has its family in the
  // legacy dir (startup migration skips live pgids), and renaming against the
  // new dir would silently fail per-ext and then point jsonlPath at a
  // nonexistent file — the session would go deaf.
  const liveDir = path.dirname(session.jsonlPath)
  const oldBase = path.join(liveDir, oldSid)
  const newBase = path.join(liveDir, newSid)

  // C14: flush a pending coalesced snapshot BEFORE the re-key. pushSnapshot's
  // 50ms timer carries a generation guard (`sessions.get(sid) !== session`) that
  // is keyed on the OLD sid — after the delete/set below it can never match, so
  // the queued state change would be silently dropped and walnut would only
  // learn about it on the next 30s pull. Flush at the old sid (that is the sid
  // walnut's subscribers know right now) and clear the timer.
  // Keep in sync with daemon-source.ts cmdRename.
  if (session.snapshotTimer) {
    try { pushSnapshot(oldSid, true) } catch {}
    if (session.snapshotTimer) { clearTimeout(session.snapshotTimer); session.snapshotTimer = null }
  }

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
    // Agent gateway: the CLI's WALNUT_SESSION_ID env still carries the OLD sid
    // (env is frozen at spawn). Record the alias so resolveCallerSid can chase
    // the chain to the current sid. Keep in sync with daemon-source.ts.
    gatewaySidAliases.set(oldSid, newSid)

    ensureWatcher(newSid)

    sendOk(ws, id, { renamed: true })
    logMsg('info', 'session renamed', { oldSid, newSid })
  } catch (err: unknown) {
    sendError(ws, id, 'rename failed: ' + (err as Error).message)
  }
}

// ── Read history ──
function cmdReadHistory(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const { sid, canonicalPath, tailBytes } = cmd as { sid: string; canonicalPath?: string; tailBytes?: number }
  if (!sid) return sendError(ws, id, 'read-history: missing sid')

  try {
    // Read main JSONL. tailBytes > 0 = tail-only read (mobile transcript):
    // whale sessions (10MB+) must not ride the bridge as one frame when the
    // caller only renders the last ~200 rows. The first (possibly partial)
    // line after the cut is dropped. Keep in sync with daemon-source.ts.
    let mainContent = ''
    const jsonlPath = canonicalPath || path.join(STREAMS_DIR, sid + '.jsonl')
    const wantTail = typeof tailBytes === 'number' && tailBytes > 0
    try {
      if (wantTail) {
        const st = fs.statSync(jsonlPath)
        const start = Math.max(0, st.size - (tailBytes as number))
        const fd = fs.openSync(jsonlPath, 'r')
        try {
          const buf = Buffer.alloc(st.size - start)
          fs.readSync(fd, buf, 0, buf.length, start)
          mainContent = buf.toString('utf-8')
          if (start > 0) {
            const nl = mainContent.indexOf('\n')
            mainContent = nl >= 0 ? mainContent.slice(nl + 1) : ''
          }
        } finally { fs.closeSync(fd) }
      } else {
        mainContent = fs.readFileSync(jsonlPath, 'utf-8')
      }
    } catch {}

    // Read subagents (skipped on tail reads — transcripts are main-lane only)
    const subagents: Record<string, string> = {}
    if (!wantTail) {
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
    }

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
    // Regular files ONLY, checked BEFORE open: open() on a FIFO with no writer
    // blocks a fs-pool thread FOREVER (2026-08-15: 14 wedged threads = every
    // local fs RPC timing out for hours). stat() never blocks on a FIFO.
    const st = await fs.promises.stat(filePath)
    if (!st.isFile()) {
      return sendError(ws, id, 'fs.read failed: not a regular file (ENOTFILE)')
    }
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

// Bridge-safe image read: extension allowlist + size cap. The ONLY fs command
// reachable from the cloud bridge (see BRIDGE_ALLOWED_COMMANDS) — phones need
// session-referenced pictures, but a compromised cloud box must not be able to
// read arbitrary files (keys, configs) off exec hosts.
const IMAGE_READ_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp'])
const IMAGE_READ_MAX_BYTES = 20 * 1024 * 1024

// Magic-byte check: the extension gate alone would let a compromised cloud
// box exfiltrate any file that merely ENDS in .png; requiring a real image
// header means non-image bytes (keys, configs) never leave the host.
function looksLikeImage(data: Buffer): boolean {
  if (data.length < 12) return false
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return true // PNG
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return true // JPEG
  if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x38) return true // GIF8
  if (data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46
    && data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50) return true // RIFF…WEBP
  return false
}

async function cmdFsReadImage(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  let filePath = cmd.path as string
  if (!filePath) return sendError(ws, id, 'fs.readImage: missing path')
  if (filePath === '~' || filePath.startsWith('~/')) {
    filePath = HOME_DIR + filePath.slice(1)
  }
  if (filePath.includes('..')) return sendError(ws, id, 'fs.readImage: invalid path')
  const ext = filePath.slice(filePath.lastIndexOf('.') + 1).toLowerCase()
  if (!IMAGE_READ_EXTENSIONS.has(ext)) return sendError(ws, id, 'fs.readImage: not an image (ENOTIMAGE)')

  try {
    const st = await fs.promises.stat(filePath)
    if (!st.isFile()) return sendError(ws, id, 'fs.readImage: not a file (ENOENT)')
    if (st.size > IMAGE_READ_MAX_BYTES) return sendError(ws, id, 'fs.readImage: too large (EFBIG)')
    const data = await fs.promises.readFile(filePath)
    if (!looksLikeImage(data)) return sendError(ws, id, 'fs.readImage: not an image (ENOTIMAGE)')
    sendOk(ws, id, { data: data.toString('base64'), encoding: 'base64' })
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException
    const code = e.code ?? ''
    sendError(ws, id, 'fs.readImage failed: ' + e.message + (code ? ' (' + code + ')' : ''))
  }
}

// Bridge-safe bounded file read: size cap + HOST-SIDE path sandbox. Serves
// the cloud replica's phone file previews (HTML/text file-content relay).
// Unlike fs.read (trusted SSH channel only), this is reachable from the
// public cloud bridge, so THIS handler is the security authority — the
// replica's own checks are a convenience, not the guarantee. Keep in sync
// with daemon-source.ts cmdFsReadBounded.
const FS_READ_BOUNDED_MAX_BYTES = 2 * 1024 * 1024 // 2MB — bridge frames stay small
// Secret files/dirs never served over the bridge. Checked against the
// REALPATH-resolved target so a symlink can't launder a denied path.
const FS_READ_BOUNDED_DENIED_DIRS = ['.ssh', '.aws', '.gnupg', path.join('.config', 'walnut-secrets')]
const FS_READ_BOUNDED_DENIED_BASENAMES = new Set([
  '.netrc', '.npmrc', '.git-credentials', 'credentials', 'auth.json', 'bridge-tokens.json',
])
const FS_READ_BOUNDED_DENIED_EXTENSIONS = new Set(['pem', 'key', 'p12', 'pfx', 'ppk', 'jks', 'keystore'])

function fsReadBoundedDenied(resolved: string): boolean {
  for (const dir of FS_READ_BOUNDED_DENIED_DIRS) {
    const abs = path.join(HOME_DIR, dir)
    if (resolved === abs || resolved.startsWith(abs + path.sep)) return true
    // Any path SEGMENT named .ssh/.aws/… — covers non-HOME checkouts of keys.
    if (resolved.split(path.sep).includes(dir)) return true
  }
  const base = path.basename(resolved)
  if (FS_READ_BOUNDED_DENIED_BASENAMES.has(base)) return true
  if (base === '.env' || base.startsWith('.env.')) return true
  if (/^id_(rsa|dsa|ecdsa|ed25519)/.test(base)) return true
  const ext = base.slice(base.lastIndexOf('.') + 1).toLowerCase()
  if (FS_READ_BOUNDED_DENIED_EXTENSIONS.has(ext)) return true
  if (/^config\.ya?ml$/.test(base)) return true
  return false
}

async function cmdFsReadBounded(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  let filePath = cmd.path as string
  if (!filePath || typeof filePath !== 'string') return sendError(ws, id, 'fs.readBounded: missing path')
  if (filePath === '~' || filePath.startsWith('~/')) {
    filePath = HOME_DIR + filePath.slice(1)
  }
  if (filePath.includes('..')) return sendError(ws, id, 'fs.readBounded: invalid path (EDENIED)')
  if (!path.isAbsolute(filePath)) return sendError(ws, id, 'fs.readBounded: path must be absolute (EDENIED)')
  try {
    // realpath BEFORE the denylist: a symlink at an innocent path must not
    // serve ~/.ssh bytes. ENOENT here doubles as the not-found check.
    const resolved = await fs.promises.realpath(filePath)
    if (fsReadBoundedDenied(resolved)) {
      return sendError(ws, id, 'fs.readBounded: path not permitted (EDENIED)')
    }
    // Regular files ONLY, stat BEFORE open: open() on a FIFO with no writer
    // wedges an fs-pool thread forever (same guard as fs.read).
    const st = await fs.promises.stat(resolved)
    if (!st.isFile()) return sendError(ws, id, 'fs.readBounded: not a regular file (ENOTFILE)')
    if (st.size > FS_READ_BOUNDED_MAX_BYTES) {
      return sendError(ws, id, 'fs.readBounded: too large (EFBIG)')
    }
    const data = await fs.promises.readFile(resolved)
    sendOk(ws, id, { data: data.toString('base64'), encoding: 'base64', size: data.length })
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException
    const code = e.code ?? ''
    sendError(ws, id, 'fs.readBounded failed: ' + e.message + (code ? ' (' + code + ')' : ''))
  }
}

// Bridge-safe image save: mediaType allowlist + decoded-size cap + magic-byte
// check, writing ONLY into a fixed daemon-owned directory with a generated
// filename. The ONLY write command reachable from the cloud bridge (see
// BRIDGE_ALLOWED_COMMANDS) — phones attach pictures to sessions, but a
// compromised cloud box must never get arbitrary file writes on exec hosts:
// no caller-controlled path component ever reaches the filesystem (the
// extension comes from the mediaType allowlist, never from the caller), and
// non-image bytes are refused, so this cannot plant scripts/configs/keys.
const IMAGE_SAVE_MEDIA_TO_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/heic': 'heic',
}
const IMAGE_SAVE_MAX_BYTES = 10 * 1024 * 1024
// ~4/3 base64 overhead + slack — refuse before decoding an oversized string.
const IMAGE_SAVE_MAX_BASE64_LENGTH = 14_000_000
const IMAGE_SAVE_DIR = path.join(DAEMON_DIR, 'images', 'mobile')

// HEIC rides ISO-BMFF: a 'ftyp' box at byte 4. looksLikeImage covers the rest.
function looksLikeHeic(data: Buffer): boolean {
  return data.length >= 12 && data.slice(4, 8).toString('latin1') === 'ftyp'
}

async function cmdImageSave(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const data = cmd.data
  const mediaType = cmd.mediaType
  if (typeof data !== 'string' || data.length === 0) return sendError(ws, id, 'image.save: missing data')
  if (data.length > IMAGE_SAVE_MAX_BASE64_LENGTH) return sendError(ws, id, 'image.save: too large (EFBIG)')
  const ext = typeof mediaType === 'string' ? IMAGE_SAVE_MEDIA_TO_EXT[mediaType] : undefined
  if (!ext) return sendError(ws, id, 'image.save: unsupported mediaType (ENOTIMAGE)')
  const buf = Buffer.from(data, 'base64')
  if (buf.length === 0) return sendError(ws, id, 'image.save: invalid base64')
  if (buf.length > IMAGE_SAVE_MAX_BYTES) return sendError(ws, id, 'image.save: too large (EFBIG)')
  const isImage = mediaType === 'image/heic' ? looksLikeHeic(buf) : looksLikeImage(buf)
  if (!isImage) return sendError(ws, id, 'image.save: not an image (ENOTIMAGE)')
  // Generated filename — timestamp + random; extension from the mediaType
  // allowlist. NEVER from caller input: no path component crosses the bridge.
  const filename = Date.now() + '-' + crypto.randomBytes(4).toString('hex') + '.' + ext
  const filePath = path.join(IMAGE_SAVE_DIR, filename)
  try {
    await fs.promises.mkdir(IMAGE_SAVE_DIR, { recursive: true })
    await fs.promises.writeFile(filePath, buf)
    logMsg('info', 'image.save: saved', { path: filePath, size: buf.length })
    sendOk(ws, id, { path: filePath, size: buf.length })
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException
    const code = e.code ?? ''
    sendError(ws, id, 'image.save failed: ' + e.message + (code ? ' (' + code + ')' : ''))
  }
}

async function cmdFsWrite(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const { path: filePath, data, encoding } = cmd as { path: string; data: string; encoding?: string }
  // `typeof` not truthiness: EMPTY data is legal (clearing a file to zero bytes
  // is a real save), and `!data` rejected it as "missing".
  if (!filePath || typeof data !== 'string') return sendError(ws, id, 'fs.write: missing path or data')

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

async function cmdFsMkdir(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  let dirPath = cmd.path as string
  if (!dirPath) return sendError(ws, id, 'fs.mkdir: missing path')

  // Expand ~ to home directory (Node fs doesn't do shell expansion)
  if (dirPath === '~' || dirPath.startsWith('~/')) {
    dirPath = HOME_DIR + dirPath.slice(1)
  }

  try {
    // recursive:true tolerates already-existing directories (idempotent)
    await fs.promises.mkdir(dirPath, { recursive: true })
    sendOk(ws, id, { created: true, resolvedPath: dirPath })
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException
    const code = e.code ?? ''
    sendError(ws, id, 'fs.mkdir failed: ' + e.message + (code ? ' (' + code + ')' : ''))
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
    // detail:true adds per-file size/mtimeMs (one stat per entry) — used by the
    // session-changes subagent cache to skip re-reading unchanged files. Off by
    // default so high-frequency callers (git-root walks) don't pay the stats.
    const detail = cmd.detail === true
    const result = await Promise.all(entries.map(async e => {
      const type = e.isDirectory() ? 'dir' : e.isFile() ? 'file' : 'other'
      if (!detail || type !== 'file') return { name: e.name, type }
      try {
        const st = await fs.promises.stat(dirPath + '/' + e.name)
        return { name: e.name, type, size: st.size, mtimeMs: st.mtimeMs }
      } catch {
        return { name: e.name, type }
      }
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
    // dev/ino/birthtimeMs let walnut compute the stream-file epoch
    // (dev:ino:birthtimeMs) for a file it only sees through this RPC —
    // required to durably reset a consumedOffset watermark that belongs to a
    // dead file incarnation (incident inc-1786428350008: a 37.9 MB legacy-path
    // watermark suppressed every result in the 6 MB successor file).
    sendOk(ws, id, {
      exists: true, mtimeMs: st.mtimeMs, size: st.size,
      dev: st.dev, ino: st.ino, birthtimeMs: st.birthtimeMs,
    })
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'ENOENT') {
      sendOk(ws, id, { exists: false })
      return
    }
    sendError(ws, id, 'fs.stat failed: ' + e.message)
  }
}

/**
 * Resolve "whatever the model wrote" to a real path ON THIS HOST — capability
 * 'path-resolve-v1'.
 *
 * The design-principle path (AGENTS.md): the whole layered search (transcript
 * scan, ancestor walk, git index, pruned find) touches only files on this host,
 * so it runs HERE and one small answer crosses the tunnel. The server's old
 * version did the same search over RPC and needed ~2 round trips per ancestor
 * level (~18 on a deep path), which routinely blew its own time budget and fell
 * back to a path that did not exist.
 */
async function cmdFsResolvePath(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const ref = cmd.ref as string
  if (!ref || typeof ref !== 'string') return sendError(ws, id, 'fs.resolvePath: missing ref')
  try {
    const result = await resolvePathHostLocal({
      ref,
      cwd: typeof cmd.cwd === 'string' && cmd.cwd ? cmd.cwd : undefined,
      sessionId: typeof cmd.sessionId === 'string' && cmd.sessionId ? cmd.sessionId : undefined,
      claudeHome: path.join(HOME_DIR, '.claude'),
      homeDir: HOME_DIR,
      budgetMs: typeof cmd.budgetMs === 'number' ? cmd.budgetMs : undefined,
    })
    sendOk(ws, id, result as unknown as Record<string, unknown>)
  } catch (err: unknown) {
    sendError(ws, id, 'fs.resolvePath failed: ' + (err as Error).message)
  }
}

// Byte-range read for LARGE files. A whole-file fs.read of a multi-MB session
// JSONL serializes into ONE giant WS frame; some corporate SSH proxies kill the
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
    // Same FIFO guard as fs.read: stat BEFORE open (see cmdFsRead).
    const pre = await fs.promises.stat(filePath)
    if (!pre.isFile()) {
      return sendError(ws, id, 'fs.readRange failed: not a regular file (ENOTFILE)')
    }
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

  // Optional narrowing: only materialize blobs for these repo-relative paths.
  const paths = Array.isArray(cmd.paths) && (cmd.paths as unknown[]).every((p) => typeof p === 'string')
    ? cmd.paths as string[]
    : undefined

  try {
    const result = await computeGitDiff(base, cwd, exec, readText, paths ? { paths } : undefined)
    if (!result) return sendOk(ws, id, { repoRoot: null, files: [] }) // not a git repo
    sendOk(ws, id, { repoRoot: result.repoRoot, files: result.files })
  } catch (err: unknown) {
    if (err instanceof GitDiffError) return sendError(ws, id, err.message)
    sendError(ws, id, 'git.diff failed: ' + (err as Error).message)
  }
}

// ── Discover sessions started OUTSIDE Walnut (capability 'external-scan-v1') ──
// Host-local by design: this host owns thousands of transcript files, so the
// walk + head parse happen HERE and only the small descriptor list crosses the
// tunnel. Serialized daemon-wide (one scan at a time) so a burst of server
// ticks can't stack concurrent directory walks.
let externalScanInflight: Promise<void> = Promise.resolve()

async function cmdDiscoverExternalSessions(
  ws: ServerWebSocket<WsData>,
  id: number,
  cmd: Record<string, unknown>,
) {
  const prev = externalScanInflight
  let release!: () => void
  externalScanInflight = new Promise<void>((r) => { release = r })
  await prev.catch(() => {})
  try {
    const sinceMs = typeof cmd.sinceMs === 'number' && cmd.sinceMs > 0
      ? cmd.sinceMs
      : 30 * 24 * 60 * 60 * 1000
    const knownSessionIds = Array.isArray(cmd.knownSessionIds)
      ? (cmd.knownSessionIds as unknown[]).filter((s): s is string => typeof s === 'string')
      : []
    const limit = typeof cmd.limit === 'number' && cmd.limit > 0 ? cmd.limit : undefined
    const t0 = Date.now()
    const result = scanExternalSessions({ sinceMs, knownSessionIds, limit })
    logMsg('info', 'external session scan', {
      scanned: result.scanned,
      found: result.candidates.length,
      truncated: result.truncated,
      ms: Date.now() - t0,
    })
    sendOk(ws, id, {
      candidates: result.candidates,
      scanned: result.scanned,
      truncated: result.truncated,
    })
  } catch (err) {
    sendError(ws, id, 'sessions.discoverExternal failed: ' + (err as Error).message)
  } finally {
    release()
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

// ── Session changes (host-local compute — capability 'changes-v1') ──
// The design-principle path (AGENTS.md): this host parses its OWN session
// JSONLs and reads its OWN files; only a light list / one file's diff crosses
// the tunnel. The pipeline lives in session-changes-core.ts (shared with the
// server's fallback compute so both produce identical results).
//
// Cache: per-sid full output keyed on the main JSONL's (mtimeMs, size), plus
// the subagent size-cache and git-root memo reused ACROSS recomputes. Serial
// gate: one compute at a time daemon-wide (a whale parse is CPU+fs heavy; two
// in parallel would starve session I/O), followers of the same sid coalesce.
interface ChangesCacheEntry {
  mtimeMs: number
  size: number
  output: HostLocalComputeOutput
  subCache: Map<string, { size: number; fileMap: Map<string, ChangesFileAccum> }>
  gitRootByDir: Map<string, string | null>
  lastUsed: number
}
const changesCache = new Map<string, ChangesCacheEntry>()
const CHANGES_CACHE_MAX_SESSIONS = 12
let changesInflight: Promise<void> = Promise.resolve()
const changesInflightBySid = new Map<string, Promise<ChangesCacheEntry | null>>()

async function computeChangesCached(sid: string, cwd: string | undefined, refresh?: boolean): Promise<ChangesCacheEntry | null> {
  // mtime+size fast-path — no lock needed for a pure cache hit. refresh
  // ("re-read the data") skips it but still reuses subCache/gitRoot memos.
  const cached = changesCache.get(sid)
  if (cached && !refresh) {
    try {
      const st = await fs.promises.stat(cached.output.jsonlPath)
      if (st.mtimeMs === cached.mtimeMs && st.size === cached.size) {
        cached.lastUsed = Date.now()
        return cached
      }
    } catch { /* stat failed → recompute below */ }
  }
  // Coalesce concurrent requests for the same sid.
  const existing = changesInflightBySid.get(sid)
  if (existing) return existing
  const run = (async (): Promise<ChangesCacheEntry | null> => {
    // Daemon-wide serial gate: chain onto whatever compute is running.
    const prev = changesInflight
    let release!: () => void
    changesInflight = new Promise<void>((r) => { release = r })
    await prev.catch(() => { /* prior failure doesn't gate us */ })
    try {
      const prior = changesCache.get(sid)
      const output = await computeHostLocalChanges({
        sessionId: sid,
        cwd,
        claudeHome: path.join(HOME_DIR, '.claude'),
        subCache: prior?.subCache,
        gitRootByDir: prior?.gitRootByDir,
      })
      if (!output) return null
      const entry: ChangesCacheEntry = {
        mtimeMs: output.mtimeMs,
        size: output.size,
        output,
        subCache: prior?.subCache ?? new Map(),
        gitRootByDir: prior?.gitRootByDir ?? new Map(),
        lastUsed: Date.now(),
      }
      changesCache.set(sid, entry)
      // LRU bound — whale outputs hold full before/after strings.
      if (changesCache.size > CHANGES_CACHE_MAX_SESSIONS) {
        let oldest: string | null = null
        let oldestTs = Infinity
        for (const [k, v] of changesCache) {
          if (v.lastUsed < oldestTs) { oldestTs = v.lastUsed; oldest = k }
        }
        if (oldest && oldest !== sid) changesCache.delete(oldest)
      }
      return entry
    } finally {
      release()
      changesInflightBySid.delete(sid)
    }
  })()
  changesInflightBySid.set(sid, run)
  return run
}

async function cmdChangesCompute(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const sid = cmd.sid as string
  if (!sid) return sendError(ws, id, 'changes.compute: missing sid')
  const cwd = typeof cmd.cwd === 'string' && cmd.cwd ? cmd.cwd : undefined
  const refresh = cmd.refresh === true
  try {
    const entry = await computeChangesCached(sid, cwd, refresh)
    if (!entry) return sendOk(ws, id, { found: false, result: null })
    // The wire result is ALWAYS light — per-file content rides changes.file.
    sendOk(ws, id, {
      found: true,
      result: toLightChangesResult(entry.output.result),
      mtimeMs: entry.mtimeMs,
      jsonlPath: entry.output.jsonlPath,
    })
  } catch (err) {
    sendError(ws, id, 'changes.compute failed: ' + (err as Error).message)
  }
}

async function cmdChangesFile(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const sid = cmd.sid as string
  const filePath = cmd.path as string
  if (!sid) return sendError(ws, id, 'changes.file: missing sid')
  if (!filePath) return sendError(ws, id, 'changes.file: missing path')
  const cwd = typeof cmd.cwd === 'string' && cmd.cwd ? cmd.cwd : undefined
  try {
    // Serve from the cached full output even when slightly stale (mtime moved):
    // a file click must not wait behind a whale recompute. The list refresh
    // converges the frontend's per-file cache.
    let entry = changesCache.get(sid)
    if (!entry) entry = (await computeChangesCached(sid, cwd)) ?? undefined
    if (!entry) return sendOk(ws, id, { found: false })
    entry.lastUsed = Date.now()
    for (const group of entry.output.result.groups) {
      const file = group.files.find((f) => f.filePath === filePath)
      if (file) return sendOk(ws, id, { found: true, repoRoot: group.repoRoot, file })
    }
    sendOk(ws, id, { found: false })
  } catch (err) {
    sendError(ws, id, 'changes.file failed: ' + (err as Error).message)
  }
}

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
// Cron-armed sessions (/loop): the CLI's in-process scheduler lives in THIS
// process's memory — killing it silently kills the loop. Extended, not
// disabled: the CLI auto-expires recurring crons after 7 days, so a session
// idle beyond that has a dead scheduler and is safe to reclaim.
const SESSION_CRON_IDLE_KILL_MS = 7 * 24 * 60 * 60 * 1000   // 7 days
// Sessions with a running background task (local_bash / local_agent /
// local_workflow): a wait-style bash task polls silently — its output goes to
// the task's output_file, NOT the JSONL — so the session looks "idle" for the
// task's whole lifetime (incident inc-1786222771315: a "wait for QA phase"
// bash task was killed at the 2h mark while derivedRunning was 1).
// PRINCIPLE: a session with running background work should never be reaped.
// The Mac-side health monitor implements exactly that (isBackgroundWorkActive
// → skip, unbounded). This daemon-side cap exists ONLY for the one edge case
// with no client to bail us out: a live CLI whose task framework wedged and
// will never emit a terminal event — indistinguishable from real work, and
// without a ceiling it's an immortal process on the remote host. 3 days of
// TOTAL JSONL silence (not task runtime) is far beyond any legitimate silent
// stretch; the Mac monitor protects real work long before this fires.
const SESSION_BG_IDLE_KILL_MS = 3 * 24 * 60 * 60 * 1000   // 3 days
const SESSION_SCAN_INTERVAL_MS = 60_000            // every 60s

// ── Last-resort cron evidence: the CLI scheduler's own debug log ──
// The fold's cronIds is a replay of the /tmp stream file — /tmp can be
// age-cleaned (systemd-tmpfiles `v /tmp 10d`) or hand-wiped, and a rebuild
// from a missing file yields an EMPTY fold that would strip a live loop's
// protection. The CLI writes `[ScheduledTasks] firing <id>` to
// ~/.claude/debug/<sid>.txt (HOME, not /tmp) in real time on every fire —
// first-hand, process-independent evidence. Before killing, check the tail
// of that file for a recent firing line; recent = within the kill threshold
// (a firing inside the window means the scheduler is alive regardless of
// what the fold thinks). Read is bounded (last 64KB) and only runs on the
// rare kill path, never on the per-minute scan of healthy sessions.
const CRON_DEBUG_TAIL_BYTES = 64 * 1024
function hasRecentSchedulerFiring(sid: string, withinMs: number): boolean {
  const debugPath = path.join(os.homedir(), '.claude', 'debug', sid + '.txt')
  let fd: number
  try { fd = fs.openSync(debugPath, 'r') } catch { return false }
  try {
    const size = fs.fstatSync(fd).size
    const readLen = Math.min(size, CRON_DEBUG_TAIL_BYTES)
    const buf = Buffer.alloc(readLen)
    fs.readSync(fd, buf, 0, readLen, size - readLen)
    const text = buf.toString('utf-8')
    const cutoff = Date.now() - withinMs
    // Lines look like: 2026-08-08T01:43:58.502Z [DEBUG] [ScheduledTasks] firing 018e22e9 (recurring)
    const re = /^(\S+) \[DEBUG\] \[ScheduledTasks\] (?:firing|scheduled) /gm
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      const t = Date.parse(m[1])
      if (!Number.isNaN(t) && t >= cutoff) return true
    }
    return false
  } catch { return false } finally {
    try { fs.closeSync(fd) } catch {}
  }
}

// ── Session keep-alive protection: ONE authoritative verdict, with a source ──
// Every "why is this idle session still alive?" decision flows through here,
// and the same verdict is exposed on getState so what a human sees while
// debugging IS what the kill path used. History: each cross-turn state the
// CLI keeps in-process became an incident when the reaper didn't know about
// it — /loop crons (2026-08-07), running bg tasks (inc-1786222771315), and
// teamActive was never wired daemon-side at all. New cross-turn state = add
// ONE branch here, nowhere else.
// PRINCIPLE: protected sessions are extended, never exempt — the ceilings
// below exist only as immortal-process backstops (wedged task framework /
// expired scheduler), not as work budgets.
interface SessionProtection {
  source: 'cron' | 'team' | 'bg-task' | 'turn-retry' | null
  killMs: number
  detail?: string
}

function deriveSessionProtection(session: SessionData, sid: string, now: number): SessionProtection {
  // Cron (7d = the CLI's own recurring-cron auto-expiry). TWO signals, either
  // arms: fold (CronCreate seen in THIS stream — covers session-only crons,
  // which never touch disk) or disk ({cwd}/.claude/scheduled_tasks.json —
  // durable crons; the fold goes blind on stream wipe/rebuild, on --resume
  // respawn (history replay re-arms the CLI scheduler with NO new CronCreate
  // line — lab 2026-08-10 P4b), and on adopted foreign tasks).
  if (Object.keys(session.foldState.cronIds).length > 0) {
    return { source: 'cron', killMs: SESSION_CRON_IDLE_KILL_MS, detail: 'fold' }
  }
  if (session.cwd) {
    // 10-min TTL cache: scans run every 60s per session; staleness only
    // delays the *lift* of protection, never a kill.
    if (session.diskCronCache && now - session.diskCronCache.at < 10 * 60_000) {
      if (session.diskCronCache.armed) {
        return { source: 'cron', killMs: SESSION_CRON_IDLE_KILL_MS, detail: 'disk-cache' }
      }
    } else {
      let tasksJson: string | null = null
      let lockJson: string | null = null
      try { tasksJson = fs.readFileSync(path.join(session.cwd, '.claude', 'scheduled_tasks.json'), 'utf-8') } catch {}
      try { lockJson = fs.readFileSync(path.join(session.cwd, '.claude', 'scheduled_tasks.lock'), 'utf-8') } catch {}
      const disk = hasDiskCronInterest({ sid, tasksJson, lockJson, nowMs: now })
      session.diskCronCache = { at: now, armed: disk.armed, reason: disk.reason }
      if (disk.armed) {
        return { source: 'cron', killMs: SESSION_CRON_IDLE_KILL_MS, detail: 'disk:' + (disk.reason ?? '') }
      }
    }
  }
  // In-process team (Claude Code team mode): the lead session polls teammates
  // between turns with no JSONL output of its own. The Mac health monitor has
  // skipped team-active sessions since day one; the daemon reaper never knew.
  if (session.foldState.teamActive) {
    return { source: 'team', killMs: SESSION_BG_IDLE_KILL_MS }
  }
  // Running background task (daemon's OWN taskState — the same fold the
  // watcher feeds): wait-style bash tasks write to output_file, not the
  // stream, so the session looks idle for the task's whole lifetime
  // (inc-1786222771315). isBackgrounded tasks are already excluded by
  // runningTaskCount.
  if (session.taskState.derivedRunning > 0) {
    return { source: 'bg-task', killMs: SESSION_BG_IDLE_KILL_MS }
  }
  // Pending turn-retry: the session is deliberately SILENT during the backoff
  // (up to 10 min), which is exactly what "idle" looks like to the reaper. This
  // is cross-turn state the reaper must know about, or the 30-min idle kill
  // silently eats a session that was waiting out an upstream outage — the retry
  // would then fire against a corpse and the whole feature would look flaky.
  if (session.turnRetryTimer) {
    return { source: 'turn-retry', killMs: SESSION_BG_IDLE_KILL_MS, detail: 'backoff-pending' }
  }
  return { source: null, killMs: SESSION_IDLE_KILL_MS }
}

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

    // Feed the age-cleaner watchdog: .pgid is written once at spawn and never
    // touched again, so systemd-tmpfiles' 10-day /tmp age rule (`v /tmp 10d`
    // on typical Linux dev hosts) deletes it out from under a long-lived
    // session — the jsonl self-refreshes on every output, the pgid does not,
    // and without it a daemon restart cannot re-adopt the live CLI. Touch it
    // on every scan (60s) for every live session.
    try { const t = new Date(); fs.utimesSync(session.pgidPath, t, t) } catch {}

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

    // ONE authoritative verdict with a source — see deriveSessionProtection.
    const prot = deriveSessionProtection(session, sid, now)

    if (idleMs < SESSION_IDLE_WARNING_MS) {
      // Active — skip
      continue
    } else if (idleMs < prot.killMs) {
      // Warning zone — log but don't kill
      const idleMinutes = Math.round(idleMs / 60_000)
      logMsg('warn', 'idle scan: session idle with no subscribers', {
        sid, pid, idleMinutes,
        protectedBy: prot.source, thresholdMs: prot.killMs, detail: prot.detail,
      })
    } else {
      // Kill zone — no subscribers + no output past threshold. FINAL CHECK
      // before the irreversible kill: the CLI scheduler's own debug log
      // (HOME, survives /tmp wipes). A recent firing/scheduled line means a
      // live loop the fold failed to see (stream file wiped + rebuild, or a
      // tool_result shape change) — refuse to kill, re-check next scan.
      if (prot.source !== 'cron' && hasRecentSchedulerFiring(sid, SESSION_IDLE_KILL_MS)) {
        logMsg('warn', 'idle scan: kill vetoed — CLI scheduler debug log shows recent cron firing', {
          sid, pid, idleMinutes: Math.round(idleMs / 60_000),
        })
        continue
      }
      const idleMinutes = Math.round(idleMs / 60_000)
      logMsg('warn', 'idle scan: killing idle session (no subscribers, no output)', {
        sid, pid, idleMinutes, protectedBy: prot.source, thresholdMs: prot.killMs, detail: prot.detail,
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
          const legacyFold = rebuildFoldStateFromJsonl(jsonlPath)
          sessions.set(sid, {
            proc: null,
            pipePath,
            jsonlPath,
            pgidPath,
            pid,
            // Watcher starts at the fold rebuild's COMPLETE-line boundary — same
            // rule as registry adopt and attach-discover. 0 here would live-fan
            // the entire multi-MB history to the first subscriber AND poison the
            // client cursor (attach reply currentOffset=0 adopted as valid); a
            // raw stat().size would start mid-line (contract §4 boundary rule).
            offset: legacyFold.boundary,
            taskState: rebuildTaskStateFromJsonl(jsonlPath, Date.now()),
            foldState: legacyFold.state,
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
  // Close the cloud bridge first — a half-dead daemon must not keep looking
  // reachable from the phone. bridge.json survives for the successor.
  try { stopBridge() } catch {}

  // Phase C change: preserve running sessions across a graceful daemon
  // restart. The next daemon's reconcileRegistry() will adopt them as
  // orphans via the 1s poll. Previously we killed everything on SIGTERM
  // which defeated the orphan-survival property the plan requires.
  //
  // We still stop the session-bound file tailers so the SSH tunnel can close
  // cleanly, but we leave the CLI process groups alive — the successor daemon
  // will adopt them and spin new watchers on first attach.
  //
  // EXCEPTION — isolated-dir daemons (sandbox/tests/demos): there is never a
  // successor daemon for these dirs, so "preserve for adoption" just leaks CLI
  // process groups forever (25 orphans up to 8 days old found 2026-07-25 — the
  // daemon-level leak fixed by the parent watchdog had moved down to the CLI
  // level via this path). See reapAllSessionGroupsSync + shouldReapOnExit.
  for (const [sid, session] of sessions) {
    stopSessionWatcher(sid)
    // C1: flush a pending coalesced snapshot BEFORE dropping subscribers — the
    // last state change of this daemon's life still reaches the connected
    // walnut instead of dying inside a 50ms timer. Keep in sync with
    // daemon-source.ts cleanup().
    if (session.snapshotTimer) {
      try { pushSnapshot(sid, true) } catch {}
    }
    session.subscribers.clear()
    if (session.orphanPollTimer) {
      try { clearInterval(session.orphanPollTimer) } catch {}
    }
  }

  // Do we still own this daemon dir? A zombie exiting via the heartbeat
  // self-check finds daemon.pid naming its SUCCESSOR — it must touch neither
  // the dir's files nor (crucially) the session process groups the successor
  // has already adopted. Computed BEFORE the reap for exactly that reason.
  let ownsFiles = true
  try {
    const ownerPid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10)
    if (ownerPid > 0 && ownerPid !== process.pid) ownsFiles = false
  } catch {}

  if (ownsFiles && shouldReapOnExit()) reapAllSessionGroupsSync()

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
  if (ownsFiles) {
    try { fs.unlinkSync(PORT_FILE) } catch {}
    try { fs.unlinkSync(PID_FILE) } catch {}
    try { fs.unlinkSync(INSTANCE_ID_FILE) } catch {}
    try { fs.unlinkSync(VERSION_FILE) } catch {}
    // Agent gateway artifacts — a zombie must never delete its successor's
    // live socket/shim, hence inside the ownsFiles guard. Keep in sync with
    // daemon-source.ts cleanup().
    try { fs.unlinkSync(GATEWAY_SOCK_PATH) } catch {}
    try { fs.unlinkSync(GATEWAY_SHIM_PATH) } catch {}
  }
  logMsg('info', 'daemon cleanup complete', { uptimeSec: Math.floor((Date.now() - DAEMON_START_TS) / 1000) })
}

// ── Handle disconnect for a WebSocket client ──
function handleDisconnect(ws: ServerWebSocket<WsData>) {
  wsClients.delete(ws)
  acp.removeSubscriber(ws)

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

// ── Cloud bridge: daemon dials OUT to the cloud companion ──
//
// The bridge makes this daemon reachable from the cloud box WITHOUT the Mac
// relaying: phone → cloud → this socket → handleCommand(). The outbound
// socket is treated as just another authenticated client — inbound frames go
// through the same dispatch, jsonl fan-out reaches it via addSubscriber, so
// the command surface stays identical to the SSH-tunneled path.
//
// Config arrives via the `bridge.configure` RPC (pushed by the Mac after its
// capability handshake) and persists to bridge.json so a restarted daemon
// re-dials on its own — cloud reachability must not depend on the Mac being
// awake. Keep in sync with daemon-source.ts (CLAUDE.md).

const BRIDGE_FILE = path.join(DAEMON_DIR, 'bridge.json')

interface BridgeConfig { enabled: boolean; url: string; token: string; hostAlias: string }

let bridgeConfig: BridgeConfig | null = null
let bridgeClient: WebSocket | null = null
let bridgeAdapter: ServerWebSocket<WsData> | null = null
let bridgeRedialTimer: ReturnType<typeof setTimeout> | null = null
let bridgePingTimer: ReturnType<typeof setInterval> | null = null
let bridgeDialTimer: ReturnType<typeof setTimeout> | null = null
// When the in-flight dial started (null = no dial in flight). Feeds the
// reconcile decision so an identical-config push can't kill a young dial.
let bridgeDialStartedAt: number | null = null
let bridgeBackoffMs = 1000
// Generation guard: every (re)start bumps this; stale socket callbacks and
// queued redials check it and no-op, so an old dial can't fight a new config.
let bridgeGeneration = 0
let bridgeLastInbound = 0

const BRIDGE_BACKOFF_MAX_MS = 60_000
const BRIDGE_PING_INTERVAL_MS = 30_000
// 2 missed 30s pings + margin — half-open sockets get torn down and redialed.
const BRIDGE_SILENCE_MS = 75_000
// A dial that hasn't reached onopen within this window is wedged (TCP up but
// upgrade never completing) — abandon it and redial. Without this a socket
// stuck in CONNECTING was NEVER torn down (the silence watchdog only started
// in onopen), which held the bridge down for days. Env override is for tests.
const BRIDGE_DIAL_TIMEOUT_MS = parseInt(process.env.WALNUT_BRIDGE_DIAL_TIMEOUT_MS || '', 10) || 20_000

function loadBridgeConfig(): void {
  try {
    const raw = JSON.parse(fs.readFileSync(BRIDGE_FILE, 'utf-8')) as BridgeConfig
    if (raw && typeof raw.url === 'string' && typeof raw.token === 'string'
      && typeof raw.hostAlias === 'string') {
      bridgeConfig = raw
    }
  } catch { /* no bridge configured */ }
}

function cmdBridgeConfigure(ws: ServerWebSocket<WsData>, id: number, cmd: Record<string, unknown>) {
  const { url, token, hostAlias, enabled } = cmd as {
    url?: string; token?: string; hostAlias?: string; enabled?: boolean
  }
  if (enabled && (typeof url !== 'string' || typeof token !== 'string' || typeof hostAlias !== 'string')) {
    return sendError(ws, id, 'bridge.configure: url, token, hostAlias required when enabled')
  }
  const next: BridgeConfig = {
    enabled: !!enabled,
    url: url ?? bridgeConfig?.url ?? '',
    token: token ?? bridgeConfig?.token ?? '',
    hostAlias: hostAlias ?? bridgeConfig?.hostAlias ?? '',
  }
  const changed = JSON.stringify(next) !== JSON.stringify(bridgeConfig)
  bridgeConfig = next
  try {
    fs.writeFileSync(BRIDGE_FILE, JSON.stringify(next), { mode: 0o600 })
  } catch (err) {
    logMsg('error', 'bridge: failed to persist bridge.json', { err: (err as Error).message })
  }
  // changed → restart ('configure'). Unchanged but bridge should be up and
  // nothing is working on it → restart ('reconcile') so the Mac's periodic
  // identical push heals a wedged dial. Decision logic: daemon-core.ts.
  const decision = decideBridgeRestart({
    enabled: next.enabled,
    changed,
    adapterConnected: bridgeAdapter != null,
    redialPending: bridgeRedialTimer != null,
    dialAgeMs: bridgeDialStartedAt != null ? Date.now() - bridgeDialStartedAt : null,
    dialTimeoutMs: BRIDGE_DIAL_TIMEOUT_MS,
  })
  if (decision.restart) startBridge(decision.reason)
  logMsg('info', 'bridge: configured', {
    enabled: next.enabled, hostAlias: next.hostAlias, changed,
    restarted: decision.restart ? decision.reason : false,
  })
  sendOk(ws, id, { applied: true, connected: bridgeAdapter != null })
}

function stopBridge(): void {
  bridgeGeneration++
  if (bridgeRedialTimer) { clearTimeout(bridgeRedialTimer); bridgeRedialTimer = null }
  if (bridgePingTimer) { clearInterval(bridgePingTimer); bridgePingTimer = null }
  if (bridgeDialTimer) { clearTimeout(bridgeDialTimer); bridgeDialTimer = null }
  bridgeDialStartedAt = null
  if (bridgeAdapter) { try { handleDisconnect(bridgeAdapter) } catch {} }
  if (bridgeClient) { try { bridgeClient.close() } catch {} }
  bridgeClient = null
  bridgeAdapter = null
}

function startBridge(reason: string): void {
  stopBridge()
  if (!bridgeConfig?.enabled) return
  bridgeBackoffMs = 1000
  logMsg('info', 'bridge: starting', { reason, url: bridgeConfig.url, hostAlias: bridgeConfig.hostAlias })
  dialBridge(bridgeGeneration)
}

function scheduleBridgeRedial(gen: number): void {
  if (gen !== bridgeGeneration || !bridgeConfig?.enabled) return
  // One pending redial at a time — a dial-timeout teardown and a late onclose
  // from the same dead socket must not stack two timers.
  if (bridgeRedialTimer) return
  const jitter = 0.75 + Math.random() * 0.5
  const delay = Math.round(Math.min(bridgeBackoffMs, BRIDGE_BACKOFF_MAX_MS) * jitter)
  bridgeBackoffMs = Math.min(bridgeBackoffMs * 2, BRIDGE_BACKOFF_MAX_MS)
  bridgeRedialTimer = setTimeout(() => {
    bridgeRedialTimer = null
    dialBridge(gen)
  }, delay)
}

// Adapter: presents the outbound client WebSocket as a ServerWebSocket so
// handleCommand/addSubscriber/safeSend work unchanged. The client socket
// buffers internally (browser-style API, never returns 0), so returning
// payload.length keeps safeSend on its fast path — the Bun drain-queue
// backpressure dance only applies to real ServerWebSockets.
function makeBridgeAdapter(client: WebSocket): ServerWebSocket<WsData> {
  const adapter = {
    data: { origin: 'bridge' } as WsData,
    get readyState() { return client.readyState },
    send(payload: string): number {
      try { client.send(payload); return payload.length } catch { return 0 }
    },
    close() { try { client.close() } catch {} },
  }
  return adapter as unknown as ServerWebSocket<WsData>
}

function dialBridge(gen: number): void {
  if (gen !== bridgeGeneration || !bridgeConfig?.enabled) return
  const cfg = bridgeConfig
  let dialUrl: string
  try {
    // Token rides a query param: the browser-style WebSocket client (Bun
    // global + Node 22 global) can't set headers, and the cloud upgrade
    // handler accepts ?token= already.
    const u = new URL(cfg.url)
    u.searchParams.set('token', cfg.token)
    dialUrl = u.toString()
  } catch {
    logMsg('error', 'bridge: invalid url — disabling until reconfigured', { url: cfg.url })
    return
  }

  let client: WebSocket
  try {
    client = new WebSocket(dialUrl)
  } catch (err) {
    logMsg('warn', 'bridge: dial failed', { err: (err as Error).message })
    scheduleBridgeRedial(gen)
    return
  }
  bridgeClient = client
  bridgeDialStartedAt = Date.now()
  // NOTE: bridgeLastInbound is (re)set in onopen — the silence watchdog only
  // starts there; the pre-open window is covered by the dial timeout below.
  // Dial timeout: no onopen within the window → tear down + redial. A socket
  // wedged in CONNECTING fires neither onopen nor onclose, so without this
  // timer the bridge would stay down forever with zero log lines.
  bridgeDialTimer = setTimeout(() => {
    bridgeDialTimer = null
    if (gen !== bridgeGeneration || bridgeAdapter != null) return
    logMsg('warn', 'bridge: dial timeout — abandoning socket', {
      dialMs: bridgeDialStartedAt != null ? Date.now() - bridgeDialStartedAt : null,
    })
    bridgeDialStartedAt = null
    if (bridgeClient === client) bridgeClient = null
    try { client.close() } catch {}
    // Don't rely on close() firing onclose for a wedged socket — schedule
    // directly. scheduleBridgeRedial dedupes if onclose does fire too.
    scheduleBridgeRedial(gen)
  }, BRIDGE_DIAL_TIMEOUT_MS)

  client.onopen = () => {
    if (gen !== bridgeGeneration) { try { client.close() } catch {}; return }
    if (bridgeDialTimer) { clearTimeout(bridgeDialTimer); bridgeDialTimer = null }
    bridgeDialStartedAt = null
    bridgeBackoffMs = 1000
    bridgeLastInbound = Date.now()
    const adapter = makeBridgeAdapter(client)
    bridgeAdapter = adapter
    wsClients.add(adapter)
    // hello registers this host in the cloud bridge registry (first frame).
    safeSend(adapter, JSON.stringify({
      ev: 'hello',
      hostAlias: cfg.hostAlias,
      version: DAEMON_VERSION,
      instanceId: DAEMON_INSTANCE_ID,
      sids: [...sessions.keys()],
    }))
    logMsg('info', 'bridge: connected', { hostAlias: cfg.hostAlias, wsId: wsId(adapter) })
    bridgePingTimer = setInterval(() => {
      if (gen !== bridgeGeneration) return
      if (Date.now() - bridgeLastInbound > BRIDGE_SILENCE_MS) {
        // Half-open link: the cloud stopped answering. close() triggers
        // onclose → redial with backoff.
        logMsg('warn', 'bridge: inbound silence — tearing down', {
          silentMs: Date.now() - bridgeLastInbound,
        })
        try { client.close() } catch {}
        return
      }
      safeSend(adapter, JSON.stringify({ ev: 'bridge-ping', ts: Date.now() }))
    }, BRIDGE_PING_INTERVAL_MS)
  }

  client.onmessage = (e: MessageEvent) => {
    if (gen !== bridgeGeneration || !bridgeAdapter) return
    bridgeLastInbound = Date.now()
    const msg = typeof e.data === 'string' ? e.data : Buffer.from(e.data as ArrayBuffer).toString()
    handleCommand(bridgeAdapter, msg)
  }

  client.onclose = () => {
    if (gen !== bridgeGeneration) return
    // Late close from a socket the dial timeout already abandoned — a newer
    // dial may be in flight; don't clobber its state.
    // LOAD-BEARING with scheduleBridgeRedial's dedupe: after the dial timeout
    // sets bridgeClient=null there is a window where this guard passes
    // (bridgeClient===null) and the late close falls through to
    // scheduleBridgeRedial — only the "if (bridgeRedialTimer) return" dedupe
    // stops a SECOND stacked redial then. Change either side only in tandem.
    if (bridgeClient !== null && bridgeClient !== client) return
    if (bridgeDialTimer) { clearTimeout(bridgeDialTimer); bridgeDialTimer = null }
    bridgeDialStartedAt = null
    if (bridgePingTimer) { clearInterval(bridgePingTimer); bridgePingTimer = null }
    if (bridgeAdapter) { try { handleDisconnect(bridgeAdapter) } catch {}; bridgeAdapter = null }
    bridgeClient = null
    logMsg('info', 'bridge: disconnected — redialing', { nextBackoffMs: bridgeBackoffMs })
    scheduleBridgeRedial(gen)
  }

  client.onerror = () => { /* onclose always follows */ }
}

// ── Main ──
const action = process.argv[2]

// `wn` mode: the same binary doubles as the peer-session CLI (zero extra
// deploy artifacts — the on-PATH `wn` is a 2-line shim exec'ing this binary).
// Dynamic import keeps the daemon startup path free of CLI code; bun bundles
// the literal specifier into the compiled binary.
if (action === 'wn') {
  const { runWnCli } = await import('./wn-cli.js')
  process.exit(await runWnCli(process.argv.slice(3)))
}

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

  ensureOwnerOnlyStorage()

  // Move dead-session stream files from the legacy /tmp location into the
  // reboot-surviving HOME dir. MUST run before reconcileRegistry: adopted
  // sessions resolve their files by the registry's absolute paths, and the
  // pgid scan below walks STREAMS_DIR.
  try { migrateLegacyStreams() } catch (err) {
    logMsg('error', 'legacy streams migration failed', { error: (err as Error).message })
  }

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

  // ACP startup repair: workers from a previous daemon life are dead by
  // definition (in-process model). Sweep stragglers + close un-ended turns /
  // un-answered permissions in every ACP journal so the UI never shows a
  // stuck spinner. See acp-daemon.ts startupRepair.
  try { acp.startupRepair() } catch (err) {
    logMsg('error', 'acp startupRepair failed', { error: (err as Error).message })
  }

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

  // Agent gateway: second (unix-socket) listener + on-PATH `wn` shim. Both
  // additive — failures log a warning and never abort daemon startup.
  startGatewayListener()
  writeWnShim()

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
    // Retry policy is read from the env ONCE at boot, so log it here: this line
    // is the only way to answer "is this daemon actually retrying, and with what
    // budget?" without shell access to its environ.
    turnRetry: TURN_RETRY_CFG.enabled
      ? { budgetMs: TURN_RETRY_CFG.budgetMs, maxAttempts: TURN_RETRY_CFG.maxAttempts,
          backoffBaseMs: TURN_RETRY_CFG.backoffBaseMs, backoffMaxMs: TURN_RETRY_CFG.backoffMaxMs }
      : false,
  })

  // Start session idle scanner (every 60s)
  setInterval(scanIdleSessions, SESSION_SCAN_INTERVAL_MS)

  // Dead-stream retention: hourly sweep of >7d-idle files for sids with no
  // live session/process. First pass shortly after startup (not immediately —
  // let reconcile finish adopting before judging liveness by the map).
  setTimeout(sweepDeadStreams, 60_000)
  setInterval(sweepDeadStreams, STREAM_RETENTION_SWEEP_MS)

  // Cloud bridge self-heal: a persisted bridge.json re-dials without waiting
  // for the Mac to push bridge.configure again.
  loadBridgeConfig()
  startBridge('startup')

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
    // Parent-liveness watchdog: isolated-dir daemons (tests, sandbox, demos)
    // are spawned with WALNUT_DAEMON_PARENT_PID and serve exactly one walnut
    // process — when it's gone we're an orphan burning RAM. 300+ leaked test
    // daemons once starved the whole machine (2026-07-23). Production daemons
    // never get the var (parentWatchdogEnv in local-daemon.ts), so surviving
    // server restarts is unaffected. Keep in sync with daemon-source.ts.
    if (WATCHDOG_PARENT_PID) {
      let parentAlive = true
      try { process.kill(WATCHDOG_PARENT_PID, 0) } catch { parentAlive = false }
      if (!parentAlive) {
        logMsg('warn', 'parent-liveness watchdog: parent process gone — exiting', {
          parentPid: WATCHDOG_PARENT_PID,
        })
        cleanup()
        process.exit(0)
      }
    }
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
  console.error('Usage: bun daemon-standalone.ts --start | --stop | --status | --version | wn <args...>')
  process.exit(1)
}
