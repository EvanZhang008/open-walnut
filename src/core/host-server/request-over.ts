/**
 * One HTTP request to the server on a host, over a byte stream its daemon relays
 * (HostServerHost.openStream), answered as a fetch Response: the copy target's
 * `/bridge/replica` (manager.ts), the session calls of a host that runs its own
 * sessions (session-channel/leader-links.ts), the leader switch's witness calls to
 * a host's `/host-api/witness/*` (leader/switch/witness-transport.ts), and the leader
 * relay's requests (leader/switch/leader-relay.ts).
 *
 * Its wait is bounded here, by its own timer: http.request's `timeout` option never fires on
 * a stream handed over already connected (`createConnection`), so a peer that takes the
 * stream and never answers would hold the caller for good. The bound is IDLE time, `timeoutMs`
 * with nothing moving: it restarts whenever the stream took another piece of the request body
 * (written in 64 KB pieces, each one's write callback: a runtime may report one big write as
 * pending until all of it is gone), the body is all written, or a part of the answer comes. A long upload or answer that keeps moving is never cut; a stalled one is, its stream
 * destroyed.
 * (tests/host-server/request-over.test.ts, whose guard keeps every such call on this bound.)
 */
import http from 'node:http'
import type { Duplex } from 'node:stream'

/** A request body's piece: the unit of movement the idle bound sees. */
const PIECE = 64 * 1024

/** One HTTP request to the host server over a stream, answered as a fetch Response. */
export function requestOver(stream: Duplex, method: string, route: string, body: Buffer | null, timeoutMs: number): Promise<Response> {
  return new Promise((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      fn()
    }
    const idle = (): void => {
      finish(() => {
        const err = new Error(`the host server did not answer within ${timeoutMs < 1_000 ? `${timeoutMs} ms` : `${Math.round(timeoutMs / 1000)}s`}`)
        req.destroy(err)
        stream.destroy()
        reject(err)
      })
    }
    function moved(): void {
      if (settled || !Number.isFinite(timeoutMs)) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(idle, Math.max(1, timeoutMs))
      timer.unref?.()
    }
    const req = http.request({
      method, path: route,
      headers: { host: 'host-server', ...(body ? { 'content-type': 'application/json', 'content-length': body.length } : {}) },
      createConnection: () => stream,
    } as http.RequestOptions, (res) => {
      moved()
      const parts: Buffer[] = []
      res.on('data', (c: Buffer) => { parts.push(c); moved() })
      res.on('end', () => {
        const headers = new Headers()
        for (const [k, v] of Object.entries(res.headers)) if (typeof v === 'string') headers.set(k, v)
        finish(() => resolve(new Response(Buffer.concat(parts), { status: res.statusCode ?? 502, headers })))
      })
      res.on('error', (err) => finish(() => reject(err)))
    })
    req.on('finish', moved)
    req.on('error', (err) => finish(() => reject(err)))
    moved()
    if (!body || body.length <= PIECE) { req.end(body ?? undefined); return }
    // Piece by piece, the next once the stream took the last: each one taken is movement.
    let at = 0
    const next = (): void => {
      if (settled) return
      if (at >= body.length) { req.end(); return }
      const piece = body.subarray(at, at + PIECE)
      at += piece.length
      req.write(piece, (err) => { if (!err) { moved(); next() } })
    }
    next()
  })
}
