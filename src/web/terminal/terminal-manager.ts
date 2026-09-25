/**
 * TerminalManager — owns the live terminal ptys and bridges their bytes to the
 * attached WebSocket client.
 *
 * Reliability model (see plan): the shell itself lives under dtach on the
 * target host, so the pty here is just "the window into it". This manager only
 * has to survive WS flaps gracefully:
 *   - a 256KB scrollback ring per terminal replays missed output on reconnect
 *   - WS disconnect → detach + 120s grace (pty kept alive, not killed)
 *   - 30min idle → detach the pty/ssh connection (NEVER kill the dtach session)
 *
 * A PLAIN terminal (mode.persistent === false: dtach unavailable) has no dtach
 * session behind it, so the pty IS the shell: grace/idle expiry ends it. That
 * is the "Not persistent" the UI badges; the 120s grace still rides out a WS
 * flap. A later Retry with dtach available replaces it with a persistent one.
 *
 * Terminal bytes are sent only to the single attached client via `sendToClient`,
 * never broadcast.
 */

import type { WebSocket } from 'ws'
import type { IPty } from '@homebridge/node-pty-prebuilt-multiarch'
import { sendToClient } from '../ws/handler.js'
import { resolveSpawnForSession } from './spawn.js'
import type { TerminalMode } from './dtach-check.js'
import { getSessionByClaudeId } from '../../core/session-tracker.js'
import { log } from '../../logging/index.js'

const RING_CAPACITY = 256 * 1024 // 256KB scrollback
const GRACE_MS = 120_000 // keep pty alive 120s after client disconnects
const IDLE_MS = 30 * 60_000 // detach pty (not dtach) after 30min no activity

/** Fixed-size byte ring; drops oldest bytes when full. */
class RingBuffer {
  private chunks: Buffer[] = []
  private size = 0
  constructor(private readonly capacity: number) {}

  push(buf: Buffer): void {
    this.chunks.push(buf)
    this.size += buf.length
    while (this.size > this.capacity && this.chunks.length > 0) {
      const dropped = this.chunks.shift()!
      this.size -= dropped.length
    }
  }

  read(): Buffer {
    return this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks)
  }

  clear(): void {
    this.chunks = []
    this.size = 0
  }
}

interface OpenResult {
  terminalId: string
  cols: number
  rows: number
  /** The mode of the terminal actually attached (may differ from the request). */
  mode: TerminalMode
}

const PERSISTENT: TerminalMode = { persistent: true }

class TerminalSession {
  readonly id: string
  readonly sessionId: string
  readonly host?: string
  mode: TerminalMode
  private pty: IPty
  private ring = new RingBuffer(RING_CAPACITY)
  private attached: WebSocket | null = null
  private graceTimer: ReturnType<typeof setTimeout> | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private exited = false
  /** Replaced on purpose (plain → persistent upgrade): exit is not news. */
  private disposed = false
  cols: number
  rows: number
  private onDestroy: (t: TerminalSession) => void

  constructor(opts: {
    id: string
    sessionId: string
    host?: string
    mode: TerminalMode
    pty: IPty
    cols: number
    rows: number
    onDestroy: (t: TerminalSession) => void
  }) {
    this.id = opts.id
    this.sessionId = opts.sessionId
    this.host = opts.host
    this.mode = opts.mode
    this.pty = opts.pty
    this.cols = opts.cols
    this.rows = opts.rows
    this.onDestroy = opts.onDestroy

    this.pty.onData((data: string) => {
      const buf = Buffer.from(data, 'utf-8')
      this.ring.push(buf)
      this.bumpIdle()
      if (this.attached) {
        sendToClient(this.attached, `terminal:data:${this.id}`, { data })
      }
    })

    this.pty.onExit(({ exitCode, signal }) => {
      this.exited = true
      log.web.info('terminal pty exit', { terminalId: this.id, exitCode, signal, persistent: this.mode.persistent })
      if (this.attached && !this.disposed) {
        sendToClient(this.attached, `terminal:exit:${this.id}`, { exitCode, signal: signal ?? null })
      }
      this.clearTimers()
      this.onDestroy(this)
    })

    this.bumpIdle()
  }

  /** Attach a client: replay scrollback then live-pipe. */
  attach(ws: WebSocket): void {
    this.clearGrace()
    // Same socket, still attached (a Retry that kept this terminal): the
    // client's xterm already holds the output, so a replay would duplicate it.
    if (this.attached === ws) {
      this.bumpIdle()
      return
    }
    this.attached = ws
    const backlog = this.ring.read()
    if (backlog.length > 0) {
      sendToClient(ws, `terminal:data:${this.id}`, { data: backlog.toString('utf-8') })
    }
    this.bumpIdle()
  }

  /** Client went away (WS close or explicit close). Keep pty alive for grace period. */
  detach(): void {
    this.attached = null
    this.clearGrace()
    this.graceTimer = setTimeout(() => {
      // Grace expired with no reattach: release the local pty/ssh connection.
      // The dtach session on the target host stays alive — reopen re-attaches.
      log.web.info('terminal grace expired, releasing pty', { terminalId: this.id })
      this.destroyPty()
    }, GRACE_MS)
  }

  isAttachedTo(ws: WebSocket): boolean {
    return this.attached === ws
  }

  /** Any client currently attached (actively viewing)? */
  hasClient(): boolean {
    return this.attached !== null
  }

  write(data: string): void {
    if (this.exited) return
    this.pty.write(data)
    this.bumpIdle()
  }

  resize(cols: number, rows: number): void {
    if (this.exited) return
    this.cols = cols
    this.rows = rows
    try { this.pty.resize(cols, rows) } catch { /* pty may be mid-exit */ }
  }

  private bumpIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      // Idle reclaim targets DETACHED terminals only — releasing the local
      // pty/ssh connection while a client is actively viewing would blank a
      // live terminal out from under the user (violates the "don't surprise
      // the user" reliability goal). While attached we just re-arm; the pty is
      // held until the client disconnects (then the 120s grace timer releases
      // it). dtach always survives either way.
      if (this.attached) {
        this.bumpIdle()
        return
      }
      log.web.info('terminal idle, releasing pty (dtach kept)', { terminalId: this.id })
      this.destroyPty()
    }, IDLE_MS)
  }

  private clearGrace(): void {
    if (this.graceTimer) { clearTimeout(this.graceTimer); this.graceTimer = null }
  }

  private clearTimers(): void {
    this.clearGrace()
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null }
  }

  /** Release the local pty (kills ssh/dtach-attach process, NOT the dtach session). */
  private destroyPty(): void {
    this.clearTimers()
    if (!this.exited) {
      try { this.pty.kill() } catch { /* already gone */ }
    }
    this.ring.clear()
    this.onDestroy(this)
  }

  /**
   * End this terminal now, without an exit event to the client: the caller is
   * replacing it (plain → persistent upgrade) or the user asked to end it.
   */
  dispose(): void {
    this.disposed = true
    this.attached = null
    this.destroyPty()
  }

  /** Force-release on server shutdown. */
  shutdown(): void {
    this.clearTimers()
    try { this.pty.kill() } catch { /* already gone */ }
    this.ring.clear()
  }
}

class TerminalManager {
  private terminals = new Map<string, TerminalSession>()
  /** sessionId → terminalId (one terminal per session). */
  private bySession = new Map<string, string>()
  /**
   * In-flight open() promises keyed by sessionId. `open()` is async (spawns a
   * pty before inserting into the maps), so a rapid second call — a double
   * click, or the mount effect racing the `_ws:reconnected` reopen — would not
   * yet see the first terminal and would spawn a SECOND pty (orphaned, wasting
   * an ssh connection). Coalescing on this map guarantees one pty per session.
   */
  private opening = new Map<string, Promise<OpenResult>>()

  /**
   * Open (or re-attach to) a terminal for a session. Reuses an existing live
   * terminal for the same session if present; otherwise spawns a new pty
   * (which `dtach -A` attaches to the persistent dtach session, or a plain
   * shell when `mode.persistent` is false).
   *
   * Mode rules for an existing terminal: a persistent one is always reused
   * (never downgraded); a plain one is reused for a plain request (a failed
   * Retry must not kill the shell the user is working in) and REPLACED for a
   * persistent request, which only comes from a Retry that found dtach.
   */
  async open(sessionId: string, ws: WebSocket, cols: number, rows: number, mode: TerminalMode = PERSISTENT): Promise<OpenResult> {
    const existingId = this.bySession.get(sessionId)
    if (existingId) {
      const existing = this.terminals.get(existingId)
      if (existing && (existing.mode.persistent || !mode.persistent)) {
        if (!existing.mode.persistent) existing.mode = mode // fresher hint/detail
        existing.attach(ws)
        existing.resize(cols, rows)
        return { terminalId: existing.id, cols, rows, mode: existing.mode }
      }
      if (existing) {
        log.web.info('terminal upgrade: replacing plain shell with a persistent one', { sessionId })
        existing.dispose()
      }
      this.bySession.delete(sessionId)
    }

    const inFlight = this.opening.get(sessionId)
    if (inFlight) return inFlight

    const promise = this.spawnTerminal(sessionId, ws, cols, rows, mode)
      .finally(() => this.opening.delete(sessionId))
    this.opening.set(sessionId, promise)
    return promise
  }

  private async spawnTerminal(sessionId: string, ws: WebSocket, cols: number, rows: number, mode: TerminalMode): Promise<OpenResult> {
    const record = await getSessionByClaudeId(sessionId)
    if (!record) throw new Error(`Session not found: ${sessionId}`)

    const { pty, host } = await resolveSpawnForSession(record, cols, rows, { persistent: mode.persistent })
    const terminalId = sessionId // one terminal per session — id == sessionId
    const session = new TerminalSession({
      id: terminalId,
      sessionId,
      host,
      mode,
      pty,
      cols,
      rows,
      onDestroy: (t) => this.handleDestroy(t),
    })
    session.attach(ws)
    this.terminals.set(terminalId, session)
    this.bySession.set(sessionId, terminalId)
    log.web.info('terminal opened', { terminalId, sessionId, host, persistent: mode.persistent })
    return { terminalId, cols, rows, mode }
  }

  /** Mode of the live terminal for a session, or null when none is held. */
  liveMode(sessionId: string): TerminalMode | null {
    const id = this.bySession.get(sessionId)
    const t = id ? this.terminals.get(id) : undefined
    return t ? t.mode : null
  }

  /**
   * Explicit end (the user's "End terminal", or a reaper deciding a plain
   * shell must go): release the local pty now instead of waiting out the
   * grace timer. For a persistent terminal the dtach session itself is killed
   * separately (killDtachSession); for a plain one this IS the kill.
   */
  end(terminalId: string): void {
    this.terminals.get(terminalId)?.dispose()
  }

  /** Re-attach after a WS reconnect (pty still alive within grace period). */
  attach(terminalId: string, ws: WebSocket, cols: number, rows: number): boolean {
    const t = this.terminals.get(terminalId)
    if (!t) return false
    t.attach(ws)
    t.resize(cols, rows)
    return true
  }

  input(terminalId: string, data: string): void {
    this.terminals.get(terminalId)?.write(data)
  }

  resize(terminalId: string, cols: number, rows: number): void {
    this.terminals.get(terminalId)?.resize(cols, rows)
  }

  /** Collapse UI / detach — keeps dtach + pty alive (grace period). */
  close(terminalId: string): void {
    this.terminals.get(terminalId)?.detach()
  }

  /** A client socket disconnected — detach any terminal it was attached to. */
  onClientDisconnect(ws: WebSocket): void {
    for (const t of this.terminals.values()) {
      if (t.isAttachedTo(ws)) t.detach()
    }
  }

  /**
   * Forget a destroyed terminal. Identity-checked: a replaced plain shell's pty
   * exits AFTER its persistent successor took the same id (id == sessionId), and
   * that late exit must not forget the successor.
   */
  private handleDestroy(t: TerminalSession): void {
    if (this.terminals.get(t.id) !== t) return
    this.terminals.delete(t.id)
    if (this.bySession.get(t.sessionId) === t.id) {
      this.bySession.delete(t.sessionId)
    }
  }

  /**
   * Snapshot of the terminals this process currently holds, as
   * `{ sessionId, host }`. This in-memory map is the periodic reaper's ENTRY
   * POINT ("which terminals/hosts should I check") — NOT an authority on what to
   * kill. The reaper still decides kill/keep from ground truth (the session
   * registry + the live dtach process tree), so a drifted/stale snapshot is
   * harmless (at worst it checks a host that has nothing to reap).
   */
  listActive(): { sessionId: string; host?: string }[] {
    const out: { sessionId: string; host?: string }[] = []
    for (const t of this.terminals.values()) {
      out.push({ sessionId: t.sessionId, host: t.host })
    }
    return out
  }

  /** Is a client actively viewing this session's terminal right now? */
  isViewing(sessionId: string): boolean {
    const id = this.bySession.get(sessionId)
    const t = id ? this.terminals.get(id) : undefined
    return t ? t.hasClient() : false
  }

  /** Release all local ptys on server shutdown (dtach sessions survive). */
  shutdown(): void {
    for (const t of this.terminals.values()) t.shutdown()
    this.terminals.clear()
    this.bySession.clear()
  }
}

export const terminalManager = new TerminalManager()
