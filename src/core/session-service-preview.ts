/**
 * Service preview: turn a `host:port` URL a session printed into one the
 * console's browser can load in an iframe.
 *
 * The model starts a dev server on the session's host and writes its address
 * ("http://dev-box.example.com:8080/", "localhost:8377"). From the Mac that
 * address is often unreachable (loopback on another machine, or a host only the
 * VPN routes). The answer reuses the embedded VS Code transport: the server
 * opens an SSH local forward to the host through its DaemonConnection and hands
 * back the 127.0.0.1 end. Page traffic then flows browser -> ssh -> service and
 * never touches the Walnut event loop, and the service's own absolute paths,
 * WebSockets and HMR work unmodified (no proxy path rewriting).
 *
 * Which host serves the URL:
 *   loopback (localhost, 127.x, 0.0.0.0, ::1)  -> the SESSION's host
 *   a configured host's name or alias          -> that host
 *   this machine's own name                    -> local
 *   anything else                              -> refused (the client opens it
 *                                                 as a plain external link)
 *
 * The route touches SSH, so the whole call is deadline-bounded.
 */
import http from 'node:http'
import https from 'node:https'
import { checkServerIdentity, type TLSSocket } from 'node:tls'
import os from 'node:os'
import { getConfig } from './config-manager.js'
import { getDaemonConnection } from '../providers/daemon-connection.js'
import type { SessionRecord } from './types.js'
import { log } from '../logging/index.js'
import { bareHost, hostnamesMatch, isLoopbackHostname, parseServiceUrl } from './service-url.js'

export { hostnamesMatch, isLoopbackHostname, parseServiceUrl }

const DEADLINE_MS = 30_000
/** A service that accepts the connection but has not answered by now is "slow",
 *  not "down": the iframe gets to try. Refused connections fail in milliseconds. */
const PROBE_TIMEOUT_MS = 5_000

export type ServicePreviewErrorCode =
  | 'bad_url'
  | 'not_found'
  | 'unknown_host'
  | 'unreachable'
  | 'tunnel_failed'
  | 'timeout'

export class ServicePreviewError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 422 | 502 | 504,
    readonly code: ServicePreviewErrorCode,
    readonly hint?: string,
  ) {
    super(message)
    this.name = 'ServicePreviewError'
  }
}

export interface ServicePreviewResult {
  /** The URL as the session wrote it. */
  requestedUrl: string
  /** Browser-loadable URL: the same URL for a local service, the tunnel end otherwise. */
  url: string
  via: 'local' | 'tunnel'
  /** Host alias that serves it, `__local__` for this machine. */
  host: string
  /** Port on the serving host. */
  remotePort: number
  /** Port the browser connects to (equals remotePort for a local service). */
  localPort: number
  /** False when the page's own headers forbid framing (the client offers a tab). */
  embeddable: boolean
  /** `certificate` = https whose certificate the browser will refuse inside a frame. */
  embedBlockedBy?: 'x-frame-options' | 'frame-ancestors' | 'certificate'
  /** `slow` = connected but no response inside the probe window. */
  reachability: 'ok' | 'slow'
}

interface HostDef { hostname: string; user?: string; port?: number; enabled?: boolean }

export interface ServiceTarget {
  /** Host alias, or `__local__`. */
  host: string
  /** Addresses to try on the serving host, in order (the `-L` destination). */
  targets: string[]
  /** Why this host was chosen (logged, and pinned by tests). */
  reason: 'loopback' | 'configured-host' | 'this-machine'
}

const LOCAL = '__local__'

/** Pure host decision: which host serves `url`, and at which address there. */
export function resolveServiceTarget(
  url: URL,
  ctx: { sessionHost?: string; hosts: Record<string, HostDef>; localNames: string[] },
): ServiceTarget | null {
  const h = bareHost(url.hostname)
  if (isLoopbackHostname(h)) {
    // `localhost` is resolved by the serving host's sshd, which tries every
    // address it maps to (a Node server on `localhost` may be ::1 only). An
    // explicit 127.x stays as written.
    const target = /^127\./.test(h) ? h : 'localhost'
    const host = ctx.sessionHost && ctx.sessionHost !== LOCAL ? ctx.sessionHost : LOCAL
    return { host, targets: [target], reason: 'loopback' }
  }
  if (ctx.localNames.some((n) => hostnamesMatch(h, n))) {
    return { host: LOCAL, targets: [h], reason: 'this-machine' }
  }
  // Prefer the session's own host when several entries name the same machine.
  const entries = Object.entries(ctx.hosts)
    .filter(([, d]) => d && d.enabled !== false && typeof d.hostname === 'string')
    .sort(([a], [b]) => (a === ctx.sessionHost ? -1 : b === ctx.sessionHost ? 1 : 0))
  for (const [alias, def] of entries) {
    if (hostnamesMatch(h, def.hostname) || hostnamesMatch(h, alias)) {
      // The session's OWN host: loopback first (a service bound to 127.0.0.1
      // or to every interface; the session started it), then the machine's
      // name (bound to one external interface only). ANOTHER host: its name
      // only, i.e. exactly what that URL reaches from anywhere. Loopback there
      // would expose services that host keeps private on purpose.
      const own = alias === ctx.sessionHost
      return { host: alias, targets: own ? ['localhost', def.hostname] : [def.hostname], reason: 'configured-host' }
    }
  }
  return null
}

function effectivePort(url: URL): number {
  if (url.port) return Number(url.port)
  return url.protocol === 'https:' ? 443 : 80
}

type ProbeResult =
  | { kind: 'ok'; headers: http.IncomingHttpHeaders; tlsUntrusted: boolean }
  | { kind: 'slow' }
  | { kind: 'refused'; error: string }

type ProbeHop = ProbeResult | { kind: 'redirect'; location: string; headers: http.IncomingHttpHeaders; tlsUntrusted: boolean }

function probeOnce(u: URL, timeoutMs: number): Promise<ProbeHop> {
  return new Promise((resolve) => {
    const mod = u.protocol === 'https:' ? https : http
    let settled = false
    const done = (r: ProbeHop) => { if (!settled) { settled = true; resolve(r) } }
    const req = mod.request(u, {
      method: 'GET',
      headers: { accept: 'text/html,*/*', 'user-agent': 'walnut-service-preview' },
      // Reachability, not trust: a self-signed dev cert still counts as "up",
      // and the trust question is answered separately below.
      rejectUnauthorized: false,
    }, (res) => {
      let tlsUntrusted = false
      if (u.protocol === 'https:') {
        const sock = res.socket as TLSSocket
        const cert = sock.getPeerCertificate?.()
        tlsUntrusted = !sock.authorized || !cert || checkServerIdentity(bareHost(u.hostname), cert) !== undefined
      }
      const location = res.headers.location
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && location) {
        done({ kind: 'redirect', location, headers: res.headers, tlsUntrusted })
      } else {
        done({ kind: 'ok', headers: res.headers, tlsUntrusted })
      }
      res.destroy()
    })
    req.setTimeout(Math.max(1, timeoutMs), () => { done({ kind: 'slow' }); req.destroy() })
    req.on('error', (err) => done({ kind: 'refused', error: err.message }))
    req.end()
  })
}

/**
 * Is something listening at `origin`, and will its pages frame?
 *
 * Asks the ORIGIN ROOT, never the page the session linked: the iframe requests
 * that page right after, and a one-time link (a login callback, a token URL)
 * must not be spent by the check. Any HTTP answer, 404 and 500 included, means
 * up. Follows up to 3 same-origin redirects so the framing headers are the
 * landing page's (a `/` that redirects to `/app` sends its policy on `/app`).
 * One time budget covers every hop.
 */
export async function probeService(origin: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<ProbeResult> {
  const deadline = Date.now() + timeoutMs
  let url = new URL('/', origin)
  for (let hop = 0; ; hop++) {
    const r = await probeOnce(url, deadline - Date.now())
    if (r.kind !== 'redirect') return r
    const landed: ProbeResult = { kind: 'ok', headers: r.headers, tlsUntrusted: r.tlsUntrusted }
    let next: URL
    try { next = new URL(r.location, url) } catch { return landed }
    // Leaving the origin (an auth provider): its headers are not the service's.
    if (hop >= 3 || next.origin !== url.origin || Date.now() >= deadline) return landed
    url = next
  }
}

/** Header values arrive comma-joined when a server sends the header twice. */
function headerValues(v: string | string[] | undefined): string[] {
  return (Array.isArray(v) ? v : v ? [v] : []).flatMap((x) => x.split(','))
}

/** Does the page forbid being framed by the console (a different origin)? */
export function frameBlockFromHeaders(
  headers: http.IncomingHttpHeaders,
): 'x-frame-options' | 'frame-ancestors' | undefined {
  // SAMEORIGIN blocks too: the frame's origin is the service, the parent is the console.
  if (headerValues(headers['x-frame-options']).some((v) => /^\s*(?:deny|sameorigin)\s*$/i.test(v))) {
    return 'x-frame-options'
  }
  // frame-ancestors sources never contain a comma, so splitting on `,` (joined
  // duplicate headers) and `;` (directives) is safe.
  for (const part of headerValues(headers['content-security-policy']).flatMap((p) => p.split(';'))) {
    const m = /^\s*frame-ancestors\s+(.*)$/i.exec(part)
    if (m && !/(?:^|\s)\*(?:\s|$)/.test(m[1])) return 'frame-ancestors'
  }
  return undefined
}

function withPath(base: string, url: URL): string {
  return `${base}${url.pathname}${url.search}${url.hash}`
}

async function withDeadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ServicePreviewError(
      `${what} did not finish within ${Math.round(ms / 1000)}s`, 504, 'timeout',
      'The host may still be connecting. Retry in a moment.',
    )), ms)
  })
  try {
    return await Promise.race([work, deadline])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export interface ServicePreviewDeps {
  probe?: typeof probeService
  localNames?: string[]
  /** Test seam; the route always uses DEADLINE_MS. */
  deadlineMs?: number
}

export async function buildSessionServicePreview(
  session: SessionRecord | null | undefined,
  rawUrl: string,
  deps: ServicePreviewDeps = {},
): Promise<ServicePreviewResult> {
  if (!session) throw new ServicePreviewError('session not found', 404, 'not_found')
  const url = parseServiceUrl(rawUrl)
  if (!url) throw new ServicePreviewError('not an http(s) URL', 400, 'bad_url')
  return withDeadline(resolvePreview(session, url, deps), deps.deadlineMs ?? DEADLINE_MS, `Opening ${url.host}`)
}

async function resolvePreview(session: SessionRecord, url: URL, deps: ServicePreviewDeps): Promise<ServicePreviewResult> {
  const probe = deps.probe ?? probeService
  const config = await getConfig()
  const hosts = (config.hosts ?? {}) as Record<string, HostDef>
  const localNames = deps.localNames ?? [os.hostname()]
  const target = resolveServiceTarget(url, { sessionHost: session.host, hosts, localNames })
  if (!target) {
    throw new ServicePreviewError(
      `${url.hostname} is not this machine or a configured host`, 422, 'unknown_host',
      'Open it as a normal link instead.',
    )
  }
  const remotePort = effectivePort(url)
  const scheme = url.protocol.replace(':', '')

  if (target.host === LOCAL) {
    // Same machine as the browser: load it as written, except the wildcard
    // bind addresses, which are not connectable destinations.
    const h = bareHost(url.hostname)
    const loadHost = h === '0.0.0.0' || h === '::' ? 'localhost' : url.host.replace(/:\d+$/, '')
    const directOrigin = `${scheme}://${loadHost}:${remotePort}`
    const direct = withPath(directOrigin, url)
    const probed = await probe(directOrigin)
    if (probed.kind === 'refused') {
      throw new ServicePreviewError(
        `Nothing is answering on this machine at port ${remotePort}`, 502, 'unreachable',
        'Check that the server is still running, then Retry.',
      )
    }
    return finish(url, direct, 'local', LOCAL, remotePort, remotePort, probed)
  }

  const def = hosts[target.host]
  if (!def?.hostname) {
    throw new ServicePreviewError(`Unknown session host alias: ${target.host}`, 422, 'unknown_host')
  }
  let conn: Awaited<ReturnType<typeof getDaemonConnection>>
  try {
    conn = await getDaemonConnection(target.host, { hostname: def.hostname, user: def.user, port: def.port })
  } catch (err) {
    throw new ServicePreviewError(
      `Could not reach ${target.host}: ${err instanceof Error ? err.message : String(err)}`, 502, 'tunnel_failed',
      'The host is not connected. Check Settings > Remote hosts, then Retry.',
    )
  }

  let lastError = ''
  for (const address of target.targets) {
    let localPort: number
    try {
      localPort = await conn.ensurePortForward(remotePort, address, { evictable: true })
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
      continue
    }
    const tunnelOrigin = `${scheme}://127.0.0.1:${localPort}`
    const tunnelUrl = withPath(tunnelOrigin, url)
    const probed = await probe(tunnelOrigin)
    if (probed.kind === 'refused') {
      // Nothing behind this address: do not keep an ssh process for it.
      conn.closePortForward(remotePort, address)
    } else {
      log.session.info('service-preview: ready', {
        host: target.host, sessionId: session.claudeSessionId, remotePort, localPort,
        address, reason: target.reason, reachability: probed.kind,
      })
      return finish(url, tunnelUrl, 'tunnel', target.host, remotePort, localPort, probed)
    }
    lastError = probed.error
  }
  log.session.warn('service-preview: unreachable', {
    host: target.host, sessionId: session.claudeSessionId, remotePort, targets: target.targets, error: lastError,
  })
  throw new ServicePreviewError(
    `Nothing is answering on ${target.host} at port ${remotePort}`, 502, 'unreachable',
    'Check that the server is still running on that host, then Retry.',
  )
}

function finish(
  url: URL, loadUrl: string, via: 'local' | 'tunnel', host: string,
  remotePort: number, localPort: number, probed: ProbeResult,
): ServicePreviewResult {
  const blocked: ServicePreviewResult['embedBlockedBy'] = probed.kind === 'ok'
    ? frameBlockFromHeaders(probed.headers) ?? (probed.tlsUntrusted ? 'certificate' : undefined)
    : undefined
  return {
    requestedUrl: url.toString(),
    url: loadUrl,
    via,
    host,
    remotePort,
    localPort,
    embeddable: !blocked,
    ...(blocked ? { embedBlockedBy: blocked } : {}),
    reachability: probed.kind === 'ok' ? 'ok' : 'slow',
  }
}
