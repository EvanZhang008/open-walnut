/**
 * A plugin's `http.fetch` to THIS server is a self-call like the op executor's
 * (src/lib/caller-origin.ts). While plugin code runs for a caller off this Mac
 * (an op a remote host called, a route a paired phone requested), a request it
 * sends to a loopback name carries that caller's origin, so the "this Mac only"
 * routes refuse it exactly as they would refuse the caller. A request elsewhere
 * is left untouched: the header means nothing to another server.
 */

import { ORIGIN_HEADER, ambientCallerOrigin, isLocalOrigin, lowerOrigin } from '../../lib/caller-origin.js'
import { isLoopbackName } from '../../web/middleware/local-trust.js'

function hostName(host: string): string {
  if (host.startsWith('[')) {
    const end = host.indexOf(']')
    return end > 0 ? host.slice(0, end + 1) : host
  }
  const colon = host.lastIndexOf(':')
  return colon > 0 ? host.slice(0, colon) : host
}

/** True when either the URL or a Host header the plugin set names this machine. */
function addressesThisMachine(url: string, hostHeader: string | undefined): boolean {
  if (hostHeader !== undefined && isLoopbackName(hostName(hostHeader.trim()))) return true
  try {
    return isLoopbackName(new URL(url).hostname)
  } catch {
    // fetch rejects it anyway; a label on a request that never leaves costs nothing.
    return true
  }
}

/** The headers to send: the plugin's own, plus the caller's origin on a self-call. */
export function labelPluginFetch(
  url: string,
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  const origin = ambientCallerOrigin()
  if (origin === undefined || isLocalOrigin(origin)) return headers
  const out: Record<string, string> = {}
  let claimed: string | undefined
  let hostHeader: string | undefined
  for (const [name, value] of Object.entries(headers ?? {})) {
    const lower = name.toLowerCase()
    // Any spelling of the origin header the plugin set is replaced, never kept beside ours.
    if (lower === ORIGIN_HEADER) { claimed = String(value); continue }
    if (lower === 'host') hostHeader = String(value)
    out[name] = value
  }
  if (!addressesThisMachine(url, hostHeader)) return headers
  out[ORIGIN_HEADER] = lowerOrigin(claimed, origin)
  return out
}
