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
 * Terminal bytes are sent only to the single attached client via `sendToClient`,
 * never broadcast.
 */

import type { WebSocket } from 'ws'
import type { IPty } from '@homebridge/node-pty-prebuilt-multiarch'
import { sendToClient } from '../ws/handler.js'
import { resolveSpawnForSession } from './spawn.js'
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
}

class TerminalSession {
  readonly id: string
  readonly sessionId: string
  readonly host?: string
  private pty: IPty
  private ring = new RingBuffer(RING_CAPACITY)
  private attached: WebSocket | null = null
  private graceTimer: ReturnType<typeof setTimeout> | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private exited = false
  cols: number
  rows: number
  private onDestroy: (id: string) => void

  constructor(opts: {
    id: string
    sessionId: string
    host?: string
    pty: IPty
    cols: number
    rows: number
    onDestroy: (id: string) => void
  }) {
    this.id = opts.id
    this.sessionId = opts.sessionId
    this.host = opts.host
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
      log.web.info('terminal pty exit', { terminalId: this.id, exitCode, signal })
      if (this.attached) {
        sendToClient(this.attached, `terminal:exit:${this.id}`, { exitCode, signal: signal ?? null })
      }
      this.clearTimers()
      this.onDestroy(this.id)
    })

    this.bumpIdle()
  }

  /** Attach a client: replay scrollback then live-pipe. */
  attach(ws: WebSocket): void {
    this.clearGrace()
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
    this.onDestroy(this.id)
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
   * (which `dtach -A` attaches to the persistent dtach session).
   */
  async open(sessionId: string, ws: WebSocket, cols: number, rows: number): Promise<OpenResult> {
    const existingId = this.bySession.get(sessionId)
    if (existingId) {
      const existing = this.terminals.get(existingId)
      if (existing) {
        existing.attach(ws)
        existing.resize(cols, rows)
        return { terminalId: existing.id, cols, rows }
      }
      this.bySession.delete(sessionId)
    }

    const inFlight = this.opening.get(sessionId)
    if (inFlight) return inFlight

    const promise = this.spawnTerminal(sessionId, ws, cols, rows)
      .finally(() => this.opening.delete(sessionId))
    this.opening.set(sessionId, promise)
    return promise
  }

  private async spawnTerminal(sessionId: string, ws: WebSocket, cols: number, rows: number): Promise<OpenResult> {
    const record = await getSessionByClaudeId(sessionId)
    if (!record) throw new Error(`Session not found: ${sessionId}`)

    const { pty, host } = await resolveSpawnForSession(record, cols, rows)
    const terminalId = sessionId // one terminal per session — id == sessionId
    const session = new TerminalSession({
      id: terminalId,
      sessionId,
      host,
      pty,
      cols,
      rows,
      onDestroy: (id) => this.handleDestroy(id),
    })
    session.attach(ws)
    this.terminals.set(terminalId, session)
    this.bySession.set(sessionId, terminalId)
    log.web.info('terminal opened', { terminalId, sessionId, host })
    return { terminalId, cols, rows }
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

  /** Forget a destroyed terminal. */
  private handleDestroy(terminalId: string): void {
    const t = this.terminals.get(terminalId)
    if (!t) return
    this.terminals.delete(terminalId)
    if (this.bySession.get(t.sessionId) === terminalId) {
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
