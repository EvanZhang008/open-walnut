/**
 * No new daemon link from a server that is stopping.
 *
 * stopServer drops every daemon link (disconnectAllDaemons) and empties the
 * pool, but routes, WS clients and timers keep running until the HTTP server
 * closes, and the next `getDaemonConnection` used to dial the host again from
 * scratch. 2026-11-10: a deploy's outgoing server re-dialled clouddev 3 s after
 * it dropped it, ran "daemon reconnected, redelivering pending messages" and
 * resumed a session's CLI, seconds before the new server did the same: two
 * servers delivering one queue. The stop closes the gate at its entry
 * (existing connected links still answer until they are dropped); the next
 * startServer in this process opens it again (tests start and stop many).
 *
 * Zero imports beyond link-failure: the pool and the server both load it.
 */
import { markLinkFailure } from './link-failure.js'

let closed = false

/** stopServer's entry: from now on no connection is dialled or re-dialled. */
export function closeDaemonDials(): void { closed = true }
/** startServer: this process serves again. */
export function reopenDaemonDials(): void { closed = false }
export function daemonDialsClosed(): boolean { return closed }

/** Throw a link failure when the server is stopping; the next server dials for itself. */
export function assertDaemonDialsOpen(hostKey: string): void {
  if (!closed) return
  throw markLinkFailure(
    new Error(`Not connecting to ${hostKey}: this Walnut server is shutting down, and the next one connects`),
    'no-link',
  )
}
