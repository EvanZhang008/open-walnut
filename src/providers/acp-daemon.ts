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
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import readline from 'node:readline'
import { StringDecoder } from 'node:string_decoder'
import type { AcpMcpServer } from './acp-worker/protocol.js'

const ACP_IDLE_KILL_MS = 2 * 60 * 60 * 1000   // mirror native SESSION_IDLE_KILL_MS
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
}

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
}

export interface AcpStartParams {
  sid: string
  cwd: string
  /** Full command vector for the worker process, e.g. [nodePath, workerMainJs]. */
  workerCmd: string[]
  /** Full command vector for the adapter, e.g. [nodePath, codexAcpIndexJs]. */
  adapterCmd: string[]
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
    const out: Record<string, number> = {}
    for (const [sid, w] of workers) {
      if (w.state === 'running' && w.proc.pid) out[sid] = w.proc.pid
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
    } else if (record.event.type === 'turn-ended' || record.event.type === 'turn-interrupted') {
      entry.terminalVersion++
      entry.activeCommandId = null
    } else if (record.event.type === 'control-prompt-accepted') {
      entry.activeControlCommandId = record.event.commandId ?? null
    } else if (record.event.type === 'control-ended') {
      entry.terminalVersion++
      entry.activeControlCommandId = null
    }
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
    log('info', 'acp: worker reaped', { sid, reason })
  }

  async function acpStart(ws: W, params: AcpStartParams): Promise<{ ok: boolean; result?: Record<string, unknown>; error?: string; errorKind?: string }> {
    const { sid, cwd, workerCmd, adapterCmd, env, providerSessionId, mcpServers } = params
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

    if (!Array.isArray(workerCmd) || workerCmd.length === 0) return { ok: false, error: 'acpStart: missing workerCmd' }
    if (!Array.isArray(adapterCmd) || adapterCmd.length === 0) return { ok: false, error: 'acpStart: missing adapterCmd' }

    const journalPath = journalPathFor(sid)
    repairJournalMode(journalPath)
    let proc: ChildProcess
    try {
      proc = spawn(workerCmd[0], [...workerCmd.slice(1), '--journal', journalPath], {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...env },
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
    }
    workers.set(sid, entry)
    persistPids()

    const rl = readline.createInterface({ input: proc.stdout!, terminal: false })
    rl.on('line', (line) => {
      if (!line.trim()) return
      let msg: { id?: number; ev?: string; offset?: number; bytes?: number }
      try { msg = JSON.parse(line) } catch { return }
      if (msg.ev === 'journal' && typeof msg.offset === 'number') {
        pushJournal(entry, msg.offset)
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
    const sessionResp = providerSessionId
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
      if (now - entry.lastActivity > idleKillMs) {
        log('info', 'acp: idle kill', { sid, idleMs: now - entry.lastActivity })
        void acpStop(sid)
      }
    }
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
   * (in-process model). Sweep any straggler pids (belt-and-suspenders), then
   * repair every ACP journal's tail.
   */
  function startupRepair(): void {
    ensureOwnerOnlyAcpStorage()
    // Straggler sweep from the pid file.
    try {
      const pids = JSON.parse(fs.readFileSync(pidFile, 'utf-8')) as Record<string, number>
      for (const [sid, pid] of Object.entries(pids)) {
        if (signalProcessGroup(pid, 'SIGKILL')) {
          log('info', 'acp: straggler process group killed', { sid, pid })
        }
      }
    } catch {}
    try {
      fs.writeFileSync(pidFile, '{}', { mode: 0o600 })
      fs.chmodSync(pidFile, 0o600)
    } catch {}

    // Journal repair for every ACP session on this host.
    let files: string[] = []
    try { files = fs.readdirSync(streamsDir).filter((f) => f.endsWith('.acp.jsonl')) } catch {}
    for (const f of files) repairJournalTail(path.join(streamsDir, f), 'daemon-restart')
  }

  function signalProcessGroup(pid: number, signal: NodeJS.Signals): boolean {
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

  return {
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
