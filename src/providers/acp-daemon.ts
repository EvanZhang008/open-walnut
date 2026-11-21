/**
 * ACP worker supervision for the walnut-daemon (in-process model).
 *
 * The daemon spawns one detached process-group leader per ACP session.
 * This module owns:
 *   - worker spawn + NDJSON JSON-RPC over the worker's stdio
 *   - journal tailing → 'jsonl' push frames to subscribers (v = byte offset,
 *     identical framing to native sessions)
 *   - idle reaping (daemon-owned timer, per plan)
 *   - startup repair: scan journal tails for un-ended turns / un-answered
 *     permissions from a previous daemon life and append the closing meta
 *     facts, so the UI never shows a stuck spinner or dead approval button
 *   - a pid file used ONLY as a belt-and-suspenders kill sweep at startup
 *     (the journal, not the pid registry, drives repair)
 *
 * A worker started with `survive` ('acp-survive-v1', acp-survive.ts) talks to the daemon over a
 * named pipe and a file instead of its stdio, so it (its adapter, the provider's turn, the tools
 * it runs) outlives the daemon; the next daemon adopts it by its pid and start time (startupRepair)
 * and reads its answers on. Such a worker holds no update (acp-busy.json, holdingWorkers) and is
 * listed for a rollback's stop (detached-registry.ts); a worker on stdio dies with its daemon and
 * is repaired and swept at the next start, as before.
 *
 * Dependency-injected (like daemon-core.ts) so the bun-compiled standalone
 * daemon wires in its Bun-specific ws/send helpers; daemon-source.ts loads it as
 * the acp-daemon-core.cjs sidecar.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import readline from 'node:readline'
import { StringDecoder } from 'node:string_decoder'
import { mergeAcpSpawnEnv, type AcpMcpServer } from './acp-worker/protocol.js'
import type { ChildProcessUse } from './daemon-child-spawn.js'
import { probeCodexModels } from './codex-model-probe.js'
import { findThreadToRestore } from './acp-thread-restore.js'
import { createHostEngineProbe, resolveHostAcpArtifacts, type AcpHostAdapterSpec } from './acp-host-artifacts.js'
import { firstRpcId, openSurviveChannel, prepareSurviveFiles, readSavedPos, removeSurviveFiles, survivePaths, type SurviveChannel } from './acp-survive.js'
import { ROLLBACK_NOTE, installStopScript, processStart as psStart, registerRun, registryFile, unregisterRun } from './detached-registry.js'

const ACP_IDLE_KILL_MS = 2 * 60 * 60 * 1000   // mirror native SESSION_IDLE_KILL_MS
// A turn parked on a permission request produces ZERO journal/RPC traffic, so
// lastActivity goes stale while the user simply hasn't answered yet. Killing
// at 2h writes turn-interrupted:shutdown + auto-cancels the permission — the
// 4th "idle reaper kills live work" blind spot (cron, bg task, …). While a
// turn or control prompt is open, only a much larger safety ceiling applies.
const ACP_TURN_OPEN_KILL_MS = 24 * 60 * 60 * 1000
const ACP_SWEEP_INTERVAL_MS = 60 * 1000
const OP_TIMEOUT_MS = 120_000                  // session/load against a real provider can be slow
const CANCEL_RPC_TIMEOUT_MS = 1_000
/** A worker that stops its turn itself (a direct Codex session: turn/interrupt) gets this long before the hard abort. */
const GRACEFUL_CANCEL_RPC_TIMEOUT_MS = 15_000
const ABORT_WAIT_MS = 750
const KILL_GRACE_MS = 750

interface AcpWorkerEntry<W> {
  sid: string
  /** The worker as this daemon spawned it; absent for one adopted after a restart (survive). */
  proc?: ChildProcess
  /** Its pid (the process group it leads). */
  pid?: number
  /** It has exited (its exit was seen, or an adopted one is gone). */
  exited: () => boolean
  /** Write one request line to it (its stdin, or its pipe). */
  send: (line: string, done: (err?: Error) => void) => void
  /** Survives this daemon (acp-survive.ts): its channel. */
  survive?: SurviveChannel
  /** Where it was started (absent on a worker adopted from an older daemon): task directory cleanup keeps the folder it works in. */
  cwd?: string
  /** Its task's directory (WALNUT_TASK_DIR), kept whole while it runs even when it works in a shared checkout. */
  taskDir?: string
  journalPath: string
  /** Byte offset up to which we've pushed journal lines to subscribers. */
  pushOffset: number
  subscribers: Set<W>
  pendingRpc: Map<number, { resolve: (resp: WorkerRpcResponse) => void; timer: ReturnType<typeof setTimeout> }>
  nextRpcId: number
  lastActivity: number
  state: 'running' | 'dead'
  stopping: boolean
  aborting: boolean
  terminalVersion: number
  activeCommandId: string | null
  activeControlCommandId: string | null
  /**
   * The worker ends a turn itself and lives on (its initialize said `_meta.walnut.gracefulCancel`):
   * a stop waits for that before tearing the process group down.
   */
  gracefulCancel?: boolean
  /** The worker's own name (its script's basename), its adapter's command and its start time, kept in the pid file. */
  cmd: string
  adapter: string
  start?: string
  /** A light subagent's own bounds (AcpStartParams.deadlineAt / orphanGraceMs). */
  deadlineAt?: number
  orphanGraceMs?: number
  /** Since when no socket has subscribed to it (only kept with orphanGraceMs). */
  orphanedSince?: number
  /** Its start as the rollback stop compares it (detached-registry.ts processStart). */
  registryStart?: string
}

/** What `ps` says about one pid now; 'unknown' when it could not be asked. */
export type AcpProcessInfo = { state: 'gone' } | { state: 'alive'; start: string; command: string } | { state: 'unknown' }

/** A pid file row: a pid alone (older daemons), or the pid with what identifies its worker. */
type PidRow = number | { pid: number; cmd?: string; adapter?: string; start?: string; boot?: number; stopping?: boolean; survive?: boolean; cwd?: string; taskDir?: string; deadlineAt?: number; orphanGraceMs?: number }

/** When this host booted, in minutes (uptime moves a little; two minutes apart is the same boot). */
function bootMinute(): number { return Math.round((Date.now() / 1000 - os.uptime()) / 60) }

interface WorkerRpcResponse { id: number; ok: boolean; result?: unknown; error?: { kind: string; message: string } }

export interface AcpDaemonDeps<W> {
  streamsDir: string
  daemonDir: string
  sendEvent: (ws: W, ev: string, data: Record<string, unknown>) => void
  isWsOpen: (ws: W) => boolean
  log: (level: string, msg: string, data?: Record<string, unknown>) => void
  idleKillMs?: number
  cancelRpcTimeoutMs?: number
  abortWaitMs?: number
  killGraceMs?: number
  setIntervalFn?: typeof setInterval
  /** A worker's turn ended (the session budget prices it at once). */
  onTurnEnd?: (sid: string) => void
  /** Who a pid is now (tests stub it); default asks `ps`. */
  processInfo?: (pid: number) => Promise<AcpProcessInfo>
  /** The commands of the processes in one process group, null when ps gives no answer (tests stub it). */
  groupCommands?: (pgid: number) => Promise<string[] | null>
  /** This host's boot (tests stub it). */
  bootMinute?: () => number
  /**
   * Where the remote deploy put the ACP worker and bundled adapters
   * (acp-host-artifacts.ts). Set = this daemon resolves a session's commands itself
   * when the primary sends `hostAdapter` instead of paths of its own install.
   */
  artifactDir?: string
  /** The names of those files in `artifactDir` when they are not the host names (acp-host-artifacts.ts). */
  artifactNames?: Readonly<Record<string, string>>
  /** Read right before a worker spawns; false refuses it (a Demo's demo.quiesce fence). Absent = always. */
  maySpawn?: () => boolean
  strictStop?: () => boolean
  /** Where surviving workers are listed for a rollback's stop (detached-registry.ts); default `<daemonDir>/detached`. */
  registryDir?: string
  /** What ps names as a pid's start, as the rollback stop compares it (tests stub it). */
  registryStart?: (pid: number) => Promise<string | null>
  /**
   * How this daemon starts its children (workers, ps, mkfifo, the engine probes) and the env a
   * worker's env is built from: the daemon runtime's own; default node's and process.env.
   */
  childProcess?: ChildProcessUse<'spawn' | 'execFile'>
}

function psField(pid: number, field: string, run: typeof execFile): Promise<string | null | undefined> {
  return new Promise((resolve) => {
    run('ps', ['-ww', '-o', `${field}=`, '-p', String(pid)], { timeout: 5_000 }, (error, stdout, stderr) => {
      const out = String(stdout ?? '').trim()
      // ps answers 1 with nothing at all for a pid that is not there; anything else
      // (a usage message from a ps without these options, a timeout) is no answer.
      if (error) resolve((error as { code?: unknown }).code === 1 && !out && !String(stderr ?? '').trim() ? null : undefined)
      else resolve(out || null)
    })
  })
}

function psGroupCommands(pgid: number, run: typeof execFile = execFile): Promise<string[] | null> {
  return new Promise((resolve) => {
    run('ps', ['-A', '-ww', '-o', 'pgid=', '-o', 'command='], { timeout: 5_000, maxBuffer: 16 << 20 }, (error, stdout) => {
      if (error) return resolve(null)
      const out: string[] = []
      for (const line of String(stdout).split('\n')) {
        const m = /^\s*(\d+)\s+(.*)$/.exec(line)
        if (m && Number(m[1]) === pgid) out.push(m[2])
      }
      resolve(out)
    })
  })
}

async function psProcessInfo(pid: number, run: typeof execFile = execFile): Promise<AcpProcessInfo> {
  const start = await psField(pid, 'lstart', run)
  if (start === undefined) return { state: 'unknown' }
  if (start === null) return { state: 'gone' }
  const command = await psField(pid, 'command', run)
  if (command === undefined) return { state: 'unknown' }
  return command === null ? { state: 'gone' } : { state: 'alive', start, command }
}

/** ps with no answer when a surviving worker is adopted is asked again this many times, this far apart. */
const ADOPT_PS_TRIES = 5
const ADOPT_PS_RETRY_MS = 1_000

export interface AcpStartParams {
  sid: string
  cwd: string
  /** Full command vector for the worker process, e.g. [nodePath, workerMainJs]. */
  workerCmd?: string[]
  /** Full command vector for the adapter, e.g. [nodePath, codexAcpIndexJs]. */
  adapterCmd?: string[]
  /** Instead of the two commands: the adapter's description, resolved on this host (acp-host-artifacts.ts). */
  hostAdapter?: AcpHostAdapterSpec
  env?: Record<string, string>
  /** Present = resume: worker loadSession(providerSessionId); absent = newSession. */
  providerSessionId?: string
  /** Journal replay cursor for the subscribing ws (default 0). */
  fromOffset?: number
  /**
   * MCP servers the provider should mount for this session (e.g. the walnut
   * task tools). Forwarded verbatim to the worker's newSession/loadSession;
   * absent = none, which is the pre-mount behavior.
   */
  mcpServers?: AcpMcpServer[]
  /**
   * A light subagent's worker (core/subagents) bounds itself on this host: it is stopped
   * past this time (epoch ms), and once nothing has subscribed to it for orphanGraceMs (its
   * server went away mid-run). A task session's worker passes neither. An older daemon
   * ignores both; its server stops the run itself.
   */
  deadlineAt?: number
  orphanGraceMs?: number
  /**
   * The worker outlives this daemon ('acp-survive-v1', acp-survive.ts): requests over a named pipe,
   * answers in a file, adopted by the next daemon. Asked for by the server only with the
   * experiment `work_survives_restart` on; an older daemon ignores it (the worker uses its stdio).
   */
  survive?: boolean
}

export function createAcpDaemon<W>(deps: AcpDaemonDeps<W>) {
  const { streamsDir, daemonDir, sendEvent, isWsOpen, log } = deps
  const idleKillMs = deps.idleKillMs ?? ACP_IDLE_KILL_MS
  const cancelRpcTimeoutMs = deps.cancelRpcTimeoutMs ?? CANCEL_RPC_TIMEOUT_MS
  const abortWaitMs = deps.abortWaitMs ?? ABORT_WAIT_MS
  const killGraceMs = deps.killGraceMs ?? KILL_GRACE_MS
  const setIntervalFn = deps.setIntervalFn ?? setInterval
  const workers = new Map<string, AcpWorkerEntry<W>>()
  // A stopping worker that exited while its process group lives on: kept (also in the pid file) until that group is gone.
  const exitedGroups = new Map<string, { pid: number; cmd: string; adapter: string; boot: number; start?: string }>()
  const pidFile = path.join(daemonDir, 'acp-workers.json')
  const use = deps.childProcess ?? {}
  const baseEnv = use.env ?? process.env
  const processInfo = deps.processInfo ?? ((pid: number) => psProcessInfo(pid, use.execFile))
  // Every request id of this daemon life is at least this (acp-survive.ts firstRpcId): a lower one is an earlier life's.
  const lifeFirstRpcId = firstRpcId()
  const groupCommands = deps.groupCommands ?? ((pgid: number) => psGroupCommands(pgid, use.execFile))
  const boot = deps.bootMinute ?? bootMinute
  const registryDir = deps.registryDir ?? path.join(daemonDir, 'detached')
  const registryStart = deps.registryStart ?? ((pid: number) => psStart(pid, use))
  // Workers still being adopted at startup: a start, an op or a subscribe for one waits for it.
  const adopting = new Map<string, Promise<void>>()
  let stopScriptPut = false
  // Rows of surviving workers not settled yet (being adopted, or ps could not say): kept in the pid file.
  const keptRows = new Map<string, Exclude<PidRow, number>>()
  ensureOwnerOnlyAcpStorage()

  function journalPathFor(sid: string): string {
    return path.join(streamsDir, sid + '.acp.jsonl')
  }

  function ensureOwnerOnlyAcpStorage(): void {
    for (const dir of [daemonDir, streamsDir]) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
      fs.chmodSync(dir, 0o700)
    }
    if (fs.existsSync(pidFile)) fs.chmodSync(pidFile, 0o600)
  }

  function repairJournalMode(journalPath: string): void {
    fs.mkdirSync(path.dirname(journalPath), { recursive: true, mode: 0o700 })
    fs.chmodSync(path.dirname(journalPath), 0o700)
    if (fs.existsSync(journalPath)) fs.chmodSync(journalPath, 0o600)
  }

  // ── pid file (kill-sweep only; journal drives repair) ──

  function persistPids(): void {
    const out: Record<string, PidRow> = {}
    for (const [sid, w] of workers) {
      if (w.state === 'running' && w.pid) {
        out[sid] = {
          pid: w.pid, cmd: w.cmd, adapter: w.adapter, boot: boot(), ...(w.start ? { start: w.start } : {}),
          // What the next daemon needs to adopt it.
          ...(w.survive ? { survive: true, ...(w.cwd ? { cwd: w.cwd } : {}), ...(w.taskDir ? { taskDir: w.taskDir } : {}), ...(w.deadlineAt ? { deadlineAt: w.deadlineAt } : {}), ...(w.orphanGraceMs ? { orphanGraceMs: w.orphanGraceMs } : {}) } : {}),
        }
      }
    }
    for (const [sid, row] of keptRows) if (!out[sid]) out[sid] = row
    // A running worker of the same runtime wins the row; its stopped group stays in memory.
    for (const [sid, g] of exitedGroups) if (!out[sid]) out[sid] = { pid: g.pid, cmd: g.cmd, adapter: g.adapter, boot: g.boot, ...(g.start ? { start: g.start } : {}), stopping: true }
    try {
      fs.writeFileSync(pidFile, JSON.stringify(out), { mode: 0o600 })
      fs.chmodSync(pidFile, 0o600)
    } catch {}
  }

  // ── worker RPC ──

  function rpc(
    entry: AcpWorkerEntry<W>,
    op: string,
    params?: Record<string, unknown>,
    timeoutMs = OP_TIMEOUT_MS,
  ): Promise<WorkerRpcResponse> {
    const id = entry.nextRpcId++
    entry.lastActivity = Date.now()
    return new Promise<WorkerRpcResponse>((resolve) => {
      const timer = setTimeout(() => {
        entry.pendingRpc.delete(id)
        resolve({ id, ok: false, error: { kind: 'internal', message: `worker op timeout: ${op}` } })
      }, timeoutMs)
      entry.pendingRpc.set(id, { resolve, timer })
      try {
        entry.send(JSON.stringify({ id, op, params }) + '\n', (err) => {
          // The bytes never reached the worker (EPIPE: it stopped reading). Only this
          // request fails now; the others may still be answered, or the reap fails them.
          if (!err) return
          const pending = entry.pendingRpc.get(id)
          if (!pending) return
          clearTimeout(pending.timer)
          entry.pendingRpc.delete(id)
          pending.resolve({ id, ok: false, error: { kind: 'internal', message: `worker stdin write failed: ${err.message}` } })
        })
      } catch (e) {
        clearTimeout(timer)
        entry.pendingRpc.delete(id)
        resolve({ id, ok: false, error: { kind: 'internal', message: `worker stdin write failed: ${(e as Error).message}` } })
      }
    })
  }

  // ── journal streaming (event-driven off worker notifications, no poll) ──

  function pushJournal(entry: AcpWorkerEntry<W>, toOffset: number): void {
    if (toOffset <= entry.pushOffset) return
    let buf: Buffer
    try {
      const fd = fs.openSync(entry.journalPath, 'r')
      try {
        buf = Buffer.alloc(toOffset - entry.pushOffset)
        fs.readSync(fd, buf, 0, buf.length, entry.pushOffset)
      } finally { fs.closeSync(fd) }
    } catch { return }
    const text = buf.toString('utf-8')
    let lineStart = entry.pushOffset
    for (const line of text.split('\n')) {
      const v = lineStart + Buffer.byteLength(line, 'utf-8') + 1
      const lineOffset = lineStart
      lineStart = v
      if (v > toOffset) break // trailing partial line — not yet durable
      if (!line.trim()) continue
      trackJournalLifecycle(entry, line)
      for (const ws of entry.subscribers) {
        if (isWsOpen(ws)) { try { sendEvent(ws, 'jsonl', { sid: entry.sid, line, v }) } catch {} }
      }
      void lineOffset
    }
    entry.pushOffset = Math.min(toOffset, lineStart)
    entry.lastActivity = Date.now()
  }

  function trackJournalLifecycle(entry: AcpWorkerEntry<W>, line: string): void {
    let record: {
      kind?: string
      event?: { type?: string; commandId?: string }
    }
    try { record = JSON.parse(line) } catch { return }
    if (record.kind !== 'meta' || !record.event) return
    if (record.event.type === 'prompt-dispatched' || record.event.type === 'turn-started') {
      entry.activeCommandId = record.event.commandId ?? null
      writeBusyFile()
      if (entry.survive) void listSurvivor(entry)
    } else if (record.event.type === 'turn-ended' || record.event.type === 'turn-interrupted') {
      entry.terminalVersion++
      entry.activeCommandId = null
      writeBusyFile()
      if (entry.survive) void listSurvivor(entry)
      try { deps.onTurnEnd?.(entry.sid) } catch { /* A budget check never breaks the journal. */ }
    } else if (record.event.type === 'control-prompt-accepted') {
      entry.activeControlCommandId = record.event.commandId ?? null
      writeBusyFile()
      if (entry.survive) void listSurvivor(entry)
    } else if (record.event.type === 'control-ended') {
      entry.terminalVersion++
      entry.activeControlCommandId = null
      writeBusyFile()
      if (entry.survive) void listSurvivor(entry)
    }
  }

  /**
   * Advertise which ACP workers currently hold an OPEN turn so the walnut
   * server can defer a version-upgrade daemon restart instead of killing live
   * work (every dev:prod deploy used to write turn-interrupted:shutdown into
   * whatever the user was running). Refreshed on every lifecycle change and
   * every sweep tick; readers treat a stale updatedAt (daemon died) as not
   * busy, so this can never wedge upgrades.
   */
  function writeBusyFile(): void {
    // A surviving worker's turn outlives the daemon: it holds no update.
    const busySids = [...workers.values()]
      .filter((e) => e.state === 'running' && !e.survive && (e.activeCommandId !== null || e.activeControlCommandId !== null))
      .map((e) => e.sid)
    try {
      fs.writeFileSync(
        path.join(daemonDir, 'acp-busy.json'),
        JSON.stringify({ busySids, updatedAt: Date.now() }),
        { mode: 0o600 },
      )
    } catch {}
  }

  function replayTo(ws: W, entry: AcpWorkerEntry<W>, fromOffset: number): void {
    const upTo = entry.pushOffset
    if (fromOffset >= upTo) return
    let buf: Buffer
    try {
      const fd = fs.openSync(entry.journalPath, 'r')
      try {
        buf = Buffer.alloc(upTo - fromOffset)
        fs.readSync(fd, buf, 0, buf.length, fromOffset)
      } finally { fs.closeSync(fd) }
    } catch { return }
    let lineStart = fromOffset
    for (const line of buf.toString('utf-8').split('\n')) {
      const v = lineStart + Buffer.byteLength(line, 'utf-8') + 1
      lineStart = v
      if (v > upTo || !line.trim()) continue
      if (isWsOpen(ws)) { try { sendEvent(ws, 'jsonl', { sid: entry.sid, line, v }) } catch {} }
    }
  }

  // ── lifecycle ──

  function reapWorker(sid: string, reason: string): void {
    const entry = workers.get(sid)
    if (!entry || entry.state === 'dead') return
    entry.state = 'dead'
    for (const { timer, resolve } of entry.pendingRpc.values()) {
      clearTimeout(timer)
      resolve({ id: -1, ok: false, error: { kind: 'internal', message: 'worker died: ' + reason } })
    }
    entry.pendingRpc.clear()
    // Push whatever the worker managed to journal before dying.
    try { pushJournal(entry, fs.statSync(entry.journalPath).size) } catch {}
    // Unexpected death mid-turn: the worker may not have gotten to append its
    // own interrupted meta (SIGKILL). Repair this journal now, then tell subscribers.
    if (!entry.stopping) repairJournalTail(entry.journalPath, 'worker-crash')
    try { pushJournal(entry, fs.statSync(entry.journalPath).size) } catch {}
    for (const ws of entry.subscribers) {
      if (isWsOpen(ws)) { try { sendEvent(ws, 'acp_state', { sid, state: 'dead', reason }) } catch {} }
    }
    if (entry.pid && !entry.exited()) {
      signalProcessGroup(entry.pid, 'SIGKILL')
    }
    if (deps.strictStop?.() && entry.stopping && entry.pid && isProcessGroupAlive(entry.pid)) {
      exitedGroups.set(sid, { pid: entry.pid, cmd: entry.cmd, adapter: entry.adapter, boot: boot(), ...(entry.start ? { start: entry.start } : {}) })
    }
    if (entry.survive) {
      entry.survive.close()
      void removeSurviveFiles(survivePaths(streamsDir, sid))
      void unregisterRun(registryDir, 'acp', sid)
    }
    workers.delete(sid)
    persistPids()
    writeBusyFile()
    log('info', 'acp: worker reaped', { sid, reason })
  }

  /** One line from a worker (its stdout, or a surviving worker's out file): a journal notice, a report, or an answer. */
  function onWorkerLine(entry: AcpWorkerEntry<W>, line: string): void {
    const sid = entry.sid
    if (!line.trim()) return
    let msg: { id?: number; ev?: string; offset?: number; bytes?: number; op?: string; kind?: string; detail?: string }
    try { msg = JSON.parse(line) } catch { return }
    if (msg.ev === 'journal' && typeof msg.offset === 'number') {
      pushJournal(entry, msg.offset)
      return
    }
    if (msg.ev === 'provider_error' && typeof msg.detail === 'string') {
      // The provider's own words (redacted by the worker): the one place they
      // are kept, so a failure the chat shows only as a category can be explained.
      log('warn', 'acp: provider error', { sid, op: msg.op, kind: msg.kind, detail: msg.detail })
      return
    }
    if (msg.ev === 'adapter_stderr' && typeof msg.bytes === 'number') {
      log('debug', 'acp worker stderr', { sid, bytes: msg.bytes })
      return
    }
    if (typeof msg.id === 'number') {
      const pending = entry.pendingRpc.get(msg.id)
      if (pending) {
        entry.pendingRpc.delete(msg.id)
        clearTimeout(pending.timer)
        entry.lastActivity = Date.now()
        pending.resolve(msg as WorkerRpcResponse)
      } else if (entry.survive && msg.id > 0 && msg.id < entry.nextRpcId) {
        // An answer to a request nobody waits for: an earlier daemon's (its caller was told its link
        // was lost, the result unknown), or this life's that came after its wait ended. What it did is
        // in the journal.
        log('info', msg.id < lifeFirstRpcId ? 'acp: answer to a request of an earlier daemon life' : 'acp: answer to a request whose wait had ended', { sid, id: msg.id, ok: (msg as { ok?: unknown }).ok === true })
      }
    }
  }

  /** The registry entry a rollback's stop reads (detached-registry.ts): the open turn is closed as a rollback. */
  async function listSurvivor(entry: AcpWorkerEntry<W>): Promise<void> {
    if (!entry.pid || entry.state !== 'running') return
    if (!stopScriptPut) { stopScriptPut = true; void installStopScript(registryDir) }
    entry.registryStart ??= await registryStart(entry.pid) ?? undefined
    if (!entry.registryStart || entry.state !== 'running') return
    const open = entry.activeCommandId ?? entry.activeControlCommandId
    const event = entry.activeControlCommandId
      ? { type: 'control-ended', commandId: entry.activeControlCommandId, stopReason: 'rollback' }
      : { type: 'turn-interrupted', reason: 'rollback', ...(open ? { commandId: open } : {}) }
    await registerRun(registryDir, {
      kind: 'acp', id: entry.sid, pid: entry.pid, pgid: entry.pid, lstart: entry.registryStart,
      // With no turn open, a rollback leaves nothing in the journal: the next start reloads the thread.
      ...(open ? { lineFile: entry.journalPath, line: JSON.stringify({ kind: 'meta', ts: Date.now(), event }) } : {}),
      noteFile: survivePaths(streamsDir, entry.sid).err, note: `walnut: ${ROLLBACK_NOTE}`,
    })
    if (entry.state !== 'running') await unregisterRun(registryDir, 'acp', entry.sid)
  }

  /** Workers on stdio: they end with this daemon, so a swap waits for their turns (a surviving one does not). */
  function holdingWorkers(): number {
    let n = 0
    for (const e of workers.values()) if (e.state === 'running' && !e.survive) n++
    return n
  }

  /**
   * The next daemon here cannot adopt surviving workers (a rollback): each is ended now, its open
   * turn closed as interrupted by the rollback (the projector says so), its permissions cancelled.
   */
  async function endForRollback(): Promise<number> {
    const going = [...workers.values()].filter((e) => e.state === 'running' && e.survive)
    // All at once (each stop waits its grace), so several workers never hold the handover's reply.
    await Promise.all(going.map(async (entry) => {
      try {
        entry.stopping = true
        entry.aborting = true
        if (entry.pid) await terminateProcessGroup(entry.pid)
        try { await entry.survive?.drain() } catch { /* read what it wrote */ }
        try { pushJournal(entry, fs.statSync(entry.journalPath).size) } catch {}
        repairJournalTail(entry.journalPath, 'rollback')
      } finally { reapWorker(entry.sid, 'rollback') }
    }))
    return going.length
  }

  /**
   * A start, op or subscribe for a worker still being adopted waits for it. One whose adoption was
   * left open (ps gave no answer) is tried again now; while it stays open the caller is refused
   * (`worker_adopting`), never given a second worker on the same session.
   */
  async function adopted(sid: string): Promise<boolean> {
    const a = adopting.get(sid)
    if (a) await a
    const row = keptRows.get(sid)
    if (!row || workers.has(sid)) return true
    // One look on a caller's path (the caller asks again while it stays open: acp-ask-once.ts untilAdopted).
    if (!adopting.has(sid)) adopting.set(sid, adoptOne(sid, row, 1))
    await adopting.get(sid)
    return !keptRows.has(sid) || workers.has(sid)
  }
  const adoptingRefusal = (sid: string) => ({ ok: false as const, errorKind: 'worker_adopting', error: `the ACP worker for ${sid} outlived its daemon and could not be checked yet; try again shortly` })

  async function listedStart(sid: string): Promise<string | null> {
    try { return /^lstart=(.*)$/m.exec(await fs.promises.readFile(registryFile(registryDir, 'acp', sid), 'utf8'))?.[1] ?? null } catch { return null }
  }

  async function acpStart(ws: W, params: AcpStartParams): Promise<{ ok: boolean; result?: Record<string, unknown>; error?: string; errorKind?: string }> {
    const { sid, cwd, providerSessionId, mcpServers } = params
    let { workerCmd, adapterCmd, env } = params
    if (!(await adopted(sid))) return adoptingRefusal(sid)
    const existing = workers.get(sid)
    if (existing && existing.state === 'running') {
      existing.subscribers.add(ws)
      existing.orphanedSince = undefined
      replayTo(ws, existing, params.fromOffset ?? 0)
      const state = await rpc(existing, 'getState')
      return {
        ok: true,
        result: {
          alive: true,
          state: state.result,
          journalPath: existing.journalPath,
        },
      }
    }

    if ((!Array.isArray(workerCmd) || workerCmd.length === 0) && params.hostAdapter) {
      const resolved = resolveHostAcpArtifacts(params.hostAdapter, { artifactDir: deps.artifactDir, artifactNames: deps.artifactNames, env: use.env })
      if (!resolved.ok) return { ok: false, error: resolved.error, errorKind: resolved.errorKind }
      workerCmd = resolved.workerCmd
      adapterCmd = resolved.adapterCmd
      // What this host found (CODEX_PATH) wins over anything the primary sent.
      env = { ...(env ?? {}), ...resolved.env }
      log('info', 'acp: commands resolved on this host', { sid, engine: params.hostAdapter.engine, adapter: adapterCmd.join(' ') })
    }
    if (!Array.isArray(workerCmd) || workerCmd.length === 0) return { ok: false, error: 'acpStart: missing workerCmd' }
    if (!Array.isArray(adapterCmd) || adapterCmd.length === 0) return { ok: false, error: 'acpStart: missing adapterCmd' }

    const journalPath = journalPathFor(sid)
    repairJournalMode(journalPath)
    // Where a cold start's time goes, for the start log line and the caller's own (acp-session.ts).
    const startedAt = Date.now()
    let proc: ChildProcess
    if (deps.maySpawn && !deps.maySpawn()) return { ok: false, error: 'acpStart: Demo is stopping; no new worker starts', errorKind: 'demo_stopping' }
    const survive = params.survive === true
    const paths = survivePaths(streamsDir, sid)
    // This daemon's end of a surviving worker's pipe, opened before the worker started (acp-survive.ts).
    let survivePipeFd: number | null = null
    try {
      // A surviving worker reads its pipe and writes its files (acp-survive.ts), never this daemon's pipes.
      const files = survive ? await prepareSurviveFiles(paths, use) : null
      survivePipeFd = files ? files.inFd : null
      // The files took an await: a Demo that began stopping meanwhile starts no worker.
      if (files && deps.maySpawn && !deps.maySpawn()) {
        void files.close()
        try { fs.closeSync(files.inFd) } catch { /* closed */ }
        void removeSurviveFiles(paths)
        return { ok: false, error: 'acpStart: Demo is stopping; no new worker starts', errorKind: 'demo_stopping' }
      }
      try {
        proc = (use.spawn ?? spawn)(workerCmd[0], [...workerCmd.slice(1), '--journal', journalPath, ...(files ? ['--fifo', paths.fifo] : [])], {
          cwd,
          stdio: files ? ['ignore', files.outFd, files.errFd] : ['pipe', 'pipe', 'pipe'],
          env: mergeAcpSpawnEnv(baseEnv, env),
          // Worker becomes PGID leader; adapter, provider, and tool descendants
          // inherit the group so an explicit abort can terminate all of them.
          detached: true,
        })
      } catch (e) {
        await files?.close()
        if (files) { try { fs.closeSync(files.inFd) } catch { /* closed */ } }
        throw e
      }
      // Closed once the child holds its own copies (Bun hands the fds over when it starts it).
      if (files) proc.once('spawn', () => { void files.close() })
      if (files) proc.once('error', () => { void files.close() })
      // A request still in the stdin pipe when the worker goes (an interrupt tears
      // its group down) fails with EPIPE as an 'error' EVENT, which a try around
      // write() never sees. Unheard, it is an uncaughtException that ends the whole
      // daemon (2026-11-02: it ended the browser fixture's server, which embeds
      // this module). The worker's exit reaps it and fails what waits on it.
      let stdinClosedLogged = false
      proc.stdin?.on('error', (err: NodeJS.ErrnoException) => {
        if (stdinClosedLogged) return
        stdinClosedLogged = true
        log(err.code === 'EPIPE' ? 'info' : 'warn', 'acp: worker stdin closed', { sid, code: err.code, error: err.message })
      })
      for (const out of [proc.stdout, proc.stderr]) {
        out?.on('error', (err: NodeJS.ErrnoException) => log('warn', 'acp: worker output stream failed', { sid, code: err.code }))
      }
      await new Promise<void>((resolve, reject) => {
        proc.once('spawn', resolve)
        proc.once('error', reject)
      })
    } catch (e) {
      if (survive) void removeSurviveFiles(paths)
      return { ok: false, error: 'acpStart: worker spawn failed: ' + (e as Error).message, errorKind: 'adapter_spawn_failed' }
    }

    let pushOffset = 0
    try { pushOffset = fs.statSync(journalPath).size } catch {}
    const entry: AcpWorkerEntry<W> = {
      sid, proc, pid: proc.pid, exited: () => proc.exitCode !== null || proc.signalCode !== null,
      send: (line, done) => { proc.stdin!.write(line, (err) => done(err ?? undefined)) },
      cwd, taskDir: env?.WALNUT_TASK_DIR || undefined, journalPath, pushOffset,
      subscribers: new Set([ws]),
      pendingRpc: new Map(),
      // A surviving worker's ids never repeat across daemon lives (acp-survive.ts firstRpcId).
      nextRpcId: survive ? firstRpcId() : 1,
      lastActivity: Date.now(),
      state: 'running',
      stopping: false,
      aborting: false,
      terminalVersion: 0,
      activeCommandId: null,
      activeControlCommandId: null,
      cmd: path.basename(workerCmd[workerCmd.length > 1 ? 1 : 0]),
      adapter: adapterCmd.slice(0, 2).join(' '),
      ...(typeof params.deadlineAt === 'number' && params.deadlineAt > 0 ? { deadlineAt: params.deadlineAt } : {}),
      ...(typeof params.orphanGraceMs === 'number' && params.orphanGraceMs > 0 ? { orphanGraceMs: params.orphanGraceMs } : {}),
    }
    if (survive) {
      try {
        entry.survive = openSurviveChannel(paths, { from: 0, adopted: false, ...(survivePipeFd !== null ? { fd: survivePipeFd } : {}), onLine: (line) => onWorkerLine(entry, line), log })
      } catch (e) {
        try { if (proc.pid) process.kill(-proc.pid, 'SIGKILL') } catch { /* gone */ }
        void removeSurviveFiles(paths)
        return { ok: false, error: 'acpStart: worker pipe failed: ' + (e as Error).message, errorKind: 'adapter_spawn_failed' }
      }
      const channel = entry.survive
      entry.send = (line, done) => channel.write(line, done)
    }
    workers.set(sid, entry)
    persistPids()
    // Its start time lets the next daemon tell this worker from a process that got its pid later.
    const pid = proc.pid
    if (pid) void processInfo(pid).then((info) => {
      if (info.state === 'alive' && workers.get(sid) === entry && entry.state === 'running') { entry.start = info.start; persistPids() }
    }).catch(() => {})
    if (pid && survive) void listSurvivor(entry)

    if (!survive) {
      const rl = readline.createInterface({ input: proc.stdout!, terminal: false })
      rl.on('line', (line) => onWorkerLine(entry, line))
      proc.stderr!.on('data', (chunk: Buffer) => {
        log('debug', 'acp worker stderr', { sid, bytes: chunk.length })
      })
    }
    proc.on('exit', (code) => {
      log('info', 'acp: worker exited', { sid, code })
      if (entry.aborting) return
      // A surviving worker's last answers are in its file: read them before it is reaped.
      if (entry.survive) void entry.survive.drain().finally(() => reapWorker(sid, entry.stopping ? 'stopped' : 'worker-exit'))
      else reapWorker(sid, entry.stopping ? 'stopped' : 'worker-exit')
    })

    // Replay any pre-existing journal history the subscriber asked for.
    replayTo(ws, entry, params.fromOffset ?? 0)

    // initialize → new/load session
    const spawnedAt = Date.now()
    const init = await rpc(entry, 'initialize', { adapterCommand: adapterCmd, cwd, env })
    const initializedAt = Date.now()
    if (!init.ok) {
      reapWorker(sid, 'initialize-failed')
      return { ok: false, error: 'acp initialize failed: ' + (init.error?.message ?? '?'), errorKind: init.error?.kind }
    }
    const initMeta = (init.result as { _meta?: { walnut?: { gracefulCancel?: unknown } } } | undefined)?._meta
    entry.gracefulCancel = initMeta?.walnut?.gracefulCancel === true
    // Same mount list on both paths: ACP's mcpServers is the complete set for
    // the session, so omitting it on load would drop the mounts on cold resume.
    // A thread a failed load replaced, and that never got a turn of its own,
    // is not the conversation: try the one it replaced first (acp-thread-restore.ts).
    const restoreId = await findThreadToRestore(journalPath, providerSessionId)
    let sessionResp: WorkerRpcResponse | undefined
    if (restoreId) {
      const restored = await rpc(entry, 'loadSession', { providerSessionId: restoreId, cwd, mcpServers })
      log(restored.ok ? 'info' : 'warn', restored.ok ? 'acp: restored the thread a fresh one had replaced' : 'acp: replaced thread did not load, loading the requested one', {
        sid, requested: providerSessionId, restored: restoreId,
      })
      // Only a load the provider refused moves on to the requested thread. Any
      // other failure (a timeout above all) may leave that load running in the
      // worker, and a second load beside it would race it for the thread: it
      // fails the start as a failed load always did, and the worker is reaped.
      if (restored.ok || restored.error?.kind !== 'load_failed') sessionResp = restored
    }
    sessionResp ??= providerSessionId
      ? await rpc(entry, 'loadSession', { providerSessionId, cwd, mcpServers })
      : await rpc(entry, 'newSession', { cwd, mcpServers })
    if (!sessionResp.ok) {
      // load_failed is a real outcome the caller must decide on (fallback to
      // new session is walnut's call, with a visible warning) — keep worker
      // alive so the caller can issue newSession without a respawn.
      if (sessionResp.error?.kind === 'load_failed') {
        return { ok: false, error: sessionResp.error.message, errorKind: 'load_failed' }
      }
      reapWorker(sid, 'session-setup-failed')
      return { ok: false, error: 'acp session setup failed: ' + (sessionResp.error?.message ?? '?'), errorKind: sessionResp.error?.kind }
    }
    const sessionAt = Date.now()
    const state = await rpc(entry, 'getState')
    // initializeMs holds the worker's own boot and the adapter's; sessionMs the provider's session setup.
    const timings = { spawnMs: spawnedAt - startedAt, initializeMs: initializedAt - spawnedAt, sessionMs: sessionAt - initializedAt, stateMs: Date.now() - sessionAt }
    log('info', 'acp: worker started', { sid, adapter: entry.adapter, load: !!providerSessionId, ...timings })
    return {
      ok: true,
      result: {
        alive: false,
        session: sessionResp.result,
        state: state.result,
        journalPath,
        timings,
      },
    }
  }

  /** Generic op forwarding for send/cancel/respond/state/newSession-after-load-failure. */
  async function acpOp(sid: string, op: string, params?: Record<string, unknown>): Promise<WorkerRpcResponse> {
    if (!(await adopted(sid))) return { id: -1, ok: false, error: { kind: 'worker_adopting', message: adoptingRefusal(sid).error } }
    if (op === 'cancel') return acpAbortTurn(sid, params)
    const entry = workers.get(sid)
    if (!entry || entry.state !== 'running') {
      if (exitedGroupAlive(sid)) return { id: -1, ok: false, error: { kind: 'worker_stopping', message: 'the ACP worker for ' + sid + ' exited, and its process group is still running' } }
      return { id: -1, ok: false, error: { kind: 'no_worker', message: 'no live ACP worker for ' + sid } }
    }
    return rpc(entry, op, params)
  }

  /** True while a stopped worker's process group still runs; forgets it once the group is gone. */
  function exitedGroupAlive(sid: string): boolean {
    const group = exitedGroups.get(sid)
    if (!group) return false
    if (isProcessGroupAlive(group.pid)) return true
    exitedGroups.delete(sid)
    persistPids()
    return false
  }

  /** A retried stop of a worker that already exited: no RPC, only its group's own exit. */
  async function awaitExitedGroup(sid: string): Promise<void> {
    const group = exitedGroups.get(sid)
    if (!group) return
    if (!await waitFor(() => !isProcessGroupAlive(group.pid), 6000)) {
      throw new Error('ACP worker shutdown is still pending; its process group has not exited')
    }
    if (exitedGroups.get(sid) === group) { exitedGroups.delete(sid); persistPids() }
  }

  /**
   * Explicit turn abort. ACP cancel is advisory, so after a bounded wait this
   * tears down the worker process group to guarantee no tool descendant lives
   * past the interruption boundary. The provider session ID remains durable
   * in the Walnut record and is lazily loaded by the replacement worker.
   *
   * A worker that stops the turn itself (gracefulCancel: Codex's turn/interrupt,
   * which also ends Codex's commands) is asked first and kept when its turn ended
   * in time, so the next message needs no cold start; only `hard` (a restart) or a
   * turn it could not end goes on to the teardown.
   */
  async function acpAbortTurn(
    sid: string,
    params?: Record<string, unknown>,
  ): Promise<WorkerRpcResponse> {
    const entry = workers.get(sid)
    if (!entry || entry.state !== 'running') {
      return { id: -1, ok: false, error: { kind: 'no_worker', message: 'no live ACP worker for ' + sid } }
    }
    const beforeTerminal = entry.terminalVersion
    const interruptedCommandId = entry.activeCommandId ?? undefined
    const interruptedControlCommandId = entry.activeControlCommandId ?? undefined
    const hard = params?.hard === true
    const workerParams = params ? Object.fromEntries(Object.entries(params).filter(([k]) => k !== 'hard')) : params
    const forced = entry.gracefulCancel && !hard
    if (forced) {
      const graceful = await rpc(entry, 'cancel', workerParams, GRACEFUL_CANCEL_RPC_TIMEOUT_MS)
      const closed = graceful.ok && (graceful.result as { turnClosed?: unknown } | undefined)?.turnClosed === true
      if (closed && entry.state === 'running') {
        try { pushJournal(entry, fs.statSync(entry.journalPath).size) } catch {}
        log('info', 'acp: turn stopped by the worker; worker kept', { sid })
        return { id: graceful.id, ok: true, result: { aborted: true, providerClosedTurn: true, cancelAccepted: true, workerKept: true } }
      }
      log('warn', 'acp: worker did not stop the turn in time; tearing it down', { sid, error: graceful.error?.message })
    }
    // Cancel is advisory and must not inherit the generic 120s provider-op
    // timeout. A wedged worker gets a short chance before hard termination.
    const cancel = entry.gracefulCancel && !hard
      ? { id: -1, ok: true } as WorkerRpcResponse
      : await rpc(entry, 'cancel', workerParams, cancelRpcTimeoutMs)
    await waitFor(() => entry.terminalVersion > beforeTerminal, abortWaitMs)

    entry.aborting = true
    entry.stopping = true
    const pid = entry.pid
    const terminated = pid ? await terminateProcessGroup(pid) : entry.exited()
    // The provider can append its terminal record while handling SIGTERM,
    // after the advisory-cancel wait but before process-group exit.
    try { pushJournal(entry, fs.statSync(entry.journalPath).size) } catch {}
    const providerClosedTurn = entry.terminalVersion > beforeTerminal

    // After the termination attempt, append the missing durable boundary.
    if (terminated && !providerClosedTurn) {
      if (interruptedControlCommandId) {
        appendJournalMeta(entry.journalPath, {
          type: 'control-ended',
          commandId: interruptedControlCommandId,
          stopReason: 'cancelled',
        })
      } else if (interruptedCommandId) {
        appendJournalMeta(entry.journalPath, {
          type: 'turn-interrupted',
          reason: 'user-cancelled',
          commandId: interruptedCommandId,
          ...(forced ? { forced: true } : {}),
        })
      }
      if (interruptedControlCommandId || interruptedCommandId) {
        try { pushJournal(entry, fs.statSync(entry.journalPath).size) } catch {}
      }
    }
    reapWorker(sid, 'aborted')
    if (!terminated) {
      log('error', 'acp: process group survived hard abort', { sid, pid })
      return {
        id: cancel.id,
        ok: false,
        error: {
          kind: 'internal',
          message: `ACP process group ${pid ?? 'unknown'} remained alive after SIGKILL`,
        },
      }
    }
    return {
      id: cancel.id,
      ok: true,
      result: {
        aborted: true,
        providerClosedTurn,
        cancelAccepted: cancel.ok,
      },
    }
  }

  async function acpStop(sid: string): Promise<void> {
    const entry = workers.get(sid)
    if (!entry || entry.state !== 'running') return awaitExitedGroup(sid)
    entry.stopping = true
    if (!deps.strictStop?.()) {
      await rpc(entry, 'shutdown')
      setTimeout(() => {
        if (workers.get(sid) !== entry || entry.state !== 'running') return
        if (entry.pid && !entry.exited()) signalProcessGroup(entry.pid, 'SIGKILL')
        reapWorker(sid, 'stopped')
      }, 6000)
      return
    }
    const pid = entry.pid
    await rpc(entry, 'shutdown', undefined, 6000)
    if (pid && !await waitFor(() => !isProcessGroupAlive(pid), 6000)) {
      throw new Error('ACP worker shutdown is still pending; its process group has not exited')
    }
    if (workers.get(sid) === entry) reapWorker(sid, 'stopped')
    // The group this stop waited on is gone; an older one of the same runtime must be too.
    if (exitedGroups.get(sid)?.pid === pid) { exitedGroups.delete(sid); persistPids() }
    await awaitExitedGroup(sid)
  }

  /**
   * A light worker ends with its whole process group (the commands its tools started
   * too): a graceful stop ends the worker and its adapter but leaves those running.
   */
  async function endLightWorker(sid: string): Promise<void> {
    const entry = workers.get(sid)
    if (!entry || entry.state !== 'running' || entry.stopping) return
    const r = await acpAbortTurn(sid, { hard: true })
    if (!r.ok) log('error', 'acp: light worker did not end', { sid, error: r.error?.message })
  }

  function subscribe(ws: W, sid: string, fromOffset: number): boolean {
    const entry = workers.get(sid)
    if (!entry || entry.state !== 'running') return false
    entry.subscribers.add(ws)
    entry.orphanedSince = undefined
    replayTo(ws, entry, fromOffset)
    return true
  }

  function removeSubscriber(ws: W): void {
    for (const entry of workers.values()) {
      entry.subscribers.delete(ws)
      if (entry.orphanGraceMs && entry.subscribers.size === 0 && entry.orphanedSince === undefined) entry.orphanedSince = Date.now()
    }
  }

  function hasWorker(sid: string): boolean {
    const e = workers.get(sid)
    return !!e && e.state === 'running'
  }

  /** Read only: every worker this daemon holds (demo.quiesce answers with them, so a reset stops each). */
  function listWorkers(): Array<{ sid: string; state: 'running' | 'dead'; pid: number | null; stopping: boolean }> {
    const out = [...workers.values()].map((e) => ({ sid: e.sid, state: e.state, pid: e.pid ?? null, stopping: e.stopping }))
    for (const [sid, group] of [...exitedGroups]) {
      if (exitedGroupAlive(sid)) out.push({ sid, state: 'dead', pid: group.pid, stopping: true })
    }
    return out
  }

  // ── idle sweep ──

  setIntervalFn(() => {
    const now = Date.now()
    for (const [sid, entry] of workers) {
      if (entry.state !== 'running') continue
      // A light subagent's worker: past its own limit, or no server has watched it for its grace.
      if (entry.deadlineAt && now > entry.deadlineAt) {
        log('info', 'acp: light worker past its deadline', { sid, overMs: now - entry.deadlineAt })
        void endLightWorker(sid)
        continue
      }
      if (entry.orphanGraceMs && entry.orphanedSince !== undefined && now - entry.orphanedSince > entry.orphanGraceMs) {
        log('info', 'acp: light worker with no subscriber', { sid, orphanedMs: now - entry.orphanedSince })
        void endLightWorker(sid)
        continue
      }
      // Waiting on the worker's own reply is not idle (a slow session/load, or
      // acpStart's handshake). OP_TIMEOUT_MS bounds how long a reply can hold it.
      if (entry.pendingRpc.size > 0) continue
      // An open turn/control prompt (e.g. waiting on a permission answer) is
      // NOT idle even with zero traffic — hold it to the 24h ceiling instead.
      const turnOpen = entry.activeCommandId !== null || entry.activeControlCommandId !== null
      const limit = turnOpen ? Math.max(idleKillMs, ACP_TURN_OPEN_KILL_MS) : idleKillMs
      if (now - entry.lastActivity > limit) {
        log('info', 'acp: idle kill', { sid, idleMs: now - entry.lastActivity, turnOpen })
        void acpStop(sid).catch(error => log('warn', 'acp: idle stop is still pending', { sid, error: String(error) }))
      }
    }
    // Keep the busy advertisement fresh: a turn parked on a permission emits
    // ZERO journal traffic, and readers treat updatedAt >2min as stale.
    writeBusyFile()
  }, ACP_SWEEP_INTERVAL_MS)

  // ── startup repair ──

  /**
   * Append closing meta facts to a journal whose worker died without writing
   * them: an un-ended turn → turn-interrupted; un-answered permissions →
   * permission-auto-cancelled. The full file is streamed in bounded chunks:
   * a long-running turn's opening lifecycle fact can be far from the tail.
   */
  function repairJournalTail(journalPath: string, reason: 'daemon-restart' | 'worker-crash' | 'rollback'): void {
    repairJournalMode(journalPath)
    const { activeCommandId, controlCommandId, openPermissions } = journalOpenState(journalPath)
    if (!activeCommandId && !controlCommandId && openPermissions.size === 0) return

    const appends: string[] = []
    for (const id of openPermissions) {
      appends.push(JSON.stringify({ kind: 'meta', ts: Date.now(), event: { type: 'permission-auto-cancelled', providerRequestId: id } }))
    }
    if (activeCommandId) {
      appends.push(JSON.stringify({
        kind: 'meta',
        ts: Date.now(),
        event: { type: 'turn-interrupted', reason, commandId: activeCommandId },
      }))
    }
    if (controlCommandId) {
      appends.push(JSON.stringify({
        kind: 'meta',
        ts: Date.now(),
        event: {
          type: 'control-ended',
          commandId: controlCommandId,
          stopReason: reason,
        },
      }))
    }
    try {
      fs.appendFileSync(journalPath, appends.join('\n') + '\n')
      log('info', 'acp: journal repaired', {
        journalPath,
        reason,
        interruptedTurn: !!activeCommandId,
        cancelledPermissions: openPermissions.size,
      })
    } catch {}
  }

  /** What a journal leaves open: a turn, a control prompt, permissions not answered. */
  function journalOpenState(journalPath: string): { activeCommandId: string | null; controlCommandId: string | null; openPermissions: Set<string> } {
    let activeCommandId: string | null = null
    let controlCommandId: string | null = null
    const openPermissions = new Set<string>()
    forEachCompleteJournalLine(journalPath, (line) => {
      let rec: {
        kind?: string
        event?: { type?: string; providerRequestId?: string; commandId?: string }
      }
      try { rec = JSON.parse(line) } catch { return }
      if (rec.kind !== 'meta' || !rec.event) return
      const ev = rec.event
      switch (ev.type) {
        case 'prompt-dispatched':
        case 'turn-started':
          activeCommandId = ev.commandId ?? activeCommandId
          break
        case 'turn-ended':
        case 'turn-interrupted':
          activeCommandId = null
          break
        case 'control-prompt-accepted': controlCommandId = ev.commandId ?? null; break
        case 'control-ended': controlCommandId = null; break
        case 'permission-requested': if (ev.providerRequestId) openPermissions.add(ev.providerRequestId); break
        case 'permission-answered': case 'permission-auto-cancelled':
          if (ev.providerRequestId) openPermissions.delete(ev.providerRequestId); break
      }
    })
    return { activeCommandId, controlCommandId, openPermissions }
  }

  function forEachCompleteJournalLine(
    journalPath: string,
    visit: (line: string) => void,
  ): void {
    let fd: number | undefined
    try {
      fd = fs.openSync(journalPath, 'r')
      const chunk = Buffer.allocUnsafe(64 * 1024)
      const decoder = new StringDecoder('utf8')
      let carry = ''
      for (;;) {
        const read = fs.readSync(fd, chunk, 0, chunk.length, null)
        if (read === 0) break
        const text = carry + decoder.write(chunk.subarray(0, read))
        const lines = text.split('\n')
        carry = lines.pop() ?? ''
        for (const line of lines) {
          if (line.trim()) visit(line)
        }
      }
      carry += decoder.end()
      // A trailing partial record is intentionally ignored.
    } catch {
      return
    } finally {
      if (fd !== undefined) {
        try { fs.closeSync(fd) } catch {}
      }
    }
  }

  /**
   * A surviving worker an earlier daemon here started: adopted when the process at its pid still
   * is that worker (its start time) and its pipe is there; else its journal is closed as a crash.
   */
  /** One adoption, settled: its row leaves the kept rows unless it stays open. */
  function adoptOne(sid: string, row: Exclude<PidRow, number>, psTries = ADOPT_PS_TRIES): Promise<void> {
    return adoptSurvivor(sid, row, psTries).catch((err) => { log('warn', 'acp: adoption failed', { sid, error: String(err) }) }).then((keep) => {
      if (keep !== 'keep' && keptRows.get(sid) === row) keptRows.delete(sid)
      adopting.delete(sid)
      persistPids()
    })
  }

  async function adoptSurvivor(sid: string, row: Exclude<PidRow, number>, psTries: number): Promise<'keep' | void> {
    const journalPath = journalPathFor(sid)
    const paths = survivePaths(streamsDir, sid)
    let info = await processInfo(row.pid)
    for (let i = 1; i < psTries && info.state === 'unknown'; i++) {
      await new Promise((r) => setTimeout(r, ADOPT_PS_RETRY_MS))
      info = await processInfo(row.pid)
    }
    if (info.state === 'unknown') {
      // ps gave no answer: neither adopted nor signalled; its row stays, and the next start or op for
      // this session asks again (adopted) and is refused meanwhile, never given a second worker.
      log('warn', 'acp: surviving worker left alone, ps gave no answer', { sid, pid: row.pid })
      return 'keep'
    }
    // Its start as the pid file says, else as the launcher's list says (the daemon died before it read it).
    let same = info.state === 'alive' && !!row.start && info.start === row.start
    if (info.state === 'alive' && !row.start) {
      const listed = await listedStart(sid)
      const now = listed ? await registryStart(row.pid) : null
      same = !!listed && now === listed
      // No start in either record (the daemon died a few ms after the spawn): a process on this boot
      // that runs the worker's script is ours, but cannot be checked well enough to adopt; it is
      // stopped before its turn is closed, as sweepStraggler does, so the next start is the only one.
      const sameBoot = typeof row.boot === 'number' && Math.abs(boot() - row.boot) <= 2
      if (!listed && sameBoot && info.command.includes(row.cmd || 'acp-worker')) {
        log('warn', 'acp: surviving worker has no start time recorded; stopping it', { sid, pid: row.pid })
        await terminateProcessGroup(row.pid)
      }
    }
    if (same && !fs.existsSync(paths.fifo)) {
      // Ours, but its pipe is gone: it cannot be followed, so it is stopped before its turn is closed.
      log('warn', 'acp: surviving worker has no pipe; stopping it', { sid, pid: row.pid })
      await terminateProcessGroup(row.pid)
      same = false
    }
    if (!same) {
      repairJournalTail(journalPath, 'worker-crash')
      void removeSurviveFiles(paths)
      void unregisterRun(registryDir, 'acp', sid)
      log('info', 'acp: surviving worker gone while no daemon ran', { sid, pid: row.pid })
      return
    }
    const pid = row.pid
    const gone = () => { try { process.kill(pid, 0); return false } catch (err) { return (err as NodeJS.ErrnoException).code === 'ESRCH' } }
    let pushOffset = 0
    try { pushOffset = fs.statSync(journalPath).size } catch {}
    const open = journalOpenState(journalPath)
    const entry: AcpWorkerEntry<W> = {
      sid, pid, exited: gone, send: () => {},
      ...(row.cwd ? { cwd: row.cwd } : {}), ...(row.taskDir ? { taskDir: row.taskDir } : {}),
      journalPath, pushOffset,
      subscribers: new Set(),
      pendingRpc: new Map(),
      nextRpcId: firstRpcId(),
      lastActivity: Date.now(),
      state: 'running', stopping: false, aborting: false, terminalVersion: 0,
      activeCommandId: open.activeCommandId, activeControlCommandId: open.controlCommandId,
      cmd: row.cmd || 'acp-worker', adapter: row.adapter || '', start: row.start,
      ...(row.deadlineAt ? { deadlineAt: row.deadlineAt } : {}),
      ...(row.orphanGraceMs ? { orphanGraceMs: row.orphanGraceMs, orphanedSince: Date.now() } : {}),
    }
    let channel: SurviveChannel
    try {
      channel = openSurviveChannel(paths, { from: await readSavedPos(paths), adopted: true, onLine: (line) => onWorkerLine(entry, line), log })
    } catch (err) {
      log('warn', 'acp: surviving worker pipe could not be opened; stopping it', { sid, pid, error: String(err) })
      await terminateProcessGroup(pid)
      repairJournalTail(journalPath, 'worker-crash')
      void removeSurviveFiles(paths)
      void unregisterRun(registryDir, 'acp', sid)
      return
    }
    entry.survive = channel
    entry.send = (line, done) => channel.write(line, done)
    workers.set(sid, entry)
    persistPids()
    void listSurvivor(entry)
    // No exit event comes for a process this daemon did not start: its pid is looked at.
    const watch = setInterval(() => {
      if (workers.get(sid) !== entry || entry.state !== 'running') { clearInterval(watch); return }
      if (!gone()) return
      clearInterval(watch)
      log('info', 'acp: adopted worker exited', { sid })
      if (entry.aborting) return
      void channel.drain().finally(() => reapWorker(sid, entry.stopping ? 'stopped' : 'worker-exit'))
    }, 500)
    watch.unref?.()
    log('info', 'acp: surviving worker adopted', { sid, pid, turnOpen: !!(open.activeCommandId || open.controlCommandId) })
  }

  /**
   * Daemon startup: workers on stdio from a previous daemon life are dead by
   * definition. Repair every such ACP journal's tail, and sweep any straggler
   * left in the pid file (belt-and-suspenders). A surviving worker
   * (acp-survive.ts) is adopted instead (adoptSurvivor) before anything touches
   * its journal. The returned promise is the sweep and the adoptions; it never
   * rejects.
   */
  function startupRepair(): Promise<void> {
    ensureOwnerOnlyAcpStorage()
    let rows: Array<[string, PidRow]> = []
    try { rows = Object.entries(JSON.parse(fs.readFileSync(pidFile, 'utf-8')) as Record<string, PidRow>) } catch {}
    // A stopped worker's group the last daemon life could not see exit: kept as read-only
    // stop evidence (never swept or signalled) while it may still run on this boot.
    rows = rows.filter(([sid, row]) => {
      if (typeof row === 'number' || row?.stopping !== true) return true
      const sameBoot = typeof row.boot === 'number' && Math.abs(boot() - row.boot) <= 2
      if (sameBoot && Number.isInteger(row.pid) && row.pid > 1 && isProcessGroupAlive(row.pid)) {
        exitedGroups.set(sid, { pid: row.pid, cmd: row.cmd || 'acp-worker', adapter: row.adapter || '', boot: row.boot as number, ...(row.start ? { start: row.start } : {}) })
      }
      return false
    })
    // Surviving workers are adopted, never swept; their rows stay in the file until each is settled.
    const survivors = rows.filter((r): r is [string, Exclude<PidRow, number>] => typeof r[1] !== 'number' && r[1]?.survive === true && Number.isInteger(r[1].pid) && r[1].pid > 1)
    rows = rows.filter((r) => !survivors.includes(r as [string, Exclude<PidRow, number>]))
    for (const [sid, row] of survivors) keptRows.set(sid, row)
    persistPids()

    // Journal repair for every ACP session on this host (but the surviving workers').
    const surviving = new Set(survivors.map(([sid]) => sid))
    let files: string[] = []
    try { files = fs.readdirSync(streamsDir).filter((f) => f.endsWith('.acp.jsonl')) } catch {}
    for (const f of files) if (!surviving.has(f.slice(0, -'.acp.jsonl'.length))) repairJournalTail(path.join(streamsDir, f), 'daemon-restart')

    // Held from now: a start or op for one of them waits for its adoption.
    for (const [sid, row] of survivors) adopting.set(sid, adoptOne(sid, row))
    return (async () => {
      await Promise.all([...adopting.values()])
      for (const [sid, row] of rows) {
        try { await sweepStraggler(sid, row) } catch {}
      }
    })()
  }

  /**
   * A pid from the last daemon life is signalled only while it is provably that
   * worker's: the process holding it started when the worker did (or, for a row
   * with no start time, runs the worker's script), or nothing holds it but a
   * process group of that id still runs the worker's adapter (the worker died and
   * left its adapter and tools behind). A row from before this host's last boot,
   * a pid now held by some other process, a group that runs anything else, and
   * a pid ps could not be asked about are left alone: after a reboot or a long
   * stop the file names pids that belong to anything.
   */
  async function sweepStraggler(sid: string, row: PidRow): Promise<void> {
    const pid = typeof row === 'number' ? row : row?.pid
    if (!Number.isInteger(pid) || pid <= 1) return
    const cmd = typeof row === 'number' ? 'acp-worker' : (row.cmd || 'acp-worker')
    const start = typeof row === 'number' ? undefined : row.start
    const recordedBoot = typeof row === 'number' ? undefined : row.boot
    if (typeof recordedBoot === 'number' && Math.abs(boot() - recordedBoot) > 2) {
      log('info', 'acp: straggler row is from before this host booted; left alone', { sid, pid })
      return
    }
    const info = await processInfo(pid)
    if (info.state === 'unknown') {
      log('warn', 'acp: straggler left alone, ps gave no answer', { sid, pid })
      return
    }
    if (info.state === 'alive') {
      const ours = start ? info.start === start : info.command.includes(cmd)
      if (!ours) {
        log('info', 'acp: straggler pid now belongs to another process; left alone', { sid, pid })
        return
      }
      if (signalProcessGroup(pid, 'SIGKILL')) log('info', 'acp: straggler process group killed', { sid, pid })
      return
    }
    // The worker is gone; its group may live on (the adapter and its tools). A
    // group of that id that runs anything but the worker's adapter is someone else's.
    const adapter = typeof row === 'number' ? undefined : row.adapter
    if (!adapter || typeof recordedBoot !== 'number' || !groupAlive(pid)) return
    const members = await groupCommands(pid)
    if (!members?.some((command) => command.includes(adapter))) {
      log('info', 'acp: straggler group runs no adapter of this worker; left alone', { sid, pid })
      return
    }
    try {
      process.kill(-pid, 'SIGKILL')
      log('info', 'acp: straggler process group killed', { sid, pid, leaderGone: true })
    } catch {}
  }

  function groupAlive(pid: number): boolean {
    try { process.kill(-pid, 0); return true } catch { return false }
  }

  function signalProcessGroup(pid: number, signal: NodeJS.Signals): boolean {
    // pid ≤ 1 = corrupted pid file. kill(-1, sig) does NOT throw — POSIX
    // broadcasts to every process the user can signal (2026-08-09 incident).
    if (!Number.isInteger(pid) || pid <= 1) return false
    try {
      process.kill(-pid, signal)
      return true
    } catch {
      // Backward-compatible cleanup for a pid file written before workers were
      // detached process-group leaders.
      try {
        process.kill(pid, signal)
        return true
      } catch {
        return false
      }
    }
  }

  /** Gone only when both the group and the pid answer ESRCH; any other answer (EPERM) is not proof of exit. */
  function isProcessGroupAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 1) return false
    try {
      process.kill(-pid, 0)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return true
    }
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== 'ESRCH'
    }
  }

  async function terminateProcessGroup(pid: number): Promise<boolean> {
    signalProcessGroup(pid, 'SIGTERM')
    if (await waitFor(() => !isProcessGroupAlive(pid), killGraceMs)) return true
    signalProcessGroup(pid, 'SIGKILL')
    return waitFor(() => !isProcessGroupAlive(pid), killGraceMs)
  }

  async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (!predicate() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    return predicate()
  }

  function appendJournalMeta(
    journalPath: string,
    event: Record<string, unknown>,
  ): void {
    repairJournalMode(journalPath)
    fs.appendFileSync(journalPath, JSON.stringify({
      kind: 'meta',
      ts: Date.now(),
      event,
    }) + '\n')
  }

  const hostProbe = createHostEngineProbe({ artifactDir: deps.artifactDir, artifactNames: deps.artifactNames, env: use.env, execFile: use.execFile })
  return {
    /** Which engines this host can run (acp-host-artifacts.ts); only a daemon with `artifactDir` answers. */
    hostEngines: deps.artifactDir ? (specs: AcpHostAdapterSpec[]) => hostProbe.probe(specs) : undefined,
    modelCatalog: (binary: string, options: { cwd?: string; env?: Record<string, string> }) =>
      probeCodexModels(binary, { cwd: options.cwd, env: mergeAcpSpawnEnv(baseEnv, options.env), spawn: use.spawn }),
    acpStart,
    acpOp,
    acpAbortTurn,
    /** acpStart honors deadlineAt / orphanGraceMs ('acp-light-bounds-v1'). */
    lightBounds: true as const,
    acpStop,
    subscribe,
    removeSubscriber,
    hasWorker,
    listWorkers,
    startupRepair,
    holdingWorkers,
    endForRollback,
    workers,
  }
}
