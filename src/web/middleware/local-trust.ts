/**
 * Which requests a non-cloud server trusts without a credential: this machine only.
 *
 * A request counts as "this machine" when all three hold:
 *
 *  1. The socket is loopback and no proxy header names another client. A local
 *     reverse proxy or tunnel forwards remote traffic over loopback, so the
 *     socket address alone proves nothing.
 *  2. The Host header names a loopback host. A DNS-rebinding page reaches
 *     127.0.0.1 under its own domain name, and Host still carries that name.
 *  3. The Origin, when present, is this server's own origin: a loopback name
 *     AND the port the request arrived on. Any web page the user opens can send
 *     a form post or open a WebSocket to localhost (CORS stops neither), and the
 *     browser labels that request with the page's Origin. The port matters too:
 *     a dev server on another local port, or a service the session web view
 *     frames at http://127.0.0.1:<forwarded port>, is a different site. The Vite
 *     dev proxy restates its own pages' Origin as its target's (web/dev-proxy-origin.ts).
 *
 * Everyone else, private networks included, presents a credential: a device
 * token minted on this machine (the pairing QR carries one) or a config.yaml
 * API key. Until 2026-09 any private-network address was waived, which let
 * anyone on the same Wi-Fi open a terminal through /ws.
 *
 * Limit: a local reverse proxy that adds none of the proxy headers below (a
 * bare nginx proxy_pass, socat, `ssh -R`) is indistinguishable from a local
 * client. The docs tell anyone putting a proxy in front to send X-Forwarded-For.
 *
 * Zero imports on purpose: the HTTP middleware and the WS upgrade share it.
 */

import type { IncomingHttpHeaders } from 'node:http'

const LOOPBACK_ADDRS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

export function isLoopbackAddress(addr: string | undefined): boolean {
  return !!addr && LOOPBACK_ADDRS.has(addr)
}

/**
 * A name that always resolves to this machine. Deliberately excludes the
 * wildcard binds (0.0.0.0, ::), since browsers have routed http://0.0.0.0 to
 * localhost, and `*.localhost`, which some resolvers send to real DNS.
 */
export function isLoopbackName(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  return h === 'localhost'
    || /^127(?:\.\d{1,3}){3}$/.test(h)
    || h === '::1'
}

/** Hostname part of a Host header (`localhost:3456`, `[::1]:3456`). */
function hostHeaderName(host: string): string {
  if (host.startsWith('[')) {
    const end = host.indexOf(']')
    return end > 0 ? host.slice(0, end + 1) : host
  }
  const colon = host.lastIndexOf(':')
  return colon > 0 ? host.slice(0, colon) : host
}

/**
 * No Origin (curl, the CLI, native apps, same-origin GETs), or this server's
 * own: a loopback name on `ownPort`. Without a known port only the name counts.
 */
export function isOwnOrigin(origin: string | undefined, ownPort?: number): boolean {
  if (origin === undefined) return true
  try {
    const u = new URL(origin)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
    if (!isLoopbackName(u.hostname)) return false
    if (ownPort === undefined) return true
    return Number(u.port || (u.protocol === 'https:' ? 443 : 80)) === ownPort
  } catch {
    return false // includes the opaque "null" origin of sandboxed frames
  }
}

export type LocalTrust =
  | { trusted: true }
  | { trusted: false; reason: 'not-loopback' | 'proxied' | 'foreign-host' | 'foreign-origin' }

interface RequestLike {
  socket?: { remoteAddress?: string; localPort?: number }
  headers: IncomingHttpHeaders
}

/** Headers a proxy or tunnel adds; any one means the client is somewhere else. */
const PROXY_HEADERS = ['x-forwarded-for', 'forwarded', 'x-real-ip', 'x-forwarded-host', 'x-forwarded-proto', 'via'] as const

export function classifyLocalRequest(req: RequestLike): LocalTrust {
  if (!isLoopbackAddress(req.socket?.remoteAddress)) return { trusted: false, reason: 'not-loopback' }
  const h = req.headers
  if (PROXY_HEADERS.some((name) => h[name] !== undefined)) return { trusted: false, reason: 'proxied' }
  // A browser always sends Host; a missing one is a raw local client.
  if (typeof h.host === 'string' && !isLoopbackName(hostHeaderName(h.host))) {
    return { trusted: false, reason: 'foreign-host' }
  }
  const origin = typeof h.origin === 'string' ? h.origin : undefined
  if (!isOwnOrigin(origin, req.socket?.localPort)) return { trusted: false, reason: 'foreign-origin' }
  return { trusted: true }
}

/** The request is a browser page from another site or a rebound name, not a remote device. */
export function isCrossSiteRefusal(t: LocalTrust): boolean {
  return !t.trusted && (t.reason === 'foreign-host' || t.reason === 'foreign-origin')
}
