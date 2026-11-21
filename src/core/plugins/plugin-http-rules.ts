/**
 * What a plugin HTTP request may carry when Walnut relays it somewhere else: the
 * companion to the Mac (web/routes/plugin-runtime-bridge.ts, plugin-control-relay.ts)
 * and the Mac to a plugin job that serves the plugin's routes (plugin-jobs/serve.ts).
 * One set of limits and one header filter for every hop, so a route answers the same
 * whichever way it was reached. The daemon's end of the job hop (providers/plugin-job-door.ts)
 * keeps the same numbers, inlined because it cannot import.
 */

export const PLUGIN_HTTP_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'])
export const MAX_PLUGIN_HTTP_BODY_BYTES = 2 * 1024 * 1024
/**
 * A request body to a plugin job (the upload direction, the leader to the job's machine): a
 * fragile SSH relay drops the whole host link after a few MB up, so far less than an answer's 2 MB.
 */
export const MAX_PLUGIN_JOB_REQUEST_BODY_BYTES = 256 * 1024
export const MAX_PLUGIN_HTTP_HEADERS_BYTES = 64 * 1024

/**
 * Never relayed: the caller's credentials (Authorization, Cookie, and the tokens a relayed call's
 * self-calls carry, which name a word only this process holds: lib/relay-hold.ts) and hop-by-hop headers.
 */
const HOP_BY_HOP_HEADERS = new Set([
  'authorization',
  'x-walnut-caller-proof',
  'x-walnut-caller-trigger',
  'x-walnut-caller-job',
  'connection',
  'content-length',
  'cookie',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9a-z-]+$/

/** A request or answer outside these rules, with the HTTP status that says so. */
export class PluginHttpRuleError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'PluginHttpRuleError'
  }
}

/**
 * The headers a relay passes on: names lowercased, credentials and hop-by-hop headers left
 * out, at most 64 KB in all (431 past it). An invalid name or value is dropped, or refused
 * (400) where the sender should have known better.
 */
export function relayedPluginHeaders(input: Record<string, unknown>, invalid: 'drop' | 'refuse'): Record<string, string> {
  const output: Record<string, string> = {}
  let bytes = 0
  for (const [rawName, rawValue] of Object.entries(input)) {
    const name = rawName.toLowerCase()
    if (HOP_BY_HOP_HEADERS.has(name)) continue
    if (!HEADER_NAME.test(name) || typeof rawValue !== 'string' || /\r|\n/.test(rawValue)) {
      if (invalid === 'refuse') throw new PluginHttpRuleError('Invalid Plugin HTTP header', 400)
      continue
    }
    bytes += Buffer.byteLength(name) + Buffer.byteLength(rawValue)
    if (bytes > MAX_PLUGIN_HTTP_HEADERS_BYTES) throw new PluginHttpRuleError('Plugin HTTP headers are too large', 431)
    output[name] = rawValue
  }
  return output
}

function hasDotPathSegment(value: string): boolean {
  let pathname = value.split('?', 1)[0]
  for (let depth = 0; depth < 4; depth++) {
    const normalized = pathname.replace(/\\/g, '/')
    if (normalized.split('/').some((segment) => segment === '.' || segment === '..')) return true
    let decoded: string
    try { decoded = decodeURIComponent(pathname) }
    catch { return true }
    if (decoded === pathname) return false
    pathname = decoded
  }
  return true
}

/** An in-plugin path (with its query) a relay may ask for: absolute, bounded, no dot segment even encoded. */
export function isRelayablePluginPath(value: unknown): value is string {
  return typeof value === 'string'
    && value.startsWith('/')
    && !value.startsWith('//')
    && value.length <= 4_096
    && !value.includes('\0')
    && !value.includes('#')
    && !value.includes('\\')
    && !hasDotPathSegment(value)
}
