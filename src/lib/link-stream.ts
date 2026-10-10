/**
 * A server's end of the byte streams its daemon links carry
 * (docs/plan/walnut-servers-everywhere.md, "One kind of link"; the daemon's
 * half is providers/stream-relay-core.ts).
 *
 * One endpoint per link. `open(to)` asks the daemon for a stream to another
 * server on that daemon and resolves to a Duplex once that server accepts;
 * `handle(frame)` takes the link's `stream-*` events; `accept` decides what an
 * incoming stream is plugged into (a connection to this server's own door).
 * The Duplex works anywhere a socket does: `pipe` it, or give it to
 * `http.request({createConnection})`.
 *
 * Flow control is end to end: a side keeps at most WINDOW bytes the other has
 * not acked, and acks only what its reader took. So nothing piles up in the
 * daemon or in either server, whatever the speed of the slowest hop.
 */

import { Duplex } from 'node:stream'

export type StreamPeer = 'primary' | 'companion' | 'follower'

export interface IncomingStreamInfo {
  sid: string
  /** Who opened it, as the daemon saw the link. */
  from: string
  /** The Walnut it is for (the leader's data dir). */
  home?: string
  purpose?: string
}

export interface StreamEndpointOptions {
  /** Write one command frame to the daemon. Throws when the link is down. */
  send: (frame: Record<string, unknown>) => void
  /** What to plug an incoming stream into; null refuses it. */
  accept?: (info: IncomingStreamInfo) => ((stream: Duplex) => void) | null
  window?: number
  openTimeoutMs?: number
}

export interface StreamEndpoint {
  open(to: StreamPeer, opts?: { purpose?: string }): Promise<Duplex>
  /** One frame from the link; true when it was a stream frame. */
  handle(msg: Record<string, unknown>): boolean
  /** The link went down: every stream on it ends. */
  closeAll(reason: string): void
  size(): number
}

const CHUNK = 48 * 1024
const DEFAULT_WINDOW = 256 * 1024
const DEFAULT_OPEN_TIMEOUT_MS = 10_000

class LinkStream extends Duplex {
  unacked = 0
  heldAck = 0
  waiting: ((err?: Error | null) => void) | null = null
  localEnded = false
  remoteEnded = false
  remoteClosed = false

  constructor(private readonly ep: Endpoint, readonly sid: string) {
    super({ allowHalfOpen: true })
  }

  override _write(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    try {
      for (let off = 0; off < chunk.length; off += CHUNK) {
        const piece = chunk.subarray(off, off + CHUNK)
        this.ep.send({ cmd: 'stream.data', sid: this.sid, d: piece.toString('base64') })
        this.unacked += piece.length
      }
    } catch (err) {
      cb(err as Error)
      return
    }
    if (this.unacked <= this.ep.window) cb()
    else this.waiting = cb
  }

  override _final(cb: (err?: Error | null) => void): void {
    this.localEnded = true
    try { this.ep.send({ cmd: 'stream.end', sid: this.sid }) } catch { /* the link is gone; close follows */ }
    if (this.remoteEnded) this.ep.forget(this.sid)
    cb()
  }

  override _read(): void {
    if (this.heldAck > 0) {
      const n = this.heldAck
      this.heldAck = 0
      try { this.ep.send({ cmd: 'stream.ack', sid: this.sid, n }) } catch { /* gone */ }
    }
  }

  override _destroy(err: Error | null, cb: (err: Error | null) => void): void {
    if (!this.remoteClosed && !(this.localEnded && this.remoteEnded)) {
      try { this.ep.send({ cmd: 'stream.close', sid: this.sid, ...(err ? { error: err.message.slice(0, 200) } : {}) }) } catch { /* gone */ }
    }
    this.ep.forget(this.sid)
    const w = this.waiting
    this.waiting = null
    if (w) w(err ?? new Error('stream closed'))
    cb(err)
  }

  onData(d: unknown): void {
    if (typeof d !== 'string') return
    const buf = Buffer.from(d, 'base64')
    if (this.push(buf)) {
      try { this.ep.send({ cmd: 'stream.ack', sid: this.sid, n: buf.length }) } catch { /* gone */ }
    } else {
      this.heldAck += buf.length
    }
  }

  onAck(n: unknown): void {
    if (typeof n !== 'number' || !(n > 0)) return
    this.unacked = Math.max(0, this.unacked - n)
    if (this.waiting && this.unacked <= this.ep.window) {
      const w = this.waiting
      this.waiting = null
      w()
    }
  }

  onEnd(): void {
    this.remoteEnded = true
    this.push(null)
    if (this.localEnded) this.ep.forget(this.sid)
  }

  onClose(error: unknown): void {
    this.remoteClosed = true
    this.destroy(typeof error === 'string' && error ? new Error(error) : undefined)
  }
}

class Endpoint implements StreamEndpoint {
  readonly window: number
  private readonly openTimeoutMs: number
  private readonly streams = new Map<string, LinkStream>()
  private readonly opening = new Map<string, { resolve: (s: Duplex) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout>; stream: LinkStream }>()
  private counter = 0

  constructor(private readonly opts: StreamEndpointOptions) {
    this.window = opts.window ?? DEFAULT_WINDOW
    this.openTimeoutMs = opts.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS
  }

  send(frame: Record<string, unknown>): void {
    this.opts.send(frame)
  }

  forget(sid: string): void {
    this.streams.delete(sid)
  }

  size(): number {
    return this.streams.size
  }

  open(to: StreamPeer, opts: { purpose?: string } = {}): Promise<Duplex> {
    const sid = `o${++this.counter}`
    const stream = new LinkStream(this, sid)
    this.streams.set(sid, stream)
    return new Promise<Duplex>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.opening.delete(sid)
        stream.destroy()
        reject(new Error(`no answer from the ${to} within ${Math.round(this.openTimeoutMs / 1000)}s`))
      }, this.openTimeoutMs)
      timer.unref?.()
      this.opening.set(sid, { resolve, reject, timer, stream })
      try {
        this.send({ cmd: 'stream.open', sid, to, ...(opts.purpose ? { purpose: opts.purpose } : {}) })
      } catch (err) {
        clearTimeout(timer)
        this.opening.delete(sid)
        this.streams.delete(sid)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  handle(msg: Record<string, unknown>): boolean {
    const ev = msg.ev
    if (typeof ev !== 'string' || !ev.startsWith('stream-')) return false
    const sid = typeof msg.sid === 'string' ? msg.sid : ''
    if (ev === 'stream-open') {
      this.incoming(msg, sid)
      return true
    }
    const pending = this.opening.get(sid)
    if (pending) {
      this.opening.delete(sid)
      clearTimeout(pending.timer)
      if (ev === 'stream-accept') { pending.resolve(pending.stream); return true }
      pending.stream.remoteClosed = true
      pending.stream.destroy()
      pending.reject(new Error(typeof msg.error === 'string' && msg.error ? msg.error : 'the stream was refused'))
      return true
    }
    const stream = this.streams.get(sid)
    if (!stream) return true
    if (ev === 'stream-data') stream.onData(msg.d)
    else if (ev === 'stream-ack') stream.onAck(msg.n)
    else if (ev === 'stream-end') stream.onEnd()
    else if (ev === 'stream-close') stream.onClose(msg.error)
    return true
  }

  private incoming(msg: Record<string, unknown>, sid: string): void {
    if (!/^r[A-Za-z0-9_-]{1,63}$/.test(sid)) return
    const info: IncomingStreamInfo = {
      sid,
      from: typeof msg.from === 'string' ? msg.from : '',
      ...(typeof msg.home === 'string' ? { home: msg.home } : {}),
      ...(typeof msg.purpose === 'string' ? { purpose: msg.purpose } : {}),
    }
    const plug = this.opts.accept?.(info) ?? null
    if (!plug) {
      try { this.send({ cmd: 'stream.close', sid, error: 'this server does not take that stream' }) } catch { /* gone */ }
      return
    }
    const stream = new LinkStream(this, sid)
    this.streams.set(sid, stream)
    try {
      this.send({ cmd: 'stream.accept', sid })
    } catch {
      this.streams.delete(sid)
      return
    }
    plug(stream)
  }

  closeAll(reason: string): void {
    for (const [sid, p] of [...this.opening]) {
      this.opening.delete(sid)
      clearTimeout(p.timer)
      p.stream.remoteClosed = true
      p.stream.destroy()
      p.reject(new Error(reason))
    }
    for (const stream of [...this.streams.values()]) {
      stream.remoteClosed = true
      stream.destroy(new Error(reason))
    }
    this.streams.clear()
  }
}

export function createStreamEndpoint(opts: StreamEndpointOptions): StreamEndpoint {
  return new Endpoint(opts)
}

/**
 * Plug a stream into a socket, both ways. A side that ended passes its FIN on
 * and lets the other flush; one that was cut (an error, an abort) cuts the other.
 */
export function spliceStream(stream: Duplex, socket: Duplex): void {
  stream.on('error', () => socket.destroy())
  socket.on('error', () => stream.destroy())
  stream.on('close', () => { if (!socket.writableEnded) socket.destroy() })
  socket.on('close', () => { if (!stream.writableEnded) stream.destroy() })
  stream.pipe(socket)
  socket.pipe(stream)
}
