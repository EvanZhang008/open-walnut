/**
 * Close the HTTP server within a bounded time.
 *
 * `server.close()` stops listening, then waits for every open connection to end.
 * Under Bun that includes a request still being answered and the keep-alive
 * socket it rode on, so a long poll held every shutdown: the browser relay's poll
 * (25 s) and a host_exec wait (10 to 15 s) are almost always open on a running
 * Walnut. 2026-11-10: 26 deploys in a day ran into the 7 s bail
 * (commands/web.ts SHUTDOWN_BAIL_MS) with the whole teardown done in about a
 * second, every one of them stuck here.
 *
 * Idle keep-alive sockets go at once; a request still running gets
 * HTTP_DRAIN_GRACE_MS to finish, then its connection is cut. A long poll's
 * client asks again and reaches the next server; a short request that is
 * mid-write has had its grace, and an op call's resend runs once
 * (op-call-id.ts), so cutting it is no worse than the bail's exit.
 */
import type { Server as HttpServer } from 'node:http'

/** How long a request in flight may still finish once the server stops (ms). */
export const HTTP_DRAIN_GRACE_MS = 1_000

export function closeHttpServer(
  server: HttpServer,
  opts: { dropConnections?: boolean; graceMs?: number } = {},
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let cut: ReturnType<typeof setTimeout> | null = null
    server.close((err) => {
      if (cut) clearTimeout(cut)
      if (err) reject(err)
      else resolve()
    })
    // A restart into an update keeps this process (web-restart.ts): an open window's
    // keep-alive socket would hold the port past the bail, so they go now.
    if (opts.dropConnections) {
      server.closeAllConnections?.()
      return
    }
    server.closeIdleConnections?.()
    cut = setTimeout(() => { server.closeAllConnections?.() }, opts.graceMs ?? HTTP_DRAIN_GRACE_MS)
    cut.unref?.()
  })
}
