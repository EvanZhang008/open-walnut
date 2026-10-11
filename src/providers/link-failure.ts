/**
 * A failure of the LINK to a host, told apart from a failure of the work sent
 * over it by kind, never by the message's words.
 *
 *  - `no-link`: no connection could be had. A dial that failed (the tunnel
 *    refused or reset, `ssh ... sh -s` refused), a failure the pool already
 *    knows, a reconnect still running, or a command sent with nothing connected.
 *    The command never reached the host.
 *  - `lost`: the connection went away while a command waited for its reply.
 *    The command may or may not have run there.
 *  - `no-answer`: a command got no reply within its deadline on a link that
 *    may still be up. It may or may not have run there.
 *
 * The pool tags its errors where it raises them (daemon-connection.ts); the
 * request path reads the tag (remote-read-bound.ts, the file routes). A gate
 * review (2026-10-05) found a read that began disconnected answer the dial's raw
 * "Cloud companion tunnel failed: WebSocket connection failed: ECONNRESET" as a
 * 500, because the pool had moved on (waiting to retry, or already back) by the
 * time the request looked at it; the Files tree then stopped retrying.
 *
 * Zero imports: the routes and the read bound load it without the pool.
 */

export type LinkFailureKind = 'no-link' | 'lost' | 'no-answer'

const KIND = Symbol.for('open-walnut.link-failure')

/** Tag `err` (in place, invisibly: message and class stay) as a link failure of `kind`. */
export function markLinkFailure<E>(err: E, kind: LinkFailureKind): E {
  if (!err || typeof err !== 'object') return err
  // The first tag wins: a command refused for want of a link stays `no-link`
  // when a caller further up sees it again.
  if ((err as Record<symbol, unknown>)[KIND]) return err
  try {
    Object.defineProperty(err, KIND, { value: kind, enumerable: false })
  } catch { /* a frozen error stays untagged: read as the work's own */ }
  return err
}

/** The link failure `err` is, or null for the work's own error (and anything untagged). */
export function linkFailureKind(err: unknown): LinkFailureKind | null {
  if (!err || typeof err !== 'object') return null
  const kind = (err as Record<symbol, unknown>)[KIND]
  return kind === 'no-link' || kind === 'lost' || kind === 'no-answer' ? kind : null
}
