/**
 * One request path on the cloud companion (docs/plan/walnut-control-plane.md,
 * "One request path on the companion"): the companion is the same server as
 * the Mac plus a public address. While the Mac answers, a phone's /api/v1 call
 * to the companion is carried to the Mac and answered there, as if the phone
 * had reached the Mac directly; while it does not, the companion answers from
 * its own copy, which is what it always did.
 *
 * This module is the part both boxes agree on: which routes the companion keeps
 * for itself, which headers cross, and how big a call may be. The companion
 * reads it to decide whether to forward (proxy.ts); the Mac reads it again
 * before it runs a forwarded call (target.ts), so a call the companion should
 * never have sent is refused there too. No imports: both sides load it.
 */

/** The methods a forwarded call may use. */
export const FORWARD_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'])

/** A request body larger than this stays on the companion (uploads have their own routes). */
export const MAX_FORWARD_REQUEST_BYTES = 1024 * 1024

/**
 * A reply larger than this is not carried back: the companion answers from its
 * own copy instead. The bridge's uplink from the Mac is where large frames were
 * lost (docs/reference/cloud-sync.md "Why bulk uploads leave the bridge").
 */
export const MAX_FORWARD_RESPONSE_BYTES = 256 * 1024

/** How long the Mac waits on its own route before it gives up on a forwarded call. */
export const FORWARD_TARGET_TIMEOUT_MS = 20_000

/** Why the companion answers a route itself, whoever else is up. */
export type CompanionReason =
  | 'stream' | 'send' | 'chat' | 'identity' | 'bytes' | 'device-data' | 'task-copy' | 'paged' | 'launch'

interface CompanionRoute {
  methods?: readonly string[]
  re: RegExp
  /** A path the rule would match that it leaves to the Mac anyway. */
  unless?: RegExp
  why: CompanionReason
}

/**
 * Paths are relative to /api/v1. Everything not listed here goes to the Mac
 * while it answers: new routes need nothing to work through the companion.
 */
const COMPANION_ROUTES: readonly CompanionRoute[] = [
  // The companion holds these streams, and the sends that feed them go from it
  // to the host's daemon directly (a session's host is not always the Mac).
  { re: /^\/events(\/|$)/, why: 'stream' },
  { re: /^\/(sessions|conversations)\/[^/]+\/stream$/, why: 'stream' },
  { methods: ['POST'], re: /^\/(sessions|conversations)\/[^/]+\/messages$/, why: 'send' },
  // The phone messages the companion holds are its own state (send-queue.ts), so
  // what reads or fences them stays here too: a held send's status (the Mac
  // holds none and answers 404), the queue list that shows held sends beside
  // the Mac's rows, and a stop, which is noted here before it is relayed so a
  // held send never runs past it (session-stop-v1.ts, cloud-stop-fence.ts).
  { methods: ['GET'], re: /^\/sessions\/[^/]+\/messages\/[^/]+$/, why: 'send' },
  { methods: ['GET'], re: /^\/sessions\/[^/]+\/queue$/, why: 'send' },
  { methods: ['POST'], re: /^\/sessions\/[^/]+\/terminate$/, why: 'send' },
  // The Personal AI chat has its own relay to the Mac, and its message list
  // carries the turns the companion answered alone, so the Mac adopts them.
  { re: /^\/conversations(\/|$)/, why: 'chat' },
  // Who the phone is talking to, and who the phone is: the companion speaks for itself.
  { re: /^\/(devices|setup)(\/|$)/, why: 'identity' },
  { re: /^\/(status|canary|me|instance|routes|client-logs)(\/|$)/, why: 'identity' },
  // File and media bytes do not ride the bridge.
  { re: /^\/(media|stt|file-content|file-raw)(\/|$)/, why: 'bytes' },
  { re: /^\/timeline\/images\//, why: 'bytes' },
  { re: /^\/notes\/attachment(\/|$)/, why: 'bytes' },
  // A letter's document (up to 100 MB) has its own chunked relay.
  { re: /^\/human-inbox\/[^/]+\/body$/, why: 'bytes' },
  // Data the Mac takes only from the phone's own device token.
  { re: /^\/(health|places)(\/|$)/, why: 'device-data' },
  { re: /^\/time\/heartbeats$/, why: 'device-data' },
  // The companion's exact copy of the task store: its writes already go to the
  // Mac and keep the copy in step, and its reads are as fresh as the Mac's.
  { re: /^\/(tasks|focus)(\/|$)/, unless: /^\/tasks\/[^/]+\/board(\/|$)/, why: 'task-copy' },
  // Long pages with their own paged relays.
  { methods: ['GET'], re: /^\/sessions$/, why: 'paged' },
  { methods: ['GET'], re: /^\/sessions\/[^/]+\/(transcript|history)$/, why: 'paged' },
  // A session launch has its own relay, which rides out a bridge redial.
  { re: /^\/sessions\/launch-options$/, why: 'launch' },
  { methods: ['POST'], re: /^\/sessions$/, why: 'launch' },
]

/** Why the companion answers this call itself, or null when the Mac should. `rel` is the path under /api/v1. */
export function companionAnswers(method: string, rel: string): CompanionReason | null {
  // Express answers a HEAD with the GET handler, so a GET route kept here keeps its HEAD.
  const m = method.toUpperCase() === 'HEAD' ? 'GET' : method.toUpperCase()
  for (const r of COMPANION_ROUTES) {
    if (r.methods && !r.methods.includes(m)) continue
    if (!r.re.test(rel)) continue
    if (r.unless && r.unless.test(rel)) continue
    return r.why
  }
  return null
}

const V1_PREFIX = '/api/v1'

function hasDotSegment(pathname: string): boolean {
  let p = pathname
  for (let depth = 0; depth < 4; depth++) {
    if (p.replace(/\\/g, '/').split('/').some((s) => s === '.' || s === '..')) return true
    let decoded: string
    try { decoded = decodeURIComponent(p) } catch { return true }
    if (decoded === p) return false
    p = decoded
  }
  return true
}

/**
 * The path and query of a forwarded call, checked: under /api/v1, no dot
 * segments (also encoded), no doubled slash, no backslash, NUL, fragment or line
 * break. Returns the path under /api/v1 and the query, or null.
 */
export function parseForwardUrl(url: unknown): { rel: string; pathname: string; search: string } | null {
  if (typeof url !== 'string' || url.length === 0 || url.length > 4096) return null
  if (/[\0#\\\r\n]/.test(url)) return null
  const q = url.indexOf('?')
  const pathname = q === -1 ? url : url.slice(0, q)
  const search = q === -1 ? '' : url.slice(q)
  if (!pathname.startsWith(`${V1_PREFIX}/`) || pathname.includes('//') || hasDotSegment(pathname)) return null
  return { rel: pathname.slice(V1_PREFIX.length), pathname, search }
}

/** The request headers that cross: what a route reads to understand the body and the cache. */
const REQUEST_HEADERS = new Set([
  'accept', 'accept-language', 'content-type',
  'if-match', 'if-none-match', 'if-modified-since', 'if-unmodified-since',
])

/**
 * The response headers that come back. Never the framing (content-length,
 * transfer-encoding, content-encoding: the reply is re-sent whole and the
 * companion compresses it itself), never a cookie.
 */
const RESPONSE_HEADERS = new Set([
  'cache-control', 'content-disposition', 'content-language', 'content-type',
  'etag', 'expires', 'last-modified', 'location', 'retry-after', 'vary',
])

function pick(input: unknown, keep: (name: string) => boolean): Record<string, string> {
  const out: Record<string, string> = {}
  if (!input || typeof input !== 'object') return out
  for (const [rawName, rawValue] of Object.entries(input as Record<string, unknown>)) {
    const name = rawName.toLowerCase()
    if (!keep(name)) continue
    const value = Array.isArray(rawValue) ? rawValue.join(', ') : rawValue
    if (typeof value !== 'string' || value.length > 4096 || /[\r\n\0]/.test(value)) continue
    out[name] = value
  }
  return out
}

/** Only the content and cache headers: never a credential, a cookie, or a Walnut caller header. */
export function forwardRequestHeaders(input: unknown): Record<string, string> {
  return pick(input, (n) => REQUEST_HEADERS.has(n))
}

/** The content and cache headers of the Mac's reply, and the server-written x-walnut-* ones. */
export function forwardResponseHeaders(input: unknown): Record<string, string> {
  return pick(input, (n) => RESPONSE_HEADERS.has(n) || (n.startsWith('x-walnut-') && n !== 'x-walnut-origin'))
}
