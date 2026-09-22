/**
 * The ONE way this plugin ever opens an unsubscribe url, guard included.
 *
 * Both fetching rungs of the ladder (the RFC 8058 one-click POST and the plain GET) go through
 * `fetchUnsubscribe`, and it goes through `guardUnsubscribeUrl` on the first hop and on EVERY
 * redirect. There is deliberately **no switch that weakens the rules** — not an env var, not an
 * allowlist, no "insecure mode". The seam a test may replace is the SOCKET (`fetch`) and the RESOLVER
 * (`lookup`), and whatever the resolver answers is still run through the blocklist below.
 *
 * Two properties make that seam safe, and both are load-bearing rather than decorative:
 *
 * - IT IS REPLACED AS A PAIR. Replacing only `lookup` used to be allowed, and that was a real
 *   bypass: the guard would score the fake resolver's `203.0.113.10` while the REAL `globalThis.fetch`
 *   resolved the name itself and connected wherever it actually points. So a half seam is refused, and
 *   the guard is handed the very same pair the socket will use.
 * - IT ONLY INSTALLS UNDER A TEST RUNNER. Walnut loads plugins from `~/.open-walnut/plugins/` INTO
 *   this process, so an exported setter with no gate is reachable by plugin code, not just by tests.
 *   Outside VITEST / NODE_ENV=test the setter throws and the real seam stays in place. (Per-call
 *   `seam` arguments are not gated — they are what an in-process caller could write by hand anyway,
 *   and every address they hand back is still judged.)
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

let testSeam: UnsubscribeHttpSeam | null = null

/**
 * Is this process a test runner? The repo's own signal, not a new one: the same three environment
 * variables `src/constants.ts`, `src/core/cheap-model.ts` and `isTestEnv` in
 * `src/providers/daemon-ownership.ts` read. Inlined rather than imported because those modules pull in
 * `constants.js`, which a great many test files replace with a partial mock.
 */
function underTestRunner(): boolean {
  return !!(process.env.VITEST || process.env.VITEST_WORKER_ID || process.env.NODE_ENV === 'test')
}

/**
 * Both halves or neither — a resolver without its socket is a bypass, not a seam.
 *
 * Spreading a partial over the real seam is what made this dangerous: `{...REAL_SEAM, lookup: lie}`
 * scores the lie and then lets `globalThis.fetch` resolve the name for real and connect wherever it
 * points. Refusing the half seam is what makes "whoever answers the lookup is whoever opens the
 * socket" a property of the module rather than a habit of its callers.
 *
 * The parameters stay typed `Partial<UnsubscribeHttpSeam>` only because `MailUnsubscribe` declares its
 * `http` dependency that way; the rule is enforced here at runtime, and the day that declaration
 * becomes the whole seam these signatures should require it too.
 */
function pairedSeam(
  candidate: Partial<UnsubscribeHttpSeam> | null | undefined,
  where: string,
): UnsubscribeHttpSeam | null {
  if (!candidate) return null
  const { fetch: socket, lookup } = candidate
  if (typeof socket === 'function' && typeof lookup === 'function') return { fetch: socket, lookup }
  throw new Error(
    `${where}: replace BOTH fetch and lookup or neither. Half a seam would have the guard judge one`
    + ` resolver's answer while a different resolver decides what is actually connected to.`,
  )
}

/**
 * Replace the socket AND the resolver for a test, and nothing else.
 *
 * This is NOT a way around the guard: `guardUnsubscribeUrl` runs on every url and every redirect
 * whatever is installed here, every address the resolver hands back is still checked against the
 * blocklist, and the pair that answers the lookup is the pair that opens the socket. It exists because
 * the guard correctly refuses loopback, so an end-to-end test that wants a real HTTP server has to
 * reach it through a transport rather than by weakening the rule.
 *
 * Refuses to install outside a test runner. Plugins run in this process, so "an exported setter" and
 * "an attack surface" are the same sentence here. Passing `null` to restore the real seam is always
 * allowed — un-installing can only make the guard stricter.
 */
export function setUnsubscribeHttpForTesting(seam: Partial<UnsubscribeHttpSeam> | null): void {
  if (seam && !underTestRunner()) {
    throw new Error(
      'setUnsubscribeHttpForTesting is refused outside a test runner: this would replace the socket and'
      + ' resolver of a real server. The unsubscribe guard has no production bypass.',
    )
  }
  testSeam = pairedSeam(seam, 'setUnsubscribeHttpForTesting')
}

/** The one pair this request will both judge with and connect with. */
export function unsubscribeHttpSeam(override?: Partial<UnsubscribeHttpSeam>): UnsubscribeHttpSeam {
  return pairedSeam(override, 'unsubscribeHttpSeam') ?? testSeam ?? REAL_SEAM
}

/** What every unsubscribe request announces itself as. One request per click, and it says so. */
export function unsubscribeUserAgent(version = getVersion()): string {
  return `Walnut/${version} (unsubscribe; one request per click)`
}

/**
 * Host names that are never on the public internet, however they resolve.
 *
 * Matched against the NORMALISED host (see `judgedHost`), because `new URL('https://box.internal./')`
 * keeps the root's trailing dot in `hostname` and a `$`-anchored pattern then misses it entirely.
 * `.lan`, `.corp` and `.intranet` are here because home routers and corporate DHCP hand them out as
 * the search domain, which is exactly the network this process is sitting inside.
 */
const LOCAL_NAMES = /^(?:localhost|.*\.(?:localhost|local|internal|intranet|lan|corp|home\.arpa))$/i

/** Brackets off, lowercased, and the root's trailing dot(s) off. The form every rule below judges. */
function judgedHost(hostname: string): string {
  return hostname.replace(/^\[/, '').replace(/\]$/, '').trim().toLowerCase().replace(/\.+$/, '')
}

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

/**
 * An IPv6 address as its SIXTEEN BYTES, or null when it cannot be read.
 *
 * Every rule below is byte arithmetic rather than a pattern over the text, and that is the fix for a
 * whole class of miss. `::ffff:127.0.0.1`, `::ffff:7f00:1` and `0:0:0:0:0:ffff:7f00:1` are one
 * address written three ways; the old patterns understood only whichever spelling the test happened
 * to use, so `unsubscribeAddressBlocked('0:0:0:0:0:ffff:7f00:1')` answered "public".
 *
 * A `%zone` suffix is dropped: `net.isIP('fe80::1%en0')` says 6, so a scoped address does reach here.
 */
function ipv6Bytes(input: string): Uint8Array | null {
  let text = input.split('%')[0]!.trim().toLowerCase()
  // A dotted-quad tail is the same 32 bits as two hex groups; fold it so there is one parser.
  const dotted = /:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text)
  if (dotted) {
    const octets = dotted.slice(1, 5).map((one) => Number(one))
    if (octets.some((one) => one > 255)) return null
    const high = ((octets[0]! << 8) | octets[1]!).toString(16)
    const low = ((octets[2]! << 8) | octets[3]!).toString(16)
    text = `${text.slice(0, dotted.index + 1)}${high}:${low}`
  }
  const halves = text.split('::')
  if (halves.length > 2) return null
  const parse = (part: string): number[] | null => {
    if (!part) return []
    const groups: number[] = []
    for (const one of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(one)) return null
      groups.push(Number.parseInt(one, 16))
    }
    return groups
  }
  const left = parse(halves[0] ?? '')
  const right = halves.length === 2 ? parse(halves[1] ?? '') : []
  if (!left || !right) return null
  const groups = halves.length === 2
    ? (left.length + right.length > 7
      ? null
      : [...left, ...Array.from({ length: 8 - left.length - right.length }, () => 0), ...right])
    : (left.length === 8 ? left : null)
  if (!groups) return null
  const bytes = new Uint8Array(16)
  groups.forEach((group, at) => {
    bytes[at * 2] = group >> 8
    bytes[at * 2 + 1] = group & 0xff
  })
  return bytes
}

/** The four bytes at `from`, as an IPv4 address the v4 rules can judge. */
function embeddedIpv4(bytes: Uint8Array, from: number): string {
  return `${bytes[from]}.${bytes[from + 1]}.${bytes[from + 2]}.${bytes[from + 3]}`
}

/**
 * Is this IPv6 address one a stranger must never point this server at?
 *
 * Two ideas, in this order:
 *
 * 1. AN ADDRESS THAT CARRIES AN IPv4 IS JUDGED BY THE IPv4 RULES, in every form the prefix can take.
 *    This matters most for NAT64 (`64:ff9b::/96`): on an IPv6-only network, DNS64 answers for an
 *    IPv4-only host with exactly this, so it must keep working for public addresses AND must refuse
 *    `64:ff9b::a9fe:a9fe`, which the gateway will translate straight to 169.254.169.254. The old
 *    pattern demanded a dotted tail (`64:ff9b::169.254.169.254`) that neither the URL serializer nor
 *    `inet_ntop` ever produces, so the whole prefix was open.
 * 2. EVERYTHING ELSE DEFAULTS TO REFUSED, because the public internet's unicast space is 2000::/3 and
 *    nothing else. That is what closes the leaks a blocklist of patterns kept springing: `::7f00:1`
 *    (what `https://[::127.0.0.1]/` normalises to), `fec0::/10` site-local (which a `f[cd]` pattern
 *    cannot see), `100::/64` discard, and every reserved range nobody has thought about yet.
 */
function ipv6Blocked(input: string): boolean {
  const bytes = ipv6Bytes(input)
  // Unreadable is refused: this is only ever asked about something a resolver or a url handed over.
  if (!bytes) return true
  const first10Zero = bytes.subarray(0, 10).every((one) => one === 0)
  // ::ffff:0:0/96 IPv4-mapped, and ::/96 IPv4-compatible — which also covers :: and ::1.
  if (first10Zero && bytes[10] === 0xff && bytes[11] === 0xff) return ipv4Blocked(embeddedIpv4(bytes, 12))
  if (first10Zero && bytes[10] === 0 && bytes[11] === 0) return ipv4Blocked(embeddedIpv4(bytes, 12))
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b) {
    const wellKnown96 = bytes.subarray(4, 12).every((one) => one === 0)
    if (wellKnown96) return ipv4Blocked(embeddedIpv4(bytes, 12))
    // The rest of the translation space, including RFC 8215's local-use 64:ff9b:1::/48. RFC 6052 puts
    // the embedded IPv4 at a different offset for every prefix length, and the address does not carry
    // its prefix length, so which four bytes to judge is unknowable from here. Refuse the range
    // rather than guess: a wrong guess here is a fetch into the user's own network.
    return true
  }
  // 2002::/16 6to4 tunnels the IPv4 in the next 32 bits: 2002:a00:1::1 is a tunnel to 10.0.0.1.
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return ipv4Blocked(embeddedIpv4(bytes, 2))
  // 2001::/32 Teredo: the relay's IPv4 in bytes 4-7 and the client's, bit-flipped, in the last four.
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0 && bytes[3] === 0) {
    const client = [12, 13, 14, 15].map((at) => bytes[at]! ^ 0xff).join('.')
    return ipv4Blocked(embeddedIpv4(bytes, 4)) || ipv4Blocked(client)
  }
  // 2000::/3, the only globally routable unicast space there is. Everything else: refused.
  return (bytes[0]! & 0xe0) !== 0x20
}

/**
 * Any literal address, v4 or v6, that this server must never be pointed at by a stranger.
 *
 * Takes any spelling of an address, not just the compressed canonical text a resolver happens to
 * return: whitespace, upper case, a `%zone`, an uncompressed `0:0:0:0:0:ffff:7f00:1` and a dotted
 * `::ffff:127.0.0.1` all reach the same verdict. That is deliberate — this is exported, and the
 * previous version was only correct for the one form its two callers happened to pass.
 */
export function unsubscribeAddressBlocked(address: string): boolean {
  const text = address.trim()
  const kind = net.isIP(text)
  if (kind === 4) return ipv4Blocked(text)
  if (kind === 6) return ipv6Blocked(text)
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
  // Resolved BEFORE anything is judged, and outside the try below: a half seam is a programming
  // error, and it used to come back as `unreachable`, i.e. indistinguishable from a DNS failure.
  const paired = unsubscribeHttpSeam(seam)
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
  // WHATWG keeps the brackets on an IPv6 host and the root's trailing dot on a name; every check
  // below wants neither. `box.internal.` reached the name list as a miss until this normalised.
  const host = judgedHost(url.hostname)
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
    resolved = await paired.lookup(host, { all: true })
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
  | {
    ok: false
    reason: UnsubscribeFetchFailure
    detail: string
    /**
     * The url a human may be pointed at, and ABSENT when the guard refused one.
     *
     * A refusal on a redirect hop is refusing a target the SENDER chose, which never appeared in the
     * mail: handing that back would publish it to the console and, through the "finish this
     * unsubscribe" ask, to a model with network access — the guard's decision undone by the layer
     * above it. So a refused url is reported by REASON only. A transport failure keeps its url: that
     * one passed the guard, and it is the page the person would open next.
     */
    url?: string
  }

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
    // The RESOLVED pair, not `options.seam` again: the resolver that answers the guard has to be the
    // one whose socket is about to be used, and handing the same object to both is what guarantees it.
    const guarded = await guardUnsubscribeUrl(target, seam)
    // No `url`: see UnsubscribeFetchResult. `target` here is whatever the guard just refused, and on
    // any hop past the first that is a host the sender picked, not one the user has seen.
    if (!guarded.ok) return { ok: false, reason: guarded.reason, detail: guarded.detail }

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
          // Same rule: the thing being refused is the redirect's own target, so it is not handed back.
          return { ok: false, reason: 'blocked-url', detail: 'the redirect target is not a url' }
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
