/**
 * The host server's byte forward (docs/plan/walnut-servers-everywhere.md): a
 * request or WebSocket goes to the leader or the companion as it came, and the
 * answer comes back as it is. Nothing is parsed or buffered. The connection is
 * a stream through the host's daemon (daemon-link.ts `openStream`), used as the
 * socket of an ordinary HTTP request.
 *
 * To the leader (the Mac's tunnel port, which trusts nothing on loopback) the
 * request keeps its own Host and Origin: it is the same browser, at the same
 * address. To the companion the Host and Origin name the companion, the way any
 * reverse proxy in front of it would: its own checks need its own address. A
 * browser authenticates with a device token in a header, never a cookie, so a
 * rewritten Origin opens no cross-site door. Both get X-Forwarded-For, so no
 * server ever takes a forwarded request for one of its own machine.
 */

import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'

/** Hop-by-hop headers never cross a proxy (RFC 9110 7.6.1). */
const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'proxy-authorization', 'proxy-authenticate'])

export interface ForwardTarget {
  kind: 'leader' | 'companion'
  /** A fresh connection to it. */
  connect: () => Promise<Duplex>
  /** The companion's own origin (`https://…`), which its Host and Origin name. */
  origin?: string
}

/** What a host replica adds to a forward (src/replica/dispatch.ts); the host server passes none. */
export interface ForwardOptions {
  /** Extra request headers (the op id and the forwarded-at stamp of a write). */
  headers?: Record<string, string>
  /** Headers taken once the stream opened, right before the request is written (a write's forwarded-at stamp). */
  stamp?: () => Record<string, string>
  /** The body, already read (a write replayed to the leader); else the request is piped. */
  body?: Buffer
  /** The stream is open and the request is being written: a failure from here may have reached the target. */
  onSent?: (up: http.ClientRequest) => void
}

function outgoingHeaders(req: IncomingMessage, to: ForwardTarget, upgrade: boolean): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {}
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue
    if (!upgrade && HOP.has(k)) continue
    out[k] = v
  }
  if (to.kind === 'companion' && to.origin) {
    const own = new URL(to.origin)
    out.host = own.host
    if (out.origin) out.origin = own.origin
  }
  const client = req.socket.remoteAddress ?? 'unknown'
  const prior = req.headers['x-forwarded-for']
  out['x-forwarded-for'] = prior ? `${Array.isArray(prior) ? prior.join(', ') : prior}, ${client}` : client
  out['x-walnut-via'] = 'host-server'
  return out
}

function request(req: IncomingMessage, to: ForwardTarget, socket: Duplex, upgrade: boolean, opts?: ForwardOptions): http.ClientRequest {
  const headers = outgoingHeaders(req, to, upgrade)
  for (const [k, v] of Object.entries(opts?.headers ?? {})) headers[k] = v
  for (const [k, v] of Object.entries(opts?.stamp?.() ?? {})) headers[k] = v
  if (opts?.body) {
    delete headers['transfer-encoding']
    headers['content-length'] = String(opts.body.length)
  }
  return http.request({
    method: req.method,
    path: req.url ?? '/',
    headers,
    createConnection: () => socket,
  } as http.RequestOptions)
}

/**
 * The words the daemon's stream relay closes a stream with when the link it rode dropped
 * (providers/stream-relay-core.ts `dropLink`): the target may well answer on its other link.
 * 2026-10-31: the Mac's stream lane was stopped as a read went out; the daemon had routed it to
 * the lane, closed it with these words, and the read was answered "Neither your Mac nor your
 * cloud companion is answering" while the Mac's session link was up.
 */
export const LINK_DROPPED = 'the other server is no longer linked to this host'

/** A forward that failed only because the link carrying it dropped: a read may go to the same target again. */
export function isLinkDropped(err: Error | undefined): boolean {
  return !!err && err.message.includes(LINK_DROPPED)
}

/** Forward one HTTP request. `onFail` runs when the target could not be reached (nothing was sent back yet). */
export function forwardHttp(req: IncomingMessage, res: ServerResponse, to: ForwardTarget, onFail: (err: Error) => void, opts?: ForwardOptions): void {
  let gone = false
  res.on('close', () => { gone = true })
  to.connect().then((socket) => {
    if (gone) { socket.destroy(); return }
    const up = request(req, to, socket, false, opts)
    up.on('response', (answer) => {
      const headers: http.OutgoingHttpHeaders = {}
      for (const [k, v] of Object.entries(answer.headers)) if (v !== undefined && !HOP.has(k)) headers[k] = v
      headers['x-walnut-answered-via'] = to.kind
      res.writeHead(answer.statusCode ?? 502, headers)
      answer.pipe(res)
      answer.on('error', () => res.destroy())
    })
    up.on('error', (err) => {
      // A browser that went away destroyed this request itself: no failure of the target.
      if (gone || res.destroyed) return
      if (res.headersSent) { res.destroy(); return }
      onFail(err)
    })
    // A browser that went away takes its upstream request with it.
    res.on('close', () => { if (!res.writableFinished) up.destroy() })
    opts?.onSent?.(up)
    // A read retried on the next target: its (empty) body was already read by the first.
    if (opts?.body) up.end(opts.body)
    else if (req.readableEnded) up.end()
    else req.pipe(up)
  }, (err: Error) => { if (!gone) onFail(err) })
}

/** A WebSocket forward still in its handshake: `cancel()` lets go of it (nothing was written to the browser). */
export interface UpgradeForward {
  /** True once the browser got an answer (the 101 or the target's refusal), or the forward ended. */
  settled(): boolean
  /** Stop the handshake; the browser socket is left untouched for the caller. False when already settled. */
  cancel(): boolean
}

function ignoreError(): void { /* the browser went away; its close ends the forward */ }

/** Forward one WebSocket (an HTTP upgrade) and then splice the two sockets. */
export function forwardUpgrade(
  req: IncomingMessage, socket: Duplex, head: Buffer, to: ForwardTarget, onFail: (err: Error) => void,
  /** The two sockets are spliced (a host replica keeps them, to close a frozen leader's); `upHead`: target bytes already passed on. */
  onSpliced?: (client: Duplex, upstream: Duplex, upHead: Buffer) => void,
  /** No 101 nor refusal within this: onFail with a timeout (code 'handshake_timeout'). */
  opts?: { handshakeMs?: number },
): UpgradeForward {
  // Node drops its own error listener on the socket before it emits 'upgrade':
  // a browser that resets while the stream opens would raise uncaught.
  socket.on('error', ignoreError)
  let done = false
  let up: http.ClientRequest | null = null
  let link: Duplex | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  const settle = () => { done = true; if (timer) clearTimeout(timer) }
  const fail = (err: Error) => {
    if (done) return
    settle()
    // A browser that went away is no failure of the target.
    if (socket.destroyed) { link?.destroy(); return }
    onFail(err)
  }
  const letGo = () => {
    if (up) { up.removeAllListeners('error'); up.on('error', ignoreError); up.destroy() }
    link?.destroy()
  }
  if (opts?.handshakeMs) {
    timer = setTimeout(() => {
      if (done) return
      letGo()
      fail(Object.assign(new Error(`no handshake answer within ${opts.handshakeMs} ms`), { code: 'handshake_timeout' }))
    }, opts.handshakeMs)
    timer.unref?.()
  }
  to.connect().then((stream) => {
    link = stream
    if (done || socket.destroyed) { settle(); stream.destroy(); return }
    // A browser that went away ends its stream, whatever the target answered.
    socket.once('close', () => { if (!stream.destroyed) stream.destroy() })
    up = request(req, to, stream, true)
    up.on('upgrade', (answer, upSocket, upHead) => {
      if (done) { upSocket.destroy(); return }
      settle()
      let raw = `HTTP/1.1 ${answer.statusCode ?? 101} ${answer.statusMessage ?? 'Switching Protocols'}\r\n`
      for (let i = 0; i < answer.rawHeaders.length; i += 2) raw += `${answer.rawHeaders[i]}: ${answer.rawHeaders[i + 1]}\r\n`
      socket.write(raw + '\r\n')
      if (upHead.length) socket.write(upHead)
      if (head.length) upSocket.write(head)
      upSocket.on('error', () => socket.destroy())
      socket.on('error', () => upSocket.destroy())
      upSocket.on('close', () => socket.destroy())
      socket.on('close', () => upSocket.destroy())
      upSocket.pipe(socket).pipe(upSocket)
      onSpliced?.(socket, upSocket, upHead)
    })
    // The target refused the upgrade (401 without a token, say): pass its answer on.
    up.on('response', (answer) => {
      if (done) { answer.resume(); stream.destroy(); return }
      settle()
      let raw = `HTTP/1.1 ${answer.statusCode ?? 502} ${answer.statusMessage ?? ''}\r\n`
      for (let i = 0; i < answer.rawHeaders.length; i += 2) {
        if (!HOP.has(answer.rawHeaders[i]!.toLowerCase())) raw += `${answer.rawHeaders[i]}: ${answer.rawHeaders[i + 1]}\r\n`
      }
      socket.write(raw + 'Connection: close\r\n\r\n')
      answer.pipe(socket)
      // The HTTP client lets go of the stream here: once the answer is passed on, it is done.
      answer.on('end', () => stream.destroy())
    })
    up.on('error', (err) => fail(err))
    socket.on('error', () => up?.destroy())
    up.end()
  }, (err: Error) => fail(err))
  return {
    settled: () => done,
    cancel() {
      if (done) return false
      settle()
      letGo()
      return true
    },
  }
}
