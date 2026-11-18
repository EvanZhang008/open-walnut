/**
 * Byte streams between two servers, through this daemon
 * (docs/plan/walnut-servers-everywhere.md, "One kind of link").
 *
 * Every server links to daemons only: the Mac over SSH, the companion through
 * the bridge the daemon dials, a host server over loopback. When one server
 * needs another (a host server's browser reaching the Mac, the Mac pushing its
 * copy to the host server) it asks a daemon both are linked to for a stream,
 * and the daemon passes the frames from one link to the other:
 *
 *   server A ──stream.open {sid, to}──────▶ daemon ──stream-open {sid', from}──▶ server B
 *            ◀──stream-accept {sid}───────        ◀──stream.accept {sid'}───────
 *   then stream.data / .ack / .end / .close the same way, either direction.
 *
 * The daemon holds no bytes: a frame goes on as it came. Each end acks what it
 * took (link-stream.ts keeps a window), so a slow end slows its peer, never the
 * daemon. `end` is one side's FIN; the pair is forgotten once both ends ended,
 * or at a `close` (an abort, with an optional error), or when either link drops.
 *
 * A port stream ('port-stream-v1') has a TCP connection as its other end: the
 * primary asks for `stream.open {sid, to: 'port', port, host}` and the daemon
 * connects to that port on its OWN loopback (127.0.0.0/8, ::1; `localhost`
 * tries 127.0.0.1 then ::1), never another address. It is what an `ssh -L` gives
 * a host reached over SSH, for a host reached over the host network (a service
 * preview, the embedded VS Code). The daemon then keeps the same window the
 * other end keeps: it stops reading the socket while WINDOW bytes it sent are
 * not acked, and acks the link's bytes only once the socket took them. FINs pass
 * both ways (half close); a socket error, an abort or a link drop closes the
 * stream, and a connected socket is reset then, never ended as if the request were done.
 *
 * A terminal stream ('pty-stream-v1', `stream.open {sid, to: 'pty', ...}`) has a
 * pty on this host as its other end: pty-stream-core.ts, handed in as `ptys`, so
 * every stream on a link shares one id space, one frame dispatch and one drop.
 *
 * Shared by both daemon twins: daemon-standalone.ts imports it, daemon-source.ts
 * inlines its `toString()` through `__CREATE_STREAM_RELAY__`. So the factory
 * body references NOTHING at module scope.
 */

/** The TCP socket a port stream plugs into (node:net Socket, opened with allowHalfOpen). */
export interface PortSocket {
  on(ev: 'connect' | 'end' | 'close', fn: () => void): unknown
  on(ev: 'data', fn: (chunk: Uint8Array) => void): unknown
  on(ev: 'error', fn: (err: Error & { code?: string }) => void): unknown
  write(chunk: Uint8Array, cb: (err?: Error | null) => void): boolean
  end(): void
  destroy(): void
  /** An abort (RST), so the service never takes a cut stream for a finished one. */
  resetAndDestroy?(): void
  pause(): void
  resume(): void
}

export interface StreamRelayDeps<L> {
  /** Send one event frame to a link (the daemon's sendEvent). */
  send: (link: L, ev: string, data: Record<string, unknown>) => void
  log: (level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>) => void
  /** Connect to `port` on `host` (a loopback address the relay chose). Without it, port streams are refused. */
  connect?: (port: number, host: string) => PortSocket
  /** How long a port stream waits for its connection (default 8s, under the opener's 10s). */
  connectTimeoutMs?: number
  /** Terminal streams (pty-stream-core.ts createPtyStreams). Without them, terminal streams are refused. */
  ptys?: {
    open(from: L, sid: string, msg: Record<string, unknown>): void
    frame(link: L, kind: string, msg: Record<string, unknown>): void
    dropLink(link: L): void
    has(link: L, sid: string): boolean
    count(link?: L): number
  }
}

export function createStreamRelay<L>(deps: StreamRelayDeps<L>) {
  const MAX_PER_LINK = 64
  /** base64 of 96 KB; link-stream.ts sends 48 KB pieces. */
  const MAX_DATA_CHARS = 128 * 1024
  /** Ids the opener picks; the daemon's own start with `r`, so they never meet. */
  const OPENER_SID = /^o[A-Za-z0-9_-]{1,63}$/

  interface End { link: L; sid: string; ended: boolean }
  interface Pair { a: End; b: End; accepted: boolean }
  const byLink = new Map<L, Map<string, Pair>>()
  let counter = 0

  // Port streams: one TCP connection on this host's loopback per stream.
  const MAX_PORTS_PER_LINK = 128
  const PORT_WINDOW = 256 * 1024
  /** Pieces as link-stream.ts sends them: their base64 stays under MAX_DATA_CHARS. */
  const PORT_PIECE = 48 * 1024
  const PORT_CONNECT_MS = deps.connectTimeoutMs ?? 8_000
  interface PortEnd {
    link: L; sid: string; port: number; sock: PortSocket | null
    connected: boolean; unacked: number; paused: boolean
    /** The link's FIN went into the socket / the socket's FIN went to the link. */
    linkEnded: boolean; sockEnded: boolean
    /** An earlier address refused (localhost's 127.0.0.1): the answer if the next one fails too. */
    refused: boolean
    timer: ReturnType<typeof setTimeout> | null
  }
  const portsByLink = new Map<L, Map<string, PortEnd>>()

  /** The loopback addresses a port stream to `host` may try, in order; null: not this host's loopback. */
  function loopbackHosts(host: unknown): string[] | null {
    if (host === undefined || host === 'localhost') return ['127.0.0.1', '::1']
    if (host === '::1' || host === '[::1]') return ['::1']
    if (typeof host === 'string' && /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) && host.split('.').every((o) => Number(o) <= 255)) return [host]
    return null
  }

  /** One id space per link: a pair's, a port stream's and a terminal's ids never meet. */
  function sidInUse(link: L, sid: string): boolean {
    return (byLink.get(link)?.has(sid) ?? false) || (portsByLink.get(link)?.has(sid) ?? false) || (deps.ptys?.has(link, sid) ?? false)
  }

  function portTracked(end: PortEnd): boolean {
    return portsByLink.get(end.link)?.get(end.sid) === end
  }

  function forgetPort(end: PortEnd): void {
    if (end.timer) { clearTimeout(end.timer); end.timer = null }
    const m = portsByLink.get(end.link)
    if (!m || m.get(end.sid) !== end) return
    m.delete(end.sid)
    if (m.size === 0) portsByLink.delete(end.link)
  }

  /**
   * Cut a port stream's socket: a reset once connected (a FIN would tell the
   * service the request ended well), a plain destroy while it still connects.
   */
  function cutSocket(end: PortEnd): void {
    const sock = end.sock
    if (!sock) return
    try {
      if (end.connected && typeof sock.resetAndDestroy === 'function') sock.resetAndDestroy()
      else sock.destroy()
    } catch {
      try { sock.destroy() } catch { /* already gone */ }
    }
  }

  /** End a port stream at both sides: the link hears `error`, the socket is cut. */
  function abortPort(end: PortEnd, error: string): void {
    if (!portTracked(end)) return
    forgetPort(end)
    deps.send(end.link, 'stream-close', { sid: end.sid, error })
    cutSocket(end)
  }

  function socketError(err: Error & { code?: string }, port: number): string {
    if (err.code === 'ECONNREFUSED') return `nothing is listening on port ${port} on this host`
    return `port ${port} on this host: ${String(err.message || err.code || 'connection failed').slice(0, 160)}`
  }

  function dialPort(end: PortEnd, hosts: string[], i: number): void {
    const connect = deps.connect
    if (!connect) return
    let sock: PortSocket
    try {
      sock = connect(end.port, hosts[i])
    } catch (err) {
      abortPort(end, socketError(err as Error, end.port))
      return
    }
    end.sock = sock
    const mine = () => end.sock === sock && portTracked(end)
    sock.on('connect', () => {
      if (!mine()) return
      if (end.timer) { clearTimeout(end.timer); end.timer = null }
      end.connected = true
      deps.send(end.link, 'stream-accept', { sid: end.sid })
    })
    sock.on('data', (chunk) => {
      if (!mine()) return
      for (let off = 0; off < chunk.length; off += PORT_PIECE) {
        const piece = chunk.subarray(off, off + PORT_PIECE)
        deps.send(end.link, 'stream-data', { sid: end.sid, d: Buffer.from(piece.buffer, piece.byteOffset, piece.length).toString('base64') })
        end.unacked += piece.length
      }
      if (end.unacked > PORT_WINDOW && !end.paused) { end.paused = true; sock.pause() }
    })
    sock.on('end', () => {
      if (!mine() || end.sockEnded) return
      end.sockEnded = true
      deps.send(end.link, 'stream-end', { sid: end.sid })
      if (end.linkEnded) forgetPort(end)
    })
    sock.on('error', (err) => {
      if (!mine()) return
      // `localhost` is 127.0.0.1 or ::1: a server on one of them refuses on the other.
      if (!end.connected && err.code === 'ECONNREFUSED' && i + 1 < hosts.length) { end.refused = true; dialPort(end, hosts, i + 1); return }
      // ::1 may not exist at all (EADDRNOTAVAIL): the refusal on 127.0.0.1 is the answer then.
      abortPort(end, !end.connected && end.refused ? socketError(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }), end.port) : socketError(err, end.port))
    })
    sock.on('close', () => {
      // Closed without an error and without both FINs (a reset): the link hears it.
      if (mine()) abortPort(end, 'the connection on this host closed')
    })
  }

  /**
   * `from` (the primary, checked by the caller) asks for a stream to `port` on
   * this host's loopback. Refused (a `stream-close` with why) for a bad port, a
   * host that is not loopback, or a daemon without `connect`.
   */
  function openPort(from: L, sid: unknown, port: unknown, host: unknown): void {
    if (typeof sid !== 'string' || !OPENER_SID.test(sid)) return
    const refuse = (error: string) => deps.send(from, 'stream-close', { sid, error })
    if (sidInUse(from, sid)) return refuse('that stream id is already in use')
    if (!deps.connect) return refuse('this daemon opens no port streams')
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
      return refuse(`not a TCP port: ${String(port).slice(0, 24)}`)
    }
    const hosts = loopbackHosts(host)
    if (!hosts) return refuse('a port stream reaches only this host\'s own loopback (127.0.0.1, localhost or ::1)')
    if ((portsByLink.get(from)?.size ?? 0) >= MAX_PORTS_PER_LINK) return refuse('too many port streams on this link')
    const end: PortEnd = { link: from, sid, port, sock: null, connected: false, unacked: 0, paused: false, linkEnded: false, sockEnded: false, refused: false, timer: null }
    let m = portsByLink.get(from)
    if (!m) { m = new Map(); portsByLink.set(from, m) }
    m.set(sid, end)
    const timer = setTimeout(() => {
      end.timer = null
      if (!end.connected) abortPort(end, `nothing answered on port ${port} on this host within ${Math.round(PORT_CONNECT_MS / 1000)}s`)
    }, PORT_CONNECT_MS)
    timer.unref?.()
    end.timer = timer
    dialPort(end, hosts, 0)
  }

  /**
   * `from` (the primary, checked by the caller) asks for a terminal on this host
   * (`msg`: command, cols, rows, env). Refused for a daemon without `ptys`.
   */
  function openPty(from: L, sid: unknown, msg: Record<string, unknown>): void {
    if (typeof sid !== 'string' || !OPENER_SID.test(sid)) return
    if (sidInUse(from, sid)) { deps.send(from, 'stream-close', { sid, error: 'that stream id is already in use' }); return }
    if (!deps.ptys) { deps.send(from, 'stream-close', { sid, error: 'this daemon opens no terminal streams' }); return }
    deps.ptys.open(from, sid, msg)
  }

  /** A frame from the link for one of its port streams. */
  function portFrame(end: PortEnd, kind: string, msg: Record<string, unknown>): void {
    const sock = end.sock
    if (kind === 'data') {
      if (!end.connected || end.linkEnded || !sock || typeof msg.d !== 'string' || msg.d.length > MAX_DATA_CHARS) {
        deps.log('warn', 'stream relay: a bad data frame ends the port stream', { sid: end.sid, port: end.port })
        abortPort(end, 'bad data frame')
        return
      }
      const buf = Buffer.from(msg.d, 'base64')
      if (buf.length === 0) return
      // Acked once the socket took it: a slow reader here slows the sender there.
      sock.write(buf, (err) => { if (!err && portTracked(end)) deps.send(end.link, 'stream-ack', { sid: end.sid, n: buf.length }) })
      return
    }
    if (kind === 'ack') {
      const n = msg.n
      if (typeof n !== 'number' || !(n > 0) || n > 64 * 1024 * 1024) return
      end.unacked = Math.max(0, end.unacked - n)
      if (end.paused && end.unacked <= PORT_WINDOW) { end.paused = false; sock?.resume() }
      return
    }
    if (kind === 'end') {
      if (end.linkEnded) return
      if (!end.connected || !sock) { abortPort(end, 'ended before it was open'); return }
      end.linkEnded = true
      sock.end()
      if (end.sockEnded) forgetPort(end)
      return
    }
    if (kind === 'close') {
      forgetPort(end)
      cutSocket(end)
    }
    // 'accept' is the daemon's own word here: nothing to do.
  }

  function onLink(link: L): Map<string, Pair> {
    let m = byLink.get(link)
    if (!m) { m = new Map(); byLink.set(link, m) }
    return m
  }

  function forget(pair: Pair): void {
    for (const end of [pair.a, pair.b]) {
      const m = byLink.get(end.link)
      if (!m) continue
      m.delete(end.sid)
      if (m.size === 0) byLink.delete(end.link)
    }
  }

  function find(link: L, sid: string): { pair: Pair; me: End; other: End } | null {
    const pair = byLink.get(link)?.get(sid)
    if (!pair) return null
    const me = pair.a.link === link && pair.a.sid === sid ? pair.a : pair.b
    return { pair, me, other: me === pair.a ? pair.b : pair.a }
  }

  function abort(pair: Pair, error: string): void {
    forget(pair)
    deps.send(pair.a.link, 'stream-close', { sid: pair.a.sid, error })
    deps.send(pair.b.link, 'stream-close', { sid: pair.b.sid, error })
  }

  /**
   * `from` asks for a stream to `to` (null: nobody there, `why` says so).
   * `meta` goes to the other end with the open (who asks, for which Walnut).
   */
  function open(from: L, sid: unknown, to: L | null, meta: Record<string, unknown>, why?: string): void {
    if (typeof sid !== 'string' || !OPENER_SID.test(sid)) return
    if (sidInUse(from, sid)) {
      deps.send(from, 'stream-close', { sid, error: 'that stream id is already in use' })
      return
    }
    if (!to || to === from) {
      deps.send(from, 'stream-close', { sid, error: why ?? 'nobody there' })
      return
    }
    if ((byLink.get(from)?.size ?? 0) >= MAX_PER_LINK || (byLink.get(to)?.size ?? 0) >= MAX_PER_LINK) {
      deps.send(from, 'stream-close', { sid, error: 'too many streams on this link' })
      return
    }
    const pair: Pair = { a: { link: from, sid, ended: false }, b: { link: to, sid: `r${++counter}`, ended: false }, accepted: false }
    onLink(from).set(pair.a.sid, pair)
    onLink(to).set(pair.b.sid, pair)
    deps.send(to, 'stream-open', { ...meta, sid: pair.b.sid })
  }

  /** One frame (`accept`, `data`, `ack`, `end`, `close`) from `from` for one of its streams. */
  function frame(from: L, kind: string, msg: Record<string, unknown>): void {
    const sid = msg.sid
    if (typeof sid !== 'string') return
    const port = portsByLink.get(from)?.get(sid)
    if (port) { portFrame(port, kind, msg); return }
    if (deps.ptys?.has(from, sid)) { deps.ptys.frame(from, kind, msg); return }
    const hit = find(from, sid)
    if (!hit) {
      // A late frame for a stream that is gone: say so, except to a close (no echo loop).
      if (kind !== 'close') deps.send(from, 'stream-close', { sid, error: 'no such stream' })
      return
    }
    const { pair, me, other } = hit
    if (kind === 'accept') {
      if (me !== pair.b || pair.accepted) return
      pair.accepted = true
      deps.send(other.link, 'stream-accept', { sid: other.sid })
      return
    }
    if (kind === 'data') {
      if (!pair.accepted || me.ended || typeof msg.d !== 'string' || msg.d.length > MAX_DATA_CHARS) {
        deps.log('warn', 'stream relay: a bad data frame ends the stream', { sid })
        abort(pair, 'bad data frame')
        return
      }
      deps.send(other.link, 'stream-data', { sid: other.sid, d: msg.d })
      return
    }
    if (kind === 'ack') {
      const n = msg.n
      if (typeof n !== 'number' || !(n > 0) || n > 64 * 1024 * 1024) return
      deps.send(other.link, 'stream-ack', { sid: other.sid, n })
      return
    }
    if (kind === 'end') {
      if (me.ended) return
      me.ended = true
      deps.send(other.link, 'stream-end', { sid: other.sid })
      if (other.ended) forget(pair)
      return
    }
    if (kind === 'close') {
      forget(pair)
      const error = typeof msg.error === 'string' ? msg.error.slice(0, 200) : undefined
      deps.send(other.link, 'stream-close', { sid: other.sid, ...(error ? { error } : {}) })
    }
  }

  /** A link closed: every stream on it ends at its other side too. */
  function dropLink(link: L): void {
    deps.ptys?.dropLink(link)
    const ports = portsByLink.get(link)
    if (ports) {
      portsByLink.delete(link)
      for (const end of ports.values()) {
        if (end.timer) { clearTimeout(end.timer); end.timer = null }
        cutSocket(end)
      }
    }
    const m = byLink.get(link)
    if (!m) return
    for (const pair of [...m.values()]) {
      forget(pair)
      const other = pair.a.link === link ? pair.b : pair.a
      deps.send(other.link, 'stream-close', { sid: other.sid, error: 'the other server is no longer linked to this host' })
    }
  }

  return {
    open,
    openPort,
    openPty,
    frame,
    dropLink,
    /** Open streams, on one link or in all (a port stream and a terminal count once). */
    count: (link?: L): number => {
      const ptys = deps.ptys?.count(link) ?? 0
      if (link !== undefined) return (byLink.get(link)?.size ?? 0) + (portsByLink.get(link)?.size ?? 0) + ptys
      let n = 0
      for (const m of byLink.values()) n += m.size
      let ports = 0
      for (const m of portsByLink.values()) ports += m.size
      return n / 2 + ports + ptys
    },
  }
}

export type StreamRelay<L> = ReturnType<typeof createStreamRelay<L>>
