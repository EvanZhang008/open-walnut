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

import net from 'node:net'
import { Duplex } from 'node:stream'
import type { UploadPacer } from './upload-pacer.js'

export type StreamPeer = 'primary' | 'companion' | 'follower'

export interface IncomingStreamInfo {
  sid: string
  /** Who opened it, as the daemon saw the link. */
  from: string
  /** The Walnut it is for (the leader's data dir). */
  home?: string
  purpose?: string
  /** A hub stream's port on this server's loopback (`from: 'hub'`, hub-forward-v1). */
  port?: number
  /** An address the opener named; a hub stream that names one is refused (core/hosts/hub-ports.ts). */
  host?: string
}

/** What an incoming stream is plugged into; null refuses it. */
export type StreamPlug = ((stream: Duplex) => void) | null

export interface StreamEndpointOptions {
  /** Write one command frame to the daemon. Throws when the link is down. */
  send: (frame: Record<string, unknown>) => void
  /**
   * What to plug an incoming stream into; null refuses it, and so does a throw, with the
   * error's words. A promise decides later (a hub stream connects its port first): the opener
   * waits for the accept or the close until then, and a rejection refuses with its words.
   */
  accept?: (info: IncomingStreamInfo) => StreamPlug | Promise<StreamPlug>
  window?: number
  openTimeoutMs?: number
  /**
   * The pacer for a stream of this purpose ('' when it has none), or null to send
   * at once (upload-pacer.ts): a piece goes out once the pacer allows its bytes.
   * Acks, opens and ends are a few bytes and always go at once.
   */
  pace?: (purpose: string) => UploadPacer | null
  /** Told the frame bytes each stream sent, by its purpose ('' when it had none). */
  sent?: (purpose: string, bytes: number) => void
}

/** How a terminal's process ended, as the daemon saw it ('pty-stream-v1'). */
export interface PtyStreamExit {
  /** Its exit code; null when a signal ended it. */
  code: number | null
  /** The signal's name (`SIGHUP`), or null. */
  signal: string | null
}

/**
 * A terminal on the host (pty-stream-core.ts): its bytes both ways as a Duplex,
 * its size, and how it ended once its stream ended.
 */
export interface PtyStream extends Duplex {
  /** The process on the host's pty (its pid there). */
  readonly remotePid: number
  /** Set once the stream ended with the process's exit, after its last output. */
  readonly exit: PtyStreamExit | null
  resize(cols: number, rows: number): void
}

export interface PtyOpenOptions {
  cols: number
  rows: number
  /** LANG / LC_* for the shell, as ssh's SendEnv passes them; the daemon keeps only those. */
  env?: Record<string, string>
}

export interface StreamEndpoint {
  open(to: StreamPeer, opts?: { purpose?: string }): Promise<Duplex>
  /**
   * A stream to a TCP port on the daemon's own loopback ('port-stream-v1',
   * stream-relay-core.ts): what an `ssh -L` gives, through the link. `host` is
   * 127.x, ::1 or localhost; the daemon refuses anything else.
   */
  openPort(port: number, host: string): Promise<Duplex>
  /**
   * A terminal on the daemon's host running `command` under the login shell
   * ('pty-stream-v1'): what `ssh -tt host CMD` gives, through the link.
   */
  openPty(command: string, opts: PtyOpenOptions): Promise<PtyStream>
  /** One frame from the link; true when it was a stream frame. */
  handle(msg: Record<string, unknown>): boolean
  /** The link went down: every stream on it ends. */
  closeAll(reason: string): void
  size(): number
}

const CHUNK = 48 * 1024
const DEFAULT_WINDOW = 256 * 1024
const DEFAULT_OPEN_TIMEOUT_MS = 10_000
/** A data frame's bytes on the wire: the base64 of the piece and its JSON around it. */
const frameBytes = (n: number) => Math.ceil(n / 3) * 4 + 48

class LinkStream extends Duplex {
  unacked = 0
  heldAck = 0
  waiting: ((err?: Error | null) => void) | null = null
  localEnded = false
  remoteEnded = false
  remoteClosed = false
  remotePid = 0
  exit: PtyStreamExit | null = null

  constructor(private readonly ep: Endpoint, readonly sid: string, readonly purpose = '') {
    super({ allowHalfOpen: true })
  }

  override _write(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    const pace = this.ep.paceFor(this.purpose)
    if (pace) { void this.writePaced(chunk, pace, cb); return }
    try {
      for (let off = 0; off < chunk.length; off += CHUNK) this.sendPiece(chunk.subarray(off, off + CHUNK))
    } catch (err) {
      cb(err as Error)
      return
    }
    this.afterWrite(cb)
  }

  private async writePaced(chunk: Buffer, pace: UploadPacer, cb: (err?: Error | null) => void): Promise<void> {
    try {
      for (let off = 0; off < chunk.length; off += CHUNK) {
        const piece = chunk.subarray(off, off + CHUNK)
        await pace.take(frameBytes(piece.length))
        if (this.destroyed) { cb(new Error('stream closed')); return }
        this.sendPiece(piece)
      }
    } catch (err) {
      cb(err as Error)
      return
    }
    this.afterWrite(cb)
  }

  private sendPiece(piece: Buffer): void {
    const d = piece.toString('base64')
    this.ep.send({ cmd: 'stream.data', sid: this.sid, d })
    this.ep.noteSent(this.purpose, d.length + 48)
    this.unacked += piece.length
  }

  private afterWrite(cb: (err?: Error | null) => void): void {
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

  /** A terminal's size ('pty-stream-v1'); dropped once the stream is gone. */
  resize(cols: number, rows: number): void {
    if (this.destroyed || this.remoteEnded) return
    try { this.ep.send({ cmd: 'stream.resize', sid: this.sid, cols, rows }) } catch { /* gone */ }
  }

  onEnd(exit?: unknown): void {
    if (exit && typeof exit === 'object') {
      const e = exit as { code?: unknown; signal?: unknown }
      this.exit = { code: typeof e.code === 'number' ? e.code : null, signal: typeof e.signal === 'string' ? e.signal : null }
    }
    this.remoteEnded = true
    this.push(null)
    if (this.localEnded) this.ep.forget(this.sid)
  }

  onClose(error: unknown): void {
    this.remoteClosed = true
    this.cut(typeof error === 'string' && error ? new Error(error) : undefined)
  }

  /**
   * Ended from the far side or with the link. The error goes to whoever still
   * listens; an HTTP client lets go of its socket once its answer is in, and
   * an error nobody listens for would throw in the whole server.
   */
  cut(err?: Error): void {
    this.destroy(err && this.listenerCount('error') > 0 ? err : undefined)
  }
}

class Endpoint implements StreamEndpoint {
  readonly window: number
  private readonly openTimeoutMs: number
  private readonly streams = new Map<string, LinkStream>()
  private readonly opening = new Map<string, { resolve: (s: LinkStream) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout>; stream: LinkStream }>()
  private counter = 0
  /** Moves on at every closeAll (a link drop): an acceptor decided after it answers nothing. */
  private epoch = 0

  constructor(private readonly opts: StreamEndpointOptions) {
    this.window = opts.window ?? DEFAULT_WINDOW
    this.openTimeoutMs = opts.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS
  }

  send(frame: Record<string, unknown>): void {
    this.opts.send(frame)
  }

  paceFor(purpose: string): UploadPacer | null { return this.opts.pace?.(purpose) ?? null }

  noteSent(purpose: string, bytes: number): void {
    this.opts.sent?.(purpose, bytes)
  }

  forget(sid: string): void {
    this.streams.delete(sid)
  }

  size(): number {
    return this.streams.size
  }

  open(to: StreamPeer, opts: { purpose?: string } = {}): Promise<Duplex> {
    return this.openFrame({ to, ...(opts.purpose ? { purpose: opts.purpose } : {}) }, `the ${to}`, opts.purpose ?? '')
  }

  openPort(port: number, host: string): Promise<Duplex> {
    return this.openFrame({ to: 'port', port, host }, `port ${port} on the host`, '')
  }

  openPty(command: string, opts: PtyOpenOptions): Promise<PtyStream> {
    const fields = { to: 'pty', command, cols: opts.cols, rows: opts.rows, ...(opts.env ? { env: opts.env } : {}) }
    return this.openFrame(fields, 'the terminal on the host', '') as Promise<LinkStream>
  }

  private openFrame(fields: Record<string, unknown>, what: string, purpose: string): Promise<LinkStream> {
    const sid = `o${++this.counter}`
    const stream = new LinkStream(this, sid, purpose)
    this.streams.set(sid, stream)
    return new Promise<LinkStream>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.opening.delete(sid)
        stream.destroy()
        reject(new Error(`no answer from ${what} within ${Math.round(this.openTimeoutMs / 1000)}s`))
      }, this.openTimeoutMs)
      timer.unref?.()
      this.opening.set(sid, { resolve, reject, timer, stream })
      try {
        this.send({ cmd: 'stream.open', sid, ...fields })
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
      if (ev === 'stream-accept') {
        if (typeof msg.pid === 'number' && Number.isInteger(msg.pid)) pending.stream.remotePid = msg.pid
        pending.resolve(pending.stream)
        return true
      }
      pending.stream.remoteClosed = true
      pending.stream.destroy()
      pending.reject(new Error(typeof msg.error === 'string' && msg.error ? msg.error : 'the stream was refused'))
      return true
    }
    const stream = this.streams.get(sid)
    if (!stream) return true
    if (ev === 'stream-data') stream.onData(msg.d)
    else if (ev === 'stream-ack') stream.onAck(msg.n)
    else if (ev === 'stream-end') stream.onEnd(msg.exit)
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
      ...(typeof msg.port === 'number' ? { port: msg.port } : {}),
      // Any `host` the opener put in is passed on, so a hub stream that names one is refused.
      ...(msg.host !== undefined ? { host: typeof msg.host === 'string' ? msg.host.slice(0, 256) : `(${typeof msg.host})` } : {}),
    }
    let decided: StreamPlug | Promise<StreamPlug>
    try {
      decided = this.opts.accept?.(info) ?? null
    } catch (err) {
      this.refuse(sid, err)
      return
    }
    if (decided && typeof (decided as Promise<StreamPlug>).then === 'function') {
      // Decided later: by then the link may have closed or come back with the same id in use (a
      // daemon that restarted counts its ids anew). Then nothing is sent and the plug is never
      // called; the acceptor's own deadline lets go of what it holds.
      const epoch = this.epoch
      const stale = () => epoch !== this.epoch || this.streams.has(sid)
      ;(decided as Promise<StreamPlug>).then(
        (plug) => { if (!stale()) this.plugIncoming(sid, info, plug) },
        (err) => { if (!stale()) this.refuse(sid, err) },
      )
      return
    }
    this.plugIncoming(sid, info, decided as StreamPlug)
  }

  private refuse(sid: string, err?: unknown): void {
    const error = err instanceof Error && err.message ? err.message.slice(0, 200) : 'this server does not take that stream'
    try { this.send({ cmd: 'stream.close', sid, error }) } catch { /* gone */ }
  }

  private plugIncoming(sid: string, info: IncomingStreamInfo, plug: StreamPlug): void {
    if (!plug) {
      this.refuse(sid)
      return
    }
    const stream = new LinkStream(this, sid, info.purpose ?? '')
    // The owner may reject before a socket or HTTP consumer installs its listener.
    stream.on('error', () => {})
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
    this.epoch += 1
    for (const [sid, p] of [...this.opening]) {
      this.opening.delete(sid)
      clearTimeout(p.timer)
      p.stream.remoteClosed = true
      p.stream.destroy()
      p.reject(new Error(reason))
    }
    for (const stream of [...this.streams.values()]) {
      stream.remoteClosed = true
      stream.cut(new Error(reason))
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

export interface LoopbackForward {
  /** The 127.0.0.1 port that forwards. */
  readonly port: number
  readonly listening: boolean
  /** Connections plugged in now. */
  connections(): number
  /** Stop listening and cut every connection (what killing an `ssh -L` does). */
  close(): void
}

/**
 * Listen on 127.0.0.1 (a free port) and plug every connection into a stream of
 * its own from `open` (a port stream, say): a local forward with no ssh. A
 * connection whose stream cannot open (the link is down, nothing listens there)
 * is closed, and the next one tries again, so the same port works again once the
 * link is back.
 */
export function listenLoopback(
  open: () => Promise<Duplex>,
  onRefused?: (err: Error) => void,
): Promise<LoopbackForward> {
  const live = new Set<net.Socket>()
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    live.add(socket)
    socket.on('close', () => live.delete(socket))
    // Until the splice listens, an error here must not throw in the server.
    socket.on('error', () => {})
    open().then((stream) => {
      if (socket.destroyed) { stream.destroy(); return }
      spliceStream(stream, socket)
    }, (err: Error) => {
      onRefused?.(err)
      socket.destroy()
    })
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      server.on('error', () => {})
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      resolve({
        port,
        get listening() { return server.listening },
        connections: () => live.size,
        close: () => {
          server.close()
          for (const s of [...live]) s.destroy()
        },
      })
    })
  })
}
