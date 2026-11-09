/**
 * TerminalManager — owns the live terminal ptys and bridges their bytes to the
 * WebSocket clients viewing them.
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
 * Terminal bytes are sent only to the clients attached to that terminal (each
 * window or device viewing it, via `sendToClient`), never broadcast. Every
 * viewer gets the output; the last one to resize sets the size.
 */

import type { WebSocket } from '#ws'
import type { Pty } from '../../lib/pty.js'
import { sendToClient } from '../ws/handler.js'
import { resolveSpawnForSession } from './spawn.js'
import type { TerminalMode } from './dtach-check.js'
import { getSessionByClaudeId } from '../../core/session-tracker.js'
import { MAX_TERMINAL_SLOTS, parseTerminalKey, terminalKeyFor } from '../../core/terminal-key.js'
import { log } from '../../logging/index.js'

// WebSocket readyState values (the ws package and the browser agree).
const WS_CLOSING = 2
const WS_CLOSED = 3

const RING_CAPACITY = 256 * 1024 // 256KB scrollback
const GRACE_MS = 120_000 // keep pty alive 120s after client disconnects
const IDLE_MS = 30 * 60_000 // detach pty (not dtach) after 30min no activity
const RESERVE_MS = 60_000 // a reserved slot is held this long for its open
/** What `dtach -a` prints as its master goes (attach.c: cursor to the bottom, then this line). */
export const DTACH_EOF_RE = /(?:\x1b\[999H)?(?:\r?\n)?\[EOF - dtach terminating\]\r?\n?/g

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
  private pty: Pty
  private ring = new RingBuffer(RING_CAPACITY)
  private attached = new Set<WebSocket>()
  private graceTimer: ReturnType<typeof setTimeout> | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private exited = false
  /** Replaced on purpose (plain → persistent upgrade): exit is not news. */
  private disposed = false
  cols: number
  rows: number
  private onDestroy: (t: TerminalSession) => void

  /** The pty's own process: for a plain local shell, the shell itself. */
  get ptyPid(): number { return this.pty.pid }

  constructor(opts: {
    id: string
    sessionId: string
    host?: string
    mode: TerminalMode
    pty: Pty
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

    this.pty.onData((raw: string) => {
      // dtach's own goodbye when the shell ends (the page says that itself).
      const data = this.mode.persistent ? raw.replace(DTACH_EOF_RE, '') : raw
      if (!data) return
      const buf = Buffer.from(data, 'utf-8')
      this.ring.push(buf)
      this.bumpIdle()
      for (const ws of this.attached) sendToClient(ws, `terminal:data:${this.id}`, { data })
    })

    this.pty.onExit(({ exitCode, signal }) => {
      this.exited = true
      log.web.info('terminal pty exit', { terminalId: this.id, exitCode, signal, persistent: this.mode.persistent })
      if (!this.disposed) {
        for (const ws of this.attached) sendToClient(ws, `terminal:exit:${this.id}`, { exitCode, signal: signal ?? null })
      }
      this.clearTimers()
      this.onDestroy(this)
    })

    this.bumpIdle()
  }

  /** Attach a client: replay scrollback then live-pipe. Other viewers stay attached. */
  attach(ws: WebSocket): void {
    this.clearGrace()
    // Same socket, still attached (a Retry that kept this terminal): the
    // client's xterm already holds the output, so a replay would duplicate it.
    if (this.attached.has(ws)) {
      this.bumpIdle()
      return
    }
    this.attached.add(ws)
    const backlog = this.ring.read()
    if (backlog.length > 0) {
      sendToClient(ws, `terminal:data:${this.id}`, { data: backlog.toString('utf-8') })
    }
    this.bumpIdle()
  }

  /**
   * A client went away (WS close or explicit close). When it was the last one,
   * keep the pty alive for the grace period.
   */
  detach(ws: WebSocket): void {
    if (!this.attached.delete(ws)) return
    if (this.attached.size > 0) return
    this.clearGrace()
    this.graceTimer = setTimeout(() => {
      // Grace expired with no reattach: release the local pty/ssh connection.
      // The dtach session on the target host stays alive — reopen re-attaches.
      log.web.info('terminal grace expired, releasing pty', { terminalId: this.id })
      this.destroyPty()
    }, GRACE_MS)
  }

  isAttachedTo(ws: WebSocket): boolean {
    return this.attached.has(ws)
  }

  /** Any client currently attached (actively viewing)? */
  hasClient(): boolean {
    return this.attached.size > 0
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
      if (this.attached.size > 0) {
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
    this.attached.clear()
    this.destroyPty()
  }

  /**
   * This terminal is ended from outside its shell (`by`: the socket that asked):
   * every other window viewing it is told it exited, so none keeps showing a
   * live terminal. `endedElsewhere` says another window did it (one that shows
   * it, or a reopen replacing it); a tool or agent with no view of it, or the
   * server itself, is only "ended".
   */
  endBy(by?: WebSocket, byWindow = by !== undefined && this.attached.has(by)): void {
    for (const ws of this.attached) {
      if (ws !== by) sendToClient(ws, `terminal:exit:${this.id}`, { exitCode: 0, signal: null, ended: true, endedElsewhere: byWindow })
    }
    this.dispose()
  }

  /** Force-release on server shutdown. */
  shutdown(): void {
    this.clearTimers()
    try { this.pty.kill() } catch { /* already gone */ }
    this.ring.clear()
  }
}

class TerminalManager {
  /**
   * Live terminals by key (core/terminal-key.ts): slot 1 of a session is keyed by
   * the session id, slot n by `<sessionId>__term<n>`. The key is also the
   * terminalId the client holds and the name of the dtach socket.
   */
  private terminals = new Map<string, TerminalSession>()
  /**
   * In-flight open() promises keyed by terminal key. `open()` is async (spawns a
   * pty before inserting into the map), so a rapid second call — a double
   * click, or the mount effect racing the `_ws:reconnected` reopen — would not
   * yet see the first terminal and would spawn a SECOND pty (orphaned, wasting
   * an ssh connection). Coalescing on this map guarantees one pty per key.
   */
  private opening = new Map<string, Promise<OpenResult>>()
  /** Slots handed out for new terminals, by key, with when (reserveSlot). */
  private reserved = new Map<string, number>()

  /**
   * Open (or re-attach to) a session's terminal in `slot`. Reuses an existing
   * live terminal for the same key if present; otherwise spawns a new pty
   * (which `dtach -A` attaches to the persistent dtach session, or a plain
   * shell when `mode.persistent` is false).
   *
   * Mode rules for an existing terminal: a persistent one is always reused
   * (never downgraded); a plain one is reused for a plain request (a failed
   * Retry must not kill the shell the user is working in) and REPLACED for a
   * persistent request, which only comes from a Retry that found dtach.
   */
  async open(sessionId: string, ws: WebSocket, cols: number, rows: number, mode: TerminalMode = PERSISTENT, slot = 1): Promise<OpenResult> {
    const key = terminalKeyFor(sessionId, slot)
    const existing = this.terminals.get(key)
    if (existing) {
      if (existing.mode.persistent || !mode.persistent) {
        this.reserved.delete(key)
        if (!existing.mode.persistent) existing.mode = mode // fresher hint/detail
        existing.attach(ws)
        existing.resize(cols, rows)
        return { terminalId: existing.id, cols, rows, mode: existing.mode }
      }
      log.web.info('terminal upgrade: replacing plain shell with a persistent one', { sessionId, slot })
      // Other windows on the plain shell are told it ended (they reopen into the new one).
      existing.endBy(ws, true)
      this.terminals.delete(key)
    }

    // An open already on the way: this socket views the terminal it brings.
    const inFlight = this.opening.get(key)
    if (inFlight) {
      return inFlight.then((r) => {
        const t = this.terminals.get(key)
        if (t) this.attachLive(t, ws)
        return r
      })
    }

    const promise = this.spawnTerminal(sessionId, slot, ws, cols, rows, mode)
      .finally(() => this.opening.delete(key))
    this.opening.set(key, promise)
    return promise
  }

  private async spawnTerminal(sessionId: string, slot: number, ws: WebSocket, cols: number, rows: number, mode: TerminalMode): Promise<OpenResult> {
    const record = await getSessionByClaudeId(sessionId)
    if (!record) throw new Error(`Session not found: ${sessionId}`)

    const terminalId = terminalKeyFor(sessionId, slot)
    const { pty, host } = await resolveSpawnForSession(record, cols, rows, { persistent: mode.persistent, terminalKey: terminalId })
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
    this.terminals.set(terminalId, session)
    // The slot is its terminal's now: no reservation needed any more.
    this.reserved.delete(terminalId)
    this.attachLive(session, ws)
    log.web.info('terminal opened', { terminalId, sessionId, slot, host, persistent: mode.persistent })
    return { terminalId, cols, rows, mode }
  }

  /**
   * Attach a socket that may have closed while the shell spawned (ssh, dtach):
   * a closed one is let go at once, so the terminal's grace timer runs instead
   * of a dead viewer holding the pty forever.
   */
  private attachLive(t: TerminalSession, ws: WebSocket): void {
    t.attach(ws)
    if (ws.readyState === WS_CLOSING || ws.readyState === WS_CLOSED) t.detach(ws)
  }

  /** The shell's pid when `key` is a plain shell on this machine (no dtach between), else undefined. */
  plainLocalPid(key: string): number | undefined {
    const t = this.terminals.get(key)
    return t && !t.mode.persistent && !t.host ? t.ptyPid : undefined
  }

  /** Mode of the live terminal under `key` (a terminal key), or null when none is held. */
  liveMode(key: string): TerminalMode | null {
    return this.terminals.get(key)?.mode ?? null
  }

  /** Slots of a session's terminals this process holds now, with their mode. */
  liveSlots(sessionId: string): { slot: number; persistent: boolean }[] {
    const out: { slot: number; persistent: boolean }[] = []
    for (const t of this.terminals.values()) {
      if (t.sessionId !== sessionId) continue
      out.push({ slot: parseTerminalKey(t.id).slot, persistent: t.mode.persistent })
    }
    return out.sort((a, b) => a.slot - b.slot)
  }

  /**
   * Explicit end (the user's "End terminal", or a reaper deciding a plain
   * shell must go): release the local pty now instead of waiting out the
   * grace timer. For a persistent terminal the dtach session itself is killed
   * separately (killDtachSession); for a plain one this IS the kill.
   */
  end(terminalId: string, by?: WebSocket): void {
    this.terminals.get(terminalId)?.endBy(by)
    this.reserved.delete(terminalId)
  }

  /**
   * Hand out a slot for a new terminal of the session: the lowest one no live
   * terminal, no socket on its host (`hostSlots`), no recent reservation and no
   * slot the asking window already shows (`exclude`) takes. Two windows asking
   * at once get two slots, so neither opens the other's new shell. A
   * reservation lapses after RESERVE_MS or when its terminal opens.
   */
  reserveSlot(sessionId: string, exclude: readonly number[], hostSlots: readonly number[], now = Date.now()): number | null {
    for (const [key, at] of this.reserved) if (now - at > RESERVE_MS) this.reserved.delete(key)
    const taken = new Set<number>([...exclude, ...hostSlots, ...this.liveSlots(sessionId).map((t) => t.slot)])
    // Reserved lately, or opening now (its shell not spawned yet, so neither live nor on the host).
    for (const key of [...this.reserved.keys(), ...this.opening.keys()]) {
      const k = parseTerminalKey(key)
      if (k.sessionId === sessionId) taken.add(k.slot)
    }
    for (let slot = 1; slot <= MAX_TERMINAL_SLOTS; slot++) {
      if (taken.has(slot)) continue
      this.reserved.set(terminalKeyFor(sessionId, slot), now)
      return slot
    }
    return null
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
  close(terminalId: string, ws: WebSocket): void {
    this.terminals.get(terminalId)?.detach(ws)
  }

  /** A client socket disconnected — detach any terminal it was attached to. */
  onClientDisconnect(ws: WebSocket): void {
    for (const t of this.terminals.values()) {
      if (t.isAttachedTo(ws)) t.detach(ws)
    }
  }

  /**
   * Forget a destroyed terminal. Identity-checked: a replaced plain shell's pty
   * exits AFTER its persistent successor took the same key, and that late exit
   * must not forget the successor.
   */
  private handleDestroy(t: TerminalSession): void {
    if (this.terminals.get(t.id) !== t) return
    this.terminals.delete(t.id)
  }

  /**
   * Snapshot of the terminals this process currently holds, as
   * `{ sessionId, terminalKey, host }`. This in-memory map is the periodic
   * reaper's ENTRY POINT ("which terminals/hosts should I check") — NOT an
   * authority on what to kill. The reaper still decides kill/keep from ground
   * truth (the session registry + the live dtach process tree), so a
   * drifted/stale snapshot is harmless (at worst it checks a host that has
   * nothing to reap).
   */
  listActive(): { sessionId: string; terminalKey: string; host?: string }[] {
    const out: { sessionId: string; terminalKey: string; host?: string }[] = []
    for (const t of this.terminals.values()) {
      out.push({ sessionId: t.sessionId, terminalKey: t.id, host: t.host })
    }
    return out
  }

  /** Is a client actively viewing the terminal under `key` (a terminal key) right now? */
  isViewing(key: string): boolean {
    return this.terminals.get(key)?.hasClient() ?? false
  }

  /** Release all local ptys on server shutdown (dtach sessions survive). */
  shutdown(): void {
    for (const t of this.terminals.values()) t.shutdown()
    this.terminals.clear()
    this.reserved.clear()
  }
}

export const terminalManager = new TerminalManager()
