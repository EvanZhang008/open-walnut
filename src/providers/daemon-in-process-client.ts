/**
 * A client of a daemon runtime inside the same process (DaemonRuntime.connect, daemon-standalone.ts):
 * the whole surface a socket client has (its commands, its replies, the events it subscribed to),
 * with no socket and no JSON between.
 *   - A command is handed to the runtime's command handler as the object it is, in the call.
 *   - A command the runtime answers by function (`direct`, daemon-standalone.ts callCommand) can
 *     be called instead (call()): its reply comes back from the call, never through onFrame, the
 *     queue or a later turn; the runtime runs the same gates for it as for a frame. So a direct
 *     reply can reach the caller before events the runtime queued for this client earlier (a
 *     triggers.run's trigger.fired, say): no caller may read a reply as "its events came first".
 *   - What the runtime sends this client (sendFrame) arrives as the object it built, in order, on
 *     a later turn of the loop (setImmediate): as off a socket, never inside the command that sent
 *     it, and never in the same turn as the runtime's own work. A backlog is handed over under the
 *     loop's shared budget (loop-budget.ts), so the loop's timers and requests run between.
 *   - A frame the runtime still has only as text (a relay that forwards bytes) is parsed once.
 * Frames are shared objects: neither side mutates one it was handed, and each is what JSON could
 * carry. With `checkFrames` (tests, WALNUT_IN_PROCESS_FRAME_CHECK=1 in the runtime's env) both hold
 * for every frame either way: it is frozen (a write throws) and one that JSON would change (a Date,
 * a Map, a Buffer, an undefined field) is reported.
 *
 * The runtime sees the client as one of its sockets (`ws`): it is in its client set, the keepalive
 * pings it (answered at once), and its close goes through the runtime's disconnect.
 */

import { sharedLoopBudget, type LoopBudget } from './loop-budget.js'

export type Frame = Record<string, unknown>

export interface InProcessClientDeps<Ws> {
  /** The runtime's command handler for one frame from `ws`. */
  handleCommandFrame(ws: Ws, frame: Frame): void
  /** The commands the runtime answers by function, and the call of one (its reply frame). */
  direct?: { has(cmd: unknown): boolean; call(ws: Ws, frame: Frame): Promise<Frame> | null }
  /** The client joined (the runtime's client set). */
  register(ws: Ws): void
  /** The client left: the runtime's disconnect (subscriptions, relays). */
  unregister(ws: Ws): void
  /** Proof of life (the runtime's keepalive). */
  heardFrom(ws: Ws): void
  warn(msg: string, data: Record<string, unknown>): void
  /** Freeze every frame and report one JSON would change (tests). */
  checkFrames?: boolean
}

function deepFreeze(value: unknown): void {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return
  Object.freeze(value)
  for (const v of Object.values(value)) deepFreeze(v)
}

/** Whether `a` is exactly what JSON gives back for it (plain objects, arrays, strings, finite numbers, booleans, null). */
export function isPlainJson(a: unknown): boolean {
  if (a === null || typeof a === 'string' || typeof a === 'boolean') return true
  if (typeof a === 'number') return Number.isFinite(a)
  if (Array.isArray(a)) return a.every(isPlainJson)
  if (typeof a !== 'object') return false
  const proto = Object.getPrototypeOf(a)
  if (proto !== Object.prototype && proto !== null) return false
  return Object.values(a as Record<string, unknown>).every((v) => v !== undefined && isPlainJson(v))
}

export interface InProcessClient {
  send(frame: Frame): void
  /**
   * A command frame the runtime answers by function: its reply frame (null when the client closed
   * before it came). null at once for any other command: send() it.
   */
  call(frame: Frame): Promise<Frame | null> | null
  request(cmd: string, params?: Record<string, unknown>): Promise<Frame>
  close(): void
}

/** The socket-shaped object the runtime holds for one in-process client. */
export interface InProcessWs {
  data: Record<string, unknown> & { deliverFrame: (frame: Frame) => void }
  readyState: number
  send(payload: string): number
  ping(): void
  terminate(): void
  close(): void
}

const OPEN = 1
const CLOSED = 3

export function createInProcessClient<Ws>(
  deps: InProcessClientDeps<Ws>,
  onFrame: (frame: Frame) => void,
  onClose?: () => void,
  budget: LoopBudget = sharedLoopBudget,
): { client: InProcessClient; ws: InProcessWs } {
  // request()'s own ids count down from -1: a caller's send() uses positive ones, as on a socket.
  let nextOwnId = 0
  let closedByClient = false
  const waiting = new Map<number, (frame: Frame) => void>()
  const queue: Frame[] = []
  let flushing = false
  let head = 0
  const flush = () => {
    while (head < queue.length) {
      if (budget.over()) { setImmediate(flush); return }
      const frame = queue[head]!
      queue[head++] = undefined as unknown as Frame
      // An answer carries its command's id; an event (`ev`) is never one, whatever its fields.
      const own = typeof frame.id === 'number' && frame.id < 0 && frame.ev === undefined ? waiting.get(frame.id) : undefined
      if (own) { waiting.delete(frame.id as number); own(frame); continue }
      try { onFrame(frame) } catch (err) { deps.warn('in-process client: frame handler threw', { error: err instanceof Error ? (err.stack ?? err.message) : String(err) }) }
    }
    queue.length = 0
    head = 0
    flushing = false
  }
  const checked = (frame: Frame, way: string): Frame => {
    if (!deps.checkFrames) return frame
    if (!isPlainJson(frame)) deps.warn('in-process frame is not plain JSON', { way, cmd: frame.cmd, ev: frame.ev, id: frame.id })
    deepFreeze(frame)
    return frame
  }
  const deliver = (frame: Frame) => {
    if (ws.readyState !== OPEN) return
    checked(frame, 'to the client')
    queue.push(frame)
    if (!flushing) { flushing = true; setImmediate(flush) }
  }
  const ws: InProcessWs = {
    data: { deliverFrame: deliver },
    readyState: OPEN,
    // Text the runtime had as text only: parsed once, then handed over as above.
    send(payload: string): number {
      if (ws.readyState !== OPEN) return 0
      try {
        const frame = JSON.parse(payload) as unknown
        if (frame && typeof frame === 'object' && !Array.isArray(frame)) deliver(frame as Frame)
      } catch { /* not a frame */ }
      return payload.length || 1
    },
    // Nothing between: a ping is answered at once (the keepalive hears it).
    ping(): void { deps.heardFrom(socket) },
    terminate(): void { ws.close() },
    close(): void {
      if (ws.readyState !== OPEN) return
      ws.readyState = CLOSED
      queue.length = 0
      head = 0
      deps.unregister(socket)
      for (const answer of waiting.values()) answer({ ok: false, error: 'client closed' })
      waiting.clear()
      if (!closedByClient && onClose) {
        try { onClose() } catch (err) { deps.warn('in-process client: close handler threw', { error: String(err) }) }
      }
    },
  }
  const socket = ws as unknown as Ws
  deps.heardFrom(socket)
  deps.register(socket)

  // The handler answers its own errors; one that escapes it is answered here, never thrown at the caller.
  const failed = (frame: Frame, err: unknown): Frame => {
    deps.warn('in-process client: command handler threw', { cmd: frame.cmd, error: err instanceof Error ? (err.stack ?? err.message) : String(err) })
    return { id: frame.id, ok: false, error: `daemon command failed: ${err instanceof Error ? err.message : String(err)}` }
  }
  const handOver = (frame: Frame) => {
    checked(frame, 'to the runtime')
    deps.heardFrom(socket)
    try { deps.handleCommandFrame(socket, frame) } catch (err) {
      const reply = failed(frame, err)
      if (typeof frame.id === 'number') deliver(reply)
    }
  }
  const call = (frame: Frame): Promise<Frame | null> | null => {
    if (ws.readyState !== OPEN) throw new Error('in-process daemon client is closed')
    if (!deps.direct?.has(frame.cmd)) return null
    checked(frame, 'to the runtime')
    deps.heardFrom(socket)
    let answered: Promise<Frame> | null
    try { answered = deps.direct.call(socket, frame) } catch (err) { answered = Promise.resolve(failed(frame, err)) }
    if (!answered) return null
    // A reply to a client that closed meanwhile is dropped, as a frame to it would be.
    return answered.then((reply) => (ws.readyState === OPEN ? checked(reply, 'to the client') : null), (err) => (ws.readyState === OPEN ? failed(frame, err) : null))
  }
  const client: InProcessClient = {
    send(frame) {
      if (ws.readyState !== OPEN) throw new Error('in-process daemon client is closed')
      handOver(frame)
    },
    call,
    request(cmd, params = {}) {
      if (ws.readyState !== OPEN) return Promise.resolve({ ok: false, error: 'client closed' })
      const id = --nextOwnId
      return new Promise((resolve) => {
        waiting.set(id, resolve)
        const frame = { ...params, id, cmd }
        const answered = call(frame)
        if (!answered) { handOver(frame); return }
        void answered.then((reply) => {
          const own = waiting.get(id)
          if (own && reply) { waiting.delete(id); own(reply) }
        })
      })
    },
    close() { closedByClient = true; ws.close() },
  }
  return { client, ws }
}
