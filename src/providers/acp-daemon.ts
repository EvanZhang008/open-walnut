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
 * Dependency-injected (like daemon-core.ts) so the bun-compiled standalone
 * daemon wires in its Bun-specific ws/send helpers. daemon-source.ts (the
 * SSH-deployed fallback template) does NOT embed this module — it answers
 * acp* commands with a structured "not supported on this host" error until
 * the remote deploy phase lands.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import readline from 'node:readline'
import { StringDecoder } from 'node:string_decoder'
import { mergeAcpSpawnEnv, type AcpMcpServer } from './acp-worker/protocol.js'
import { probeCodexModels } from './codex-model-probe.js'
import { findThreadToRestore } from './acp-thread-restore.js'
import { createHostEngineProbe, resolveHostAcpArtifacts, type AcpHostAdapterSpec } from './acp-host-artifacts.js'

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
const ABORT_WAIT_MS = 750
const KILL_GRACE_MS = 750

interface AcpWorkerEntry<W> {
  sid: string
  proc: ChildProcess
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
  /** The worker's own name (its script's basename), its adapter's command and its start time, kept in the pid file. */
  cmd: string
  adapter: string
  start?: string
}

/** What `ps` says about one pid now; 'unknown' when it could not be asked. */
export type AcpProcessInfo = { state: 'gone' } | { state: 'alive'; start: string; command: string } | { state: 'unknown' }

/** A pid file row: a pid alone (older daemons), or the pid with what identifies its worker. */
type PidRow = number | { pid: number; cmd?: string; adapter?: string; start?: string; boot?: number }

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
}

function psField(pid: number, field: string): Promise<string | null | undefined> {
  return new Promise((resolve) => {
    execFile('ps', ['-ww', '-o', `${field}=`, '-p', String(pid)], { timeout: 5_000 }, (error, stdout, stderr) => {
      const out = String(stdout ?? '').trim()
      // ps answers 1 with nothing at all for a pid that is not there; anything else
      // (a usage message from a ps without these options, a timeout) is no answer.
      if (error) resolve((error as { code?: unknown }).code === 1 && !out && !String(stderr ?? '').trim() ? null : undefined)
      else resolve(out || null)
    })
  })
}

function psGroupCommands(pgid: number): Promise<string[] | null> {
  return new Promise((resolve) => {
    execFile('ps', ['-A', '-ww', '-o', 'pgid=', '-o', 'command='], { timeout: 5_000, maxBuffer: 16 << 20 }, (error, stdout) => {
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

async function psProcessInfo(pid: number): Promise<AcpProcessInfo> {
  const start = await psField(pid, 'lstart')
  if (start === undefined) return { state: 'unknown' }
  if (start === null) return { state: 'gone' }
  const command = await psField(pid, 'command')
  if (command === undefined) return { state: 'unknown' }
  return command === null ? { state: 'gone' } : { state: 'alive', start, command }
}

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
}

export function createAcpDaemon<W>(deps: AcpDaemonDeps<W>) {
  const { streamsDir, daemonDir, sendEvent, isWsOpen, log } = deps
  const idleKillMs = deps.idleKillMs ?? ACP_IDLE_KILL_MS
  const cancelRpcTimeoutMs = deps.cancelRpcTimeoutMs ?? CANCEL_RPC_TIMEOUT_MS
  const abortWaitMs = deps.abortWaitMs ?? ABORT_WAIT_MS
  const killGraceMs = deps.killGraceMs ?? KILL_GRACE_MS
  const setIntervalFn = deps.setIntervalFn ?? setInterval
  const workers = new Map<string, AcpWorkerEntry<W>>()
  const pidFile = path.join(daemonDir, 'acp-workers.json')
  const processInfo = deps.processInfo ?? psProcessInfo
  const groupCommands = deps.groupCommands ?? psGroupCommands
  const boot = deps.bootMinute ?? bootMinute
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
      if (w.state === 'running' && w.proc.pid) out[sid] = { pid: w.proc.pid, cmd: w.cmd, adapter: w.adapter, boot: boot(), ...(w.start ? { start: w.start } : {}) }
    }
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
        entry.proc.stdin!.write(JSON.stringify({ id, op, params }) + '\n')
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
    } else if (record.event.type === 'turn-ended' || record.event.type === 'turn-interrupted') {
      entry.terminalVersion++
      entry.activeCommandId = null
      writeBusyFile()
      try { deps.onTurnEnd?.(entry.sid) } catch { /* A budget check never breaks the journal. */ }
    } else if (record.event.type === 'control-prompt-accepted') {
      entry.activeControlCommandId = record.event.commandId ?? null
      writeBusyFile()
    } else if (record.event.type === 'control-ended') {
      entry.terminalVersion++
      entry.activeControlCommandId = null
      writeBusyFile()
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
    const busySids = [...workers.values()]
      .filter((e) => e.state === 'running' && (e.activeCommandId !== null || e.activeControlCommandId !== null))
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
    if (entry.proc.pid && entry.proc.exitCode === null) {
      signalProcessGroup(entry.proc.pid, 'SIGKILL')
    }
    workers.delete(sid)
    persistPids()
    writeBusyFile()
    log('info', 'acp: worker reaped', { sid, reason })
  }

  async function acpStart(ws: W, params: AcpStartParams): Promise<{ ok: boolean; result?: Record<string, unknown>; error?: string; errorKind?: string }> {
    const { sid, cwd, providerSessionId, mcpServers } = params
    let { workerCmd, adapterCmd, env } = params
    const existing = workers.get(sid)
    if (existing && existing.state === 'running') {
      existing.subscribers.add(ws)
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
      const resolved = resolveHostAcpArtifacts(params.hostAdapter, { artifactDir: deps.artifactDir })
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
    let proc: ChildProcess
    try {
      proc = spawn(workerCmd[0], [...workerCmd.slice(1), '--journal', journalPath], {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: mergeAcpSpawnEnv(process.env, env),
        // Worker becomes PGID leader; adapter, provider, and tool descendants
        // inherit the group so an explicit abort can terminate all of them.
        detached: true,
      })
      await new Promise<void>((resolve, reject) => {
        proc.once('spawn', resolve)
        proc.once('error', reject)
      })
    } catch (e) {
      return { ok: false, error: 'acpStart: worker spawn failed: ' + (e as Error).message, errorKind: 'adapter_spawn_failed' }
    }

    let pushOffset = 0
    try { pushOffset = fs.statSync(journalPath).size } catch {}
    const entry: AcpWorkerEntry<W> = {
      sid, proc, journalPath, pushOffset,
      subscribers: new Set([ws]),
      pendingRpc: new Map(),
      nextRpcId: 1,
      lastActivity: Date.now(),
      state: 'running',
      stopping: false,
      aborting: false,
      terminalVersion: 0,
      activeCommandId: null,
      activeControlCommandId: null,
      cmd: path.basename(workerCmd[workerCmd.length > 1 ? 1 : 0]),
      adapter: adapterCmd.slice(0, 2).join(' '),
    }
    workers.set(sid, entry)
    persistPids()
    // Its start time lets the next daemon tell this worker from a process that got its pid later.
    const pid = proc.pid
    if (pid) void processInfo(pid).then((info) => {
      if (info.state === 'alive' && workers.get(sid) === entry && entry.state === 'running') { entry.start = info.start; persistPids() }
    }).catch(() => {})

    const rl = readline.createInterface({ input: proc.stdout!, terminal: false })
    rl.on('line', (line) => {
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
        }
      }
    })
    proc.stderr!.on('data', (chunk: Buffer) => {
      log('debug', 'acp worker stderr', { sid, bytes: chunk.length })
    })
    proc.on('exit', (code) => {
      log('info', 'acp: worker exited', { sid, code })
      if (entry.aborting) return
      reapWorker(sid, entry.stopping ? 'stopped' : 'worker-exit')
    })

    // Replay any pre-existing journal history the subscriber asked for.
    replayTo(ws, entry, params.fromOffset ?? 0)

    // initialize → new/load session
    const init = await rpc(entry, 'initialize', { adapterCommand: adapterCmd, cwd, env })
    if (!init.ok) {
      reapWorker(sid, 'initialize-failed')
      return { ok: false, error: 'acp initialize failed: ' + (init.error?.message ?? '?'), errorKind: init.error?.kind }
    }
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
    const state = await rpc(entry, 'getState')
    return {
      ok: true,
      result: {
        alive: false,
        session: sessionResp.result,
        state: state.result,
        journalPath,
      },
    }
  }

  /** Generic op forwarding for send/cancel/respond/state/newSession-after-load-failure. */
  async function acpOp(sid: string, op: string, params?: Record<string, unknown>): Promise<WorkerRpcResponse> {
    if (op === 'cancel') return acpAbortTurn(sid, params)
    const entry = workers.get(sid)
    if (!entry || entry.state !== 'running') {
      return { id: -1, ok: false, error: { kind: 'no_worker', message: 'no live ACP worker for ' + sid } }
    }
    return rpc(entry, op, params)
  }

  /**
   * Explicit turn abort. ACP cancel is advisory, so after a bounded wait this
   * tears down the worker process group to guarantee no tool descendant lives
   * past the interruption boundary. The provider session ID remains durable
   * in the Walnut record and is lazily loaded by the replacement worker.
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
    // Cancel is advisory and must not inherit the generic 120s provider-op
    // timeout. A wedged worker gets a short chance before hard termination.
    const cancel = await rpc(entry, 'cancel', params, cancelRpcTimeoutMs)
    await waitFor(() => entry.terminalVersion > beforeTerminal, abortWaitMs)

    entry.aborting = true
    entry.stopping = true
    const pid = entry.proc.pid
    const terminated = pid ? await terminateProcessGroup(pid) : entry.proc.exitCode !== null
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
    if (!entry || entry.state !== 'running') return
    entry.stopping = true
    await rpc(entry, 'shutdown')
    // exit handler reaps; force-reap in case the worker wedged.
    setTimeout(() => {
      // The worker normally exits and is reaped before this timer. Check the
      // original map entry so a recycled PID cannot be signalled later.
      if (workers.get(sid) !== entry || entry.state !== 'running') return
      if (entry.proc.pid && entry.proc.exitCode === null) {
        signalProcessGroup(entry.proc.pid, 'SIGKILL')
      }
      reapWorker(sid, 'stopped')
    }, 6000)
  }

  function subscribe(ws: W, sid: string, fromOffset: number): boolean {
    const entry = workers.get(sid)
    if (!entry || entry.state !== 'running') return false
    entry.subscribers.add(ws)
    replayTo(ws, entry, fromOffset)
    return true
  }

  function removeSubscriber(ws: W): void {
    for (const entry of workers.values()) entry.subscribers.delete(ws)
  }

  function hasWorker(sid: string): boolean {
    const e = workers.get(sid)
    return !!e && e.state === 'running'
  }

  // ── idle sweep ──

  setIntervalFn(() => {
    const now = Date.now()
    for (const [sid, entry] of workers) {
      if (entry.state !== 'running') continue
      // Waiting on the worker's own reply is not idle (a slow session/load, or
      // acpStart's handshake). OP_TIMEOUT_MS bounds how long a reply can hold it.
      if (entry.pendingRpc.size > 0) continue
      // An open turn/control prompt (e.g. waiting on a permission answer) is
      // NOT idle even with zero traffic — hold it to the 24h ceiling instead.
      const turnOpen = entry.activeCommandId !== null || entry.activeControlCommandId !== null
      const limit = turnOpen ? Math.max(idleKillMs, ACP_TURN_OPEN_KILL_MS) : idleKillMs
      if (now - entry.lastActivity > limit) {
        log('info', 'acp: idle kill', { sid, idleMs: now - entry.lastActivity, turnOpen })
        void acpStop(sid)
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
  function repairJournalTail(journalPath: string, reason: 'daemon-restart' | 'worker-crash'): void {
    repairJournalMode(journalPath)
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
   * Daemon startup: workers from a previous daemon life are dead by definition
   * (in-process model). Repair every ACP journal's tail, and sweep any straggler
   * left in the pid file (belt-and-suspenders). The returned promise is the
   * sweep; it never rejects.
   */
  function startupRepair(): Promise<void> {
    ensureOwnerOnlyAcpStorage()
    let rows: Array<[string, PidRow]> = []
    try { rows = Object.entries(JSON.parse(fs.readFileSync(pidFile, 'utf-8')) as Record<string, PidRow>) } catch {}
    try {
      fs.writeFileSync(pidFile, '{}', { mode: 0o600 })
      fs.chmodSync(pidFile, 0o600)
    } catch {}

    // Journal repair for every ACP session on this host.
    let files: string[] = []
    try { files = fs.readdirSync(streamsDir).filter((f) => f.endsWith('.acp.jsonl')) } catch {}
    for (const f of files) repairJournalTail(path.join(streamsDir, f), 'daemon-restart')

    return (async () => {
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

  function isProcessGroupAlive(pid: number): boolean {
    try {
      process.kill(-pid, 0)
      return true
    } catch {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
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

  const hostProbe = createHostEngineProbe({ artifactDir: deps.artifactDir })
  return {
    /** Which engines this host can run (acp-host-artifacts.ts); only a daemon with `artifactDir` answers. */
    hostEngines: deps.artifactDir ? (specs: AcpHostAdapterSpec[]) => hostProbe.probe(specs) : undefined,
    modelCatalog: (binary: string, options: { cwd?: string; env?: Record<string, string> }) =>
      probeCodexModels(binary, { cwd: options.cwd, env: mergeAcpSpawnEnv(process.env, options.env) }),
    acpStart,
    acpOp,
    acpAbortTurn,
    acpStop,
    subscribe,
    removeSubscriber,
    hasWorker,
    startupRepair,
    workers,
  }
}
