/**
 * The ONE way this plugin ever opens an unsubscribe url, guard included.
 *
 * Both fetching rungs of the ladder (the RFC 8058 one-click POST and the plain GET) go through
 * `fetchUnsubscribe`, and it goes through `guardUnsubscribeUrl` on the first hop and on EVERY
 * redirect. There is deliberately **no bypass switch** — not an env var, not a "test mode", not an
 * allowlist. The seam a test may replace is the SOCKET (`fetch`) and the RESOLVER (`lookup`), and
 * whatever the resolver answers is still run through the blocklist below, so no test can make the
 * guard let an address through.
 *
 * Why the guard exists at all: the url comes out of a header or a footer that a STRANGER wrote, and
 * this process sits inside the user's own network, next to their daemon sockets and whatever else
 * their machine can reach. `https://10.0.0.1/admin?reboot=1` in a `List-Unsubscribe` header would
 * otherwise be a click away from being fetched by a server the user trusts.
 *
 * What the guard does NOT claim: a DNS rebind between the lookup and the connect is a real window
 * and Node's fetch gives no supported way to pin the socket to the address that was checked, so the
 * window is accepted rather than papered over. The blast radius it leaves is deliberately tiny and
 * is the reason this is a reasonable trade: the request carries no cookie, no authorization, no
 * referer and none of the user's mail credentials, it is one request per human click, the body is
 * read to 256 KB and thrown away, and the only thing that ever escapes it is one verdict word plus
 * at most 300 characters of the page's own text.
 */
import dns from 'node:dns/promises'
import net from 'node:net'
import { getVersion } from '../../core/version.js'
import { UNSUBSCRIBE_BODY_CAP } from './unsubscribe-verdict.js'

/** One ladder, one clock: every hop of every rung shares this budget. Not a provider call. */
export const UNSUBSCRIBE_DEADLINE_MS = 10_000

/** Hops followed by hand. A fourth is a redirect loop or a tracker chain, and neither is consent. */
export const UNSUBSCRIBE_MAX_REDIRECTS = 3

/** Statuses that mean "go here instead". A POST is never repeated at the new url; see below. */
const REDIRECTS = new Set([301, 302, 303, 307, 308])

export type UnsubscribeBlockReason =
  | 'blocked-scheme'
  | 'blocked-url'
  | 'blocked-host'
  /** DNS said nothing usable. A transport failure, not a refusal. */
  | 'unreachable'

export type UnsubscribeFetchFailure = UnsubscribeBlockReason | 'timeout' | 'too-many-redirects'

/** `fetch`, narrowed to what this file uses, so a test can hand over a `Response` it built. */
export type UnsubscribeFetch = (url: string, init: RequestInit) => Promise<Response>

/** `dns.lookup(host, {all: true})`, narrowed the same way. */
export type UnsubscribeLookup = (
  hostname: string,
  options: { all: true },
) => Promise<Array<{ address: string; family: number }>>

export interface UnsubscribeHttpSeam {
  fetch: UnsubscribeFetch
  lookup: UnsubscribeLookup
}

const REAL_SEAM: UnsubscribeHttpSeam = {
  fetch: (url, init) => globalThis.fetch(url, init),
  lookup: (hostname, options) => dns.lookup(hostname, options),
}

let testSeam: Partial<UnsubscribeHttpSeam> | null = null

/**
 * Replace the socket and/or the resolver for a test, and nothing else.
 *
 * This is NOT a way around the guard: `guardUnsubscribeUrl` runs on every url and every redirect
 * whatever is installed here, and every address the resolver hands back is still checked against the
 * blocklist. It exists because the guard correctly refuses loopback, so an end-to-end test that
 * wants a real HTTP server has to reach it through a transport rather than by weakening the rule.
 */
export function setUnsubscribeHttpForTesting(seam: Partial<UnsubscribeHttpSeam> | null): void {
  testSeam = seam
}

export function unsubscribeHttpSeam(override?: Partial<UnsubscribeHttpSeam>): UnsubscribeHttpSeam {
  return { ...REAL_SEAM, ...testSeam, ...override }
}

/** What every unsubscribe request announces itself as. One request per click, and it says so. */
export function unsubscribeUserAgent(version = getVersion()): string {
  return `Walnut/${version} (unsubscribe; one request per click)`
}

/** Host names that are never on the public internet, however they resolve. */
const LOCAL_NAMES = /^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.home\.arpa)$/i

function ipv4Blocked(address: string): boolean {
  const parts = address.split('.').map((one) => Number(one))
  if (parts.length !== 4 || parts.some((one) => !Number.isInteger(one) || one < 0 || one > 255)) return true
  const [a, b] = parts as [number, number, number, number]
  if (a === 0) return true                                  // 0.0.0.0/8, "this network"
  if (a === 10) return true                                 // private
  if (a === 127) return true                                // loopback
  if (a === 100 && b >= 64 && b <= 127) return true         // 100.64/10 carrier-grade NAT
  if (a === 169 && b === 254) return true                   // link local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true          // private
  if (a === 192 && b === 168) return true                   // private
  if (a === 192 && b === 0) return true                     // 192.0.0/24 protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true      // benchmarking
  if (a >= 224) return true                                 // multicast, reserved, broadcast
  return false
}

function ipv6Blocked(input: string): boolean {
  const address = input.toLowerCase()
  // An IPv4-mapped or NAT64 form carries a v4 address inside it, and the v4 rules are what decide.
  const mapped = address.match(/(?:^::ffff:|^64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped?.[1]) return ipv4Blocked(mapped[1])
  const hex = address.match(/(?:^::ffff:)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (hex) {
    const high = Number.parseInt(hex[1]!, 16)
    const low = Number.parseInt(hex[2]!, 16)
    return ipv4Blocked([high >> 8, high & 0xff, low >> 8, low & 0xff].join('.'))
  }
  if (address === '::' || address === '::1') return true    // unspecified, loopback
  if (/^f[cd][0-9a-f]{2}:/.test(address)) return true       // fc00::/7 unique local
  if (/^fe[89ab][0-9a-f]:/.test(address)) return true       // fe80::/10 link local
  if (/^ff[0-9a-f]{2}:/.test(address)) return true          // ff00::/8 multicast
  return false
}

/** Any literal address, v4 or v6, that this server must never be pointed at by a stranger. */
export function unsubscribeAddressBlocked(address: string): boolean {
  const kind = net.isIP(address)
  if (kind === 4) return ipv4Blocked(address)
  if (kind === 6) return ipv6Blocked(address)
  // Not an address at all: the caller only asks about things the resolver returned, so this is a
  // resolver answering with something unreadable. Refuse it rather than guess.
  return true
}

export type UnsubscribeGuardOutcome =
  | { ok: true; url: string; host: string; addresses: string[] }
  | { ok: false; reason: UnsubscribeBlockReason; detail: string }

/**
 * May this url be fetched? Every rule, in the order that answers cheapest-first.
 *
 * The DNS lookup is last because it is the only step that costs a round trip, and it is not
 * optional: a name on the public internet may resolve straight into the user's own network, which
 * is exactly how an SSRF guard that only reads the url gets walked past.
 */
export async function guardUnsubscribeUrl(
  raw: string,
  seam?: Partial<UnsubscribeHttpSeam>,
): Promise<UnsubscribeGuardOutcome> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, reason: 'blocked-url', detail: 'the unsubscribe target is not a url' }
  }
  if (url.protocol !== 'https:') {
    return { ok: false, reason: 'blocked-scheme', detail: `${url.protocol} is not fetched` }
  }
  if (url.username || url.password) {
    return { ok: false, reason: 'blocked-url', detail: 'the url carries credentials' }
  }
  if (url.port && url.port !== '443') {
    return { ok: false, reason: 'blocked-url', detail: `port ${url.port} is not fetched` }
  }
  // WHATWG keeps the brackets on an IPv6 host; every check below wants the address itself.
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (!host) return { ok: false, reason: 'blocked-url', detail: 'the url has no host' }
  if (LOCAL_NAMES.test(host)) {
    return { ok: false, reason: 'blocked-host', detail: `${host} is not a public host` }
  }
  if (net.isIP(host) !== 0) {
    if (unsubscribeAddressBlocked(host)) {
      return { ok: false, reason: 'blocked-host', detail: `${host} is not a public address` }
    }
    return { ok: true, url: url.toString(), host, addresses: [host] }
  }

  let resolved: Array<{ address: string }>
  try {
    resolved = await unsubscribeHttpSeam(seam).lookup(host, { all: true })
  } catch (error) {
    return { ok: false, reason: 'unreachable', detail: `${host} did not resolve: ${String(error).slice(0, 120)}` }
  }
  const addresses = resolved.map((one) => one.address).filter((one) => !!one)
  // No address is not "probably fine": there is nothing to check, so there is nothing to allow.
  if (addresses.length === 0) {
    return { ok: false, reason: 'blocked-host', detail: `${host} resolved to no address` }
  }
  // EVERY address, not the first one. A name that answers with one public address and one private
  // one is the ordinary shape of this attack, and connecting picks whichever the stack prefers.
  const bad = addresses.find((one) => unsubscribeAddressBlocked(one))
  if (bad) {
    return { ok: false, reason: 'blocked-host', detail: `${host} resolves to ${bad}` }
  }
  return { ok: true, url: url.toString(), host, addresses }
}

export type UnsubscribeFetchResult =
  | {
    ok: true
    status: number
    /** The RAW first 256 KB; the rest of the download was aborted. */
    body: string
    contentType?: string
    /** The url that actually answered, after any redirects. What a human is handed. */
    url: string
    hops: number
  }
  | { ok: false; reason: UnsubscribeFetchFailure; detail: string; url: string }

export interface UnsubscribeFetchOptions {
  method: 'GET' | 'POST'
  /** Form body for the one-click POST. Never re-sent to a redirect target. */
  body?: string
  contentType?: string
  /** Absolute time the whole ladder must be finished by, shared across rungs and hops. */
  deadlineAt: number
  seam?: Partial<UnsubscribeHttpSeam>
  now?: () => number
  userAgent?: string
}

/** Read at most the cap, then stop the download. `text()` would pull a 5 MB page into memory. */
async function readCapped(response: Response): Promise<string> {
  const stream = response.body
  if (!stream || typeof stream.getReader !== 'function') {
    const whole = await response.text().catch(() => '')
    return whole.slice(0, UNSUBSCRIBE_BODY_CAP)
  }
  const reader = stream.getReader()
  const decoder = new TextDecoder('utf-8')
  let taken = 0
  let out = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      const room = UNSUBSCRIBE_BODY_CAP - taken
      if (value.byteLength >= room) {
        out += decoder.decode(value.subarray(0, room))
        taken = UNSUBSCRIBE_BODY_CAP
        break
      }
      out += decoder.decode(value, { stream: true })
      taken += value.byteLength
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  return out
}

/**
 * One unsubscribe request, redirects followed by hand, the guard re-run on every hop.
 *
 * A redirect is always followed as a GET with no body, even after a 307 or 308 that says otherwise.
 * The permission RFC 8058 grants is specific — one POST to the url the SENDER named — and repeating
 * that form body at whatever host the response points to is more than was invited. A GET to an
 * unsubscribe page is exactly what the other rung does anyway.
 */
export async function fetchUnsubscribe(
  raw: string,
  options: UnsubscribeFetchOptions,
): Promise<UnsubscribeFetchResult> {
  const now = options.now ?? Date.now
  const seam = unsubscribeHttpSeam(options.seam)
  const userAgent = options.userAgent ?? unsubscribeUserAgent()
  let target = raw

  for (let hop = 0; hop <= UNSUBSCRIBE_MAX_REDIRECTS; hop += 1) {
    const guarded = await guardUnsubscribeUrl(target, options.seam)
    if (!guarded.ok) return { ok: false, reason: guarded.reason, detail: guarded.detail, url: target }

    const remaining = options.deadlineAt - now()
    if (remaining <= 0) {
      return { ok: false, reason: 'timeout', detail: 'the unsubscribe budget ran out', url: guarded.url }
    }

    const controller = new AbortController()
    // The timer covers the HEADERS AND THE BODY. Clearing it as soon as the response object exists is
    // the shape of this bug that is easy to write and impossible to see: a server that sends 200 and
    // then stalls mid-body would leave the read waiting forever, and the ladder's promise would never
    // settle, so the ledger row would sit `in-flight` until somebody reclaimed it an hour later.
    const timer = setTimeout(() => controller.abort(), remaining)
    timer.unref?.()
    const first = hop === 0
    const failure = (error: unknown): UnsubscribeFetchResult => ({
      ok: false,
      reason: controller.signal.aborted ? 'timeout' : 'unreachable',
      detail: controller.signal.aborted
        ? 'the unsubscribe page did not answer in time'
        : String(error).slice(0, 200),
      url: guarded.url,
    })

    let redirectTo: string | undefined
    try {
      let response: Response
      try {
        response = await seam.fetch(guarded.url, {
          method: first ? options.method : 'GET',
          headers: {
            // No cookie, no authorization, no referer, ever. This request has nothing to do with the
            // user's mail account and must not be able to act as them anywhere.
            'user-agent': userAgent,
            accept: 'text/html, text/plain;q=0.9, */*;q=0.1',
            ...(first && options.body
              ? { 'content-type': options.contentType ?? 'application/x-www-form-urlencoded' }
              : {}),
          },
          ...(first && options.body !== undefined ? { body: options.body } : {}),
          redirect: 'manual',
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
          signal: controller.signal,
        })
      } catch (error) {
        return failure(error)
      }

      if (REDIRECTS.has(response.status)) {
        const location = response.headers.get('location')
        // Nothing here reads a redirect's body, so it is dropped rather than left for the collector.
        await response.body?.cancel().catch(() => undefined)
        if (!location) {
          // Answered with the redirect itself, so the verdict reader gets to call it broken.
          return { ok: true, status: response.status, body: '', url: guarded.url, hops: hop }
        }
        try {
          redirectTo = new URL(location, guarded.url).toString()
        } catch {
          return { ok: false, reason: 'blocked-url', detail: 'the redirect target is not a url', url: guarded.url }
        }
      } else {
        let body: string
        try {
          body = await readCapped(response)
        } catch (error) {
          return failure(error)
        }
        const contentType = response.headers.get('content-type') ?? undefined
        return {
          ok: true,
          status: response.status,
          body,
          ...(contentType ? { contentType } : {}),
          url: guarded.url,
          hops: hop,
        }
      }
    } finally {
      clearTimeout(timer)
    }

    target = redirectTo
  }

  return {
    ok: false,
    reason: 'too-many-redirects',
    detail: `more than ${UNSUBSCRIBE_MAX_REDIRECTS} redirects`,
    url: target,
  }
}
