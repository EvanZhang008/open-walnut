/**
 * Which machine does a `host:port` URL point at? Shared by the server's service
 * preview (src/core/session-service-preview.ts) and the console's click
 * classifier (web/src/utils/service-link.ts, via the `@open-walnut/service-url`
 * alias), so the two can never disagree about what counts as loopback or as
 * the same host. Zero imports: it is bundled into the browser too.
 */

/** URL.hostname keeps IPv6 brackets; compare without them. */
export function bareHost(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, '').toLowerCase()
}

/** localhost, *.localhost, 127.0.0.0/8, the wildcard binds, and ::1. */
export function isLoopbackHostname(hostname: string): boolean {
  const h = bareHost(hostname)
  return h === 'localhost'
    || h.endsWith('.localhost')
    || /^127(?:\.\d{1,3}){3}$/.test(h)
    || h === '0.0.0.0'
    || h === '::1'
    || h === '::'
}

/**
 * Does the host a URL names refer to this known machine? Exact, or the URL uses
 * the bare short name of a known FQDN (`dev-box` for `dev-box.corp.example.com`).
 *
 * One direction only. A URL FQDN never matches a bare known name: a Mac's
 * `os.hostname()` and many ssh aliases are bare, and `<that-name>.attacker.test`
 * would otherwise count as "this machine" and send the probe to an outside host.
 * Two different FQDNs that share a first label do not match either.
 */
export function hostnamesMatch(urlHost: string, known: string): boolean {
  const x = bareHost(urlHost)
  const y = bareHost(known)
  if (!x || !y) return false
  if (x === y) return true
  return !x.includes('.') && y.includes('.') && y.split('.')[0] === x
}

/** A DNS name, IPv4, or bracketed IPv6. Anything a parser had to percent-encode is not a host. */
const HOSTNAME_RE = /^(?:\[[0-9a-f:.]+\]|[a-z0-9_](?:[a-z0-9_.-]*[a-z0-9_])?)$/i

/**
 * Parse a service address. Scheme-less input gets http, and the shorthands a
 * person types into an address bar expand to loopback: `8080` and `:8080` mean
 * `http://localhost:8080`. Only http(s) survives.
 */
export function parseServiceUrl(raw: string): URL | null {
  let s = raw.trim()
  // Whitespace is never part of an address someone typed or a model printed.
  // Checked on the input because browsers' URL parsers percent-encode a space
  // in the HOST (`http://a b` -> `a%20b`) where Node's throws.
  if (!s || s.length > 4096 || /\s/.test(s)) return null
  if (/^\d{1,5}(?:[/?#]|$)/.test(s)) s = `localhost:${s}`
  else if (/^:\d{1,5}(?:[/?#]|$)/.test(s)) s = `localhost${s}`
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `http://${s}`
  let url: URL
  try { url = new URL(withScheme) } catch { return null }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (!HOSTNAME_RE.test(url.hostname)) return null
  return url
}
