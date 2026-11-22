/**
 * One HTTP request to the server on a host, over a byte stream its daemon relays
 * (HostServerHost.openStream), answered as a fetch Response: the copy target's
 * `/bridge/replica` (manager.ts) and the session calls of a host that runs its own
 * sessions (session-channel/leader-side.ts).
 */
import http from 'node:http'
import type { Duplex } from 'node:stream'

/** One HTTP request to the host server over a stream, answered as a fetch Response. */
export function requestOver(stream: Duplex, method: string, route: string, body: Buffer | null, timeoutMs: number): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      method, path: route,
      headers: { host: 'host-server', ...(body ? { 'content-type': 'application/json', 'content-length': body.length } : {}) },
      createConnection: () => stream,
      timeout: timeoutMs,
    } as http.RequestOptions, (res) => {
      const parts: Buffer[] = []
      res.on('data', (c: Buffer) => parts.push(c))
      res.on('end', () => {
        const headers = new Headers()
        for (const [k, v] of Object.entries(res.headers)) if (typeof v === 'string') headers.set(k, v)
        resolve(new Response(Buffer.concat(parts), { status: res.statusCode ?? 502, headers }))
      })
      res.on('error', reject)
    })
    req.on('timeout', () => req.destroy(new Error(`the host server did not answer within ${Math.round(timeoutMs / 1000)}s`)))
    req.on('error', reject)
    req.end(body ?? undefined)
  })
}
