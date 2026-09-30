/**
 * Who the server is acting for when it calls ITSELF.
 *
 * The op executor reaches this server over loopback HTTP, and loopback is what
 * the "this machine only" checks trust. Without a label, every self-call made
 * on behalf of a remote session, a paired phone or the cloud bridge looked like
 * a request typed on this Mac: a remote host's `walnut tools call api` read and
 * deleted the Apple Health store that way (2026-09 gate). So every self-call
 * carries the ORIGINAL caller's class in `x-walnut-origin`:
 *
 *   `__local__`         a caller on this Mac (the local daemon, the console, a CLI)
 *   `host:<hostKey>`    a session on another exec host, through its daemon
 *   `remote-http`       a client off this machine (a device token, an API key,
 *                       or the cloud bridge relaying one)
 *
 * The header is written by server code only, and it can only LOWER trust: the
 * receiving side trusts `__local__` only on a socket it would trust anyway, and
 * any other value (a host, garbage, a repeated header) counts as off this Mac.
 * Nested work inherits the lowest origin in effect (see `withCallerOrigin`), so a
 * plugin op that calls another op, or an op that calls /actions/invoke, cannot
 * climb back to local.
 *
 * Zero imports beyond node:async_hooks: the CLI, the MCP server and the server
 * all load this.
 */

import { AsyncLocalStorage } from 'node:async_hooks'

export const ORIGIN_HEADER = 'x-walnut-origin'
export const LOCAL_ORIGIN = '__local__'
export const REMOTE_HTTP_ORIGIN = 'remote-http'
/** A missing or unreadable origin. Treated as a remote host: the strictest class. */
export const UNKNOWN_ORIGIN = 'unknown'
const HOST_PREFIX = 'host:'

/** The one sentence every health refusal uses. It names the rule, not a way around it. */
export const HEALTH_LOCAL_ONLY_MESSAGE = 'Health data is only available to sessions on this Mac'

/** The origin for work a daemon relays: its host, or local for the Mac's own daemon. */
export function hostOrigin(hostKey: string | undefined): string {
  const key = (hostKey ?? '').trim()
  if (key === LOCAL_ORIGIN) return LOCAL_ORIGIN
  // Header-safe: anything outside printable ASCII would make fetch throw.
  return key ? `${HOST_PREFIX}${key.slice(0, 200).replace(/[^\x21-\x7e]/g, '_')}` : UNKNOWN_ORIGIN
}

export function isLocalOrigin(origin: string | undefined): boolean {
  return origin === LOCAL_ORIGIN
}

/**
 * A session on another exec host (or an origin nobody can vouch for). Such a
 * caller gets the gateway's `remote` policy: `remote: 'deny'` ops refuse it. A
 * `remote-http` client is the paired human instead, whose device token already
 * reaches those routes directly.
 */
export function isRemoteHostOrigin(origin: string | undefined): boolean {
  return !isLocalOrigin(origin) && origin !== REMOTE_HTTP_ORIGIN
}

/** Trust rank: local, then a paired client, then a remote host or anything unknown. */
function rank(origin: string): number {
  if (isLocalOrigin(origin)) return 2
  return origin === REMOTE_HTTP_ORIGIN ? 1 : 0
}

/** The lowest of the given origins (the first of equals); local when none is given. */
export function lowerOrigin(...origins: Array<string | undefined>): string {
  let low = LOCAL_ORIGIN
  for (const o of origins) {
    if (o === undefined) continue
    const value = o || UNKNOWN_ORIGIN
    if (rank(value) < rank(low)) low = value
  }
  return low
}

const ambient = new AsyncLocalStorage<string>()

/**
 * Run `fn` acting for `origin`, never higher than the origin already in effect.
 * Everything `fn` starts (awaited work included) sees the lowered value. That
 * includes work it leaves RUNNING: a poller a plugin starts lazily inside its
 * first op call keeps that caller's origin, so start long-lived work at
 * activation instead. The failure is a refusal, never a leak.
 */
export function withCallerOrigin<T>(origin: string, fn: () => T): T {
  return ambient.run(lowerOrigin(ambient.getStore(), origin), fn)
}

/** The origin in effect for the current async context, if any code set one. */
export function ambientCallerOrigin(): string | undefined {
  return ambient.getStore()
}
