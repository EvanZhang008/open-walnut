/**
 * The server's link to a session daemon that runs in this same process (experiment
 * `in_process_daemon`, in-process-daemon.ts). DaemonConnection talks to every daemon through a
 * WebSocket; this object stands where that socket stands, with no socket and no JSON between:
 *   - a command goes over as the object DaemonConnection built (sendFrame), straight into the
 *     runtime's command handler;
 *   - a reply or an event comes back as the object the runtime built, emitted as 'frame'.
 * The socket surface DaemonConnection uses (on/off, readyState, ping/pong, close, terminate,
 * send of a string) is kept so every other path of DaemonConnection runs unchanged: a string a
 * caller still sends (a rare path that builds its own text) is parsed once and handed over the same way.
 *
 * Frames are shared objects, not copies: neither side mutates one it was handed.
 */
import { EventEmitter } from 'node:events'

/** One client of an in-process runtime: what DaemonRuntime.connect() returns. */
export interface InProcessDaemonClient {
  /** A command frame ({ id, cmd, ...params }): its reply comes back through onFrame. */
  send(frame: Record<string, unknown>): void
  close(): void
}

export type InProcessConnect = (onFrame: (frame: Record<string, unknown>) => void, onClose: () => void) => InProcessDaemonClient

/** Where DaemonConnection dials an in-process daemon (LocalDaemon.wsUrl while it runs one). */
export const IN_PROCESS_DAEMON_URL = 'inproc://local-daemon'

const OPEN = 1
const CLOSED = 3

export class InProcessDaemonSocket extends EventEmitter {
  readyState = 0
  /** Nothing waits in a buffer: a frame is handed over in the call. */
  readonly bufferedAmount = 0
  private client: InProcessDaemonClient | null = null

  constructor(connect: InProcessConnect) {
    super()
    // Opened on the next turn, as a socket is: DaemonConnection registers its listeners first.
    queueMicrotask(() => {
      if (this.readyState !== 0) return
      try {
        this.client = connect(
          (frame) => { if (this.readyState === OPEN) this.emit('frame', frame) },
          () => this.closed(),
        )
      } catch (err) {
        this.readyState = CLOSED
        this.emit('error', err instanceof Error ? err : new Error(String(err)))
        this.emit('close', 1011, Buffer.from('in-process daemon refused the client'))
        return
      }
      this.readyState = OPEN
      this.emit('open')
    })
  }

  /** A command as the object it is. */
  sendFrame(frame: Record<string, unknown>): void {
    if (this.readyState !== OPEN || !this.client) throw new Error('in-process daemon link is closed')
    this.client.send(frame)
  }

  /** A command some path built as text: parsed once, then handed over as an object. */
  send(message: string | Buffer): void {
    let frame: unknown
    try { frame = JSON.parse(typeof message === 'string' ? message : message.toString()) } catch { return }
    if (frame && typeof frame === 'object' && !Array.isArray(frame)) this.sendFrame(frame as Record<string, unknown>)
  }

  /** The runtime answers at once while it runs: the pong carries the ping's payload back (RFC 6455). */
  ping(data?: Buffer | string): void {
    if (this.readyState !== OPEN) return
    const payload = data === undefined ? Buffer.alloc(0) : Buffer.isBuffer(data) ? data : Buffer.from(String(data))
    queueMicrotask(() => { if (this.readyState === OPEN) this.emit('pong', payload) })
  }

  close(): void { this.end(true) }
  terminate(): void { this.end(true) }

  /** The runtime closed this client (stop(), another client took its place). */
  private closed(): void { this.end(false) }

  private end(ours: boolean): void {
    if (this.readyState === CLOSED) return
    const wasOpen = this.readyState === OPEN
    this.readyState = CLOSED
    const client = this.client
    this.client = null
    if (ours && client) { try { client.close() } catch { /* already closed */ } }
    if (wasOpen || ours) queueMicrotask(() => this.emit('close', 1000, Buffer.alloc(0)))
  }
}

export const isInProcessDaemonSocket = (socket: unknown): socket is InProcessDaemonSocket => socket instanceof InProcessDaemonSocket
