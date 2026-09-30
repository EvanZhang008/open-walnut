/**
 * Which daemons may relay a `session.control` action to this server.
 *
 * A daemon forwards any `session.control` a client of its WebSocket sends as a
 * `control-request`. The one legitimate sender is the cloud replica: every
 * replica path (v1-control-relay.ts `callPrimaryControl`) asks the bridge alias
 * '__local__', which is the Mac's own daemon dialing out, so a relay reaches
 * this server through the Mac's own daemon connection and nowhere else. A remote
 * exec host's daemon has no reason to send one (a session there reaches Walnut
 * through the gateway, `walnut tools call`, which keeps its per-op remote
 * policy), yet any process on that host could use its daemon to run box-level
 * actions here: a routine, a check command, a chat turn, a task write, a letter.
 *
 * So every action, `server.*` and session-level alike, is accepted from the
 * Mac's own daemon only.
 */

import { REMOTE_HTTP_ORIGIN, hostOrigin } from '../../lib/caller-origin.js'

/** The Mac's own daemon connection (same value as host-model-catalog LOCAL_HOST_KEY). */
const LOCAL_HOST_KEY = '__local__'

/** A refusal message when `hostKey` may not relay `action`, else null. */
export function controlRefusedForHost(action: string, hostKey: string): string | null {
  if (hostKey === LOCAL_HOST_KEY) return null
  const host = hostKey ? `host ${hostKey}` : 'an unnamed host'
  return `${action} was refused: session controls are accepted only through this Mac's own daemon, not the daemon on ${host}`
}

/**
 * Who a relayed action acts for (src/lib/caller-origin.ts), for any op it runs.
 * Through the Mac's own daemon that is the cloud bridge, a client off this Mac
 * (console processes here call the server directly, never through the relay);
 * through any other daemon it is that host (refused above, kept for safety).
 */
export function controlRelayOrigin(hostKey: string): string {
  return hostKey === LOCAL_HOST_KEY ? REMOTE_HTTP_ORIGIN : hostOrigin(hostKey)
}
