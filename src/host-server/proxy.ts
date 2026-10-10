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

function request(req: IncomingMessage, to: ForwardTarget, socket: Duplex, upgrade: boolean): http.ClientRequest {
  return http.request({
    method: req.method,
    path: req.url ?? '/',
    headers: outgoingHeaders(req, to, upgrade),
    createConnection: () => socket,
  } as http.RequestOptions)
}

/** Forward one HTTP request. `onFail` runs when the target could not be reached (nothing was sent back yet). */
export function forwardHttp(req: IncomingMessage, res: ServerResponse, to: ForwardTarget, onFail: (err: Error) => void): void {
  let gone = false
  res.on('close', () => { gone = true })
  to.connect().then((socket) => {
    if (gone) { socket.destroy(); return }
    const up = request(req, to, socket, false)
    up.on('response', (answer) => {
      const headers: http.OutgoingHttpHeaders = {}
      for (const [k, v] of Object.entries(answer.headers)) if (v !== undefined && !HOP.has(k)) headers[k] = v
      headers['x-walnut-answered-via'] = to.kind
      res.writeHead(answer.statusCode ?? 502, headers)
      answer.pipe(res)
      answer.on('error', () => res.destroy())
    })
    up.on('error', (err) => {
      if (res.headersSent) { res.destroy(); return }
      onFail(err)
    })
    // A browser that went away takes its upstream request with it.
    res.on('close', () => { if (!res.writableFinished) up.destroy() })
    // A read retried on the next target: its (empty) body was already read by the first.
    if (req.readableEnded) up.end()
    else req.pipe(up)
  }, (err: Error) => { if (!gone) onFail(err) })
}

/** Forward one WebSocket (an HTTP upgrade) and then splice the two sockets. */
export function forwardUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, to: ForwardTarget, onFail: (err: Error) => void): void {
  to.connect().then((link) => {
    if (socket.destroyed) { link.destroy(); return }
    // A browser that went away ends its stream, whatever the target answered.
    socket.once('close', () => { if (!link.destroyed) link.destroy() })
    const up = request(req, to, link, true)
    up.on('upgrade', (answer, upSocket, upHead) => {
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
    })
    // The target refused the upgrade (401 without a token, say): pass its answer on.
    up.on('response', (answer) => {
      let raw = `HTTP/1.1 ${answer.statusCode ?? 502} ${answer.statusMessage ?? ''}\r\n`
      for (let i = 0; i < answer.rawHeaders.length; i += 2) {
        if (!HOP.has(answer.rawHeaders[i]!.toLowerCase())) raw += `${answer.rawHeaders[i]}: ${answer.rawHeaders[i + 1]}\r\n`
      }
      socket.write(raw + 'Connection: close\r\n\r\n')
      answer.pipe(socket)
      // The HTTP client lets go of the stream here: once the answer is passed on, it is done.
      answer.on('end', () => link.destroy())
    })
    up.on('error', (err) => onFail(err))
    socket.on('error', () => up.destroy())
    up.end()
  }, (err: Error) => onFail(err))
}
