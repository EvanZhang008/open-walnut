/**
 * The device token a GET or HEAD may carry as a cookie instead of a header:
 * the one credential every Walnut server role (primary, cloud companion, host
 * replica) reads from a subresource. Its own module so the host replica's auth
 * reads it without importing the primary's middleware.
 */
import type { Request } from 'express'

/** The cookie a signed-in browser mirrors its device token into (web/src/api/device-token.ts). */
export const DEVICE_COOKIE = 'walnut_device'

/**
 * The same token in a cookie this server sets (GET /api/devices/browser-session).
 * Its own name: a page can never write over an HttpOnly cookie, so under the
 * page's name a re-paired browser would keep an old token in it until the next
 * renewal, and forever under a release without the route.
 */
export const SIGNIN_COOKIE = 'walnut_signin'

/** 400 days: the longest a browser keeps any cookie (Chrome's cap). Renewed on every open. */
export const DEVICE_COOKIE_MAX_AGE_S = 400 * 24 * 60 * 60

/**
 * The `walnut_signin` cookie as the server sets it: HttpOnly and set by the
 * server, so neither of Safari's 7-day rules reaches it (a cookie written by a
 * page's script is kept 7 days at most; an unopened site's script storage,
 * localStorage included, is removed after 7 days). The page restores its token
 * from it after that removal. Path=/api and SameSite=Strict as the page's own
 * cookie, so no other site's page can make the browser send it.
 */
export function deviceCookieHeader(token: string | null, secure: boolean): string {
  const attrs = `Path=/api; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`
  return token
    ? `${SIGNIN_COOKIE}=${encodeURIComponent(token)}; ${attrs}; Max-Age=${DEVICE_COOKIE_MAX_AGE_S}`
    : `${SIGNIN_COOKIE}=; ${attrs}; Max-Age=0`
}

/**
 * The refresh token of a browser's renewing sign-in (core/browser-sign-in.ts),
 * in a cookie sent only to the renewal path: HttpOnly, so no script reads it;
 * set by the server, so Safari's 7-day rules never reach it; SameSite=Strict,
 * so no other site's page makes the browser send it. A year, the sign-in's own
 * idle limit, and set again at every renewal.
 */
export const REFRESH_COOKIE = 'walnut_refresh'
export const REFRESH_COOKIE_PATH = '/api/auth/browser'
export const REFRESH_COOKIE_MAX_AGE_S = 365 * 24 * 60 * 60

/**
 * The refresh cookie's name for the page that asked: one per origin, as the
 * access token its localStorage holds is. A cookie ignores the port, and an
 * http page never sees a Secure one, so with one name two Walnuts on one host
 * name (or its http and https pages) would overwrite each other's and each
 * would sign the browser out as one that lost its cookie. `walnut_refresh`
 * (http, default port), `walnut_refresh_s` (https, default port), with
 * `_<port>` for any other port the browser named in its Host header.
 */
export function refreshCookieName(req: Pick<Request, 'headers'>, secure: boolean): string {
  const host = String(req.headers.host ?? '')
  const port = /:(\d{1,5})$/.exec(host)?.[1]
  const base = secure ? `${REFRESH_COOKIE}_s` : REFRESH_COOKIE
  return port ? `${base}_${port}` : base
}

function refreshCookieHeader(name: string, token: string | null, secure: boolean): string {
  const attrs = `Path=${REFRESH_COOKIE_PATH}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`
  return token
    ? `${name}=${encodeURIComponent(token)}; ${attrs}; Max-Age=${REFRESH_COOKIE_MAX_AGE_S}`
    : `${name}=; ${attrs}; Max-Age=0`
}

/**
 * Beside the refresh cookie, one a script can see that holds no secret (`=1`): a page
 * with no token asks the renewal path only when it is there (web/src/api/sign-in-gate.ts),
 * so the computer Walnut runs on and a browser never signed in send no renewal at all.
 * Set by the server like the refresh cookie, so it outlives what Safari clears with the
 * page's storage. One per origin, as the refresh cookie is.
 */
export const REFRESH_MARK_COOKIE = 'walnut_renews'

/**
 * The mark's name for the page that asked, `walnut_renews[_s][_<port>]`, which the page
 * computes from its own location (web/src/api/device-token.ts refreshMarkName). Read from
 * the page's Origin, which a reverse proxy leaves as the browser sent it while it may
 * rewrite Host (`127.0.0.1:3456` behind an https site); from Host as the refresh
 * cookie's name when the request carries none.
 */
export function refreshMarkNameFor(req: Pick<Request, 'headers'>, secure: boolean): string {
  const origin = req.headers.origin
  if (typeof origin === 'string' && origin !== 'null') {
    try {
      const url = new URL(origin)
      if (url.protocol === 'https:' || url.protocol === 'http:') {
        return `${REFRESH_MARK_COOKIE}${url.protocol === 'https:' ? '_s' : ''}${url.port ? `_${url.port}` : ''}`
      }
    } catch { /* not a URL: as Host names it */ }
  }
  return REFRESH_MARK_COOKIE + refreshCookieName(req, secure).slice(REFRESH_COOKIE.length)
}

function refreshMarkHeader(name: string, on: boolean, secure: boolean): string {
  const attrs = `Path=/; SameSite=Strict${secure ? '; Secure' : ''}`
  return on ? `${name}=1; ${attrs}; Max-Age=${REFRESH_COOKIE_MAX_AGE_S}` : `${name}=; ${attrs}; Max-Age=0`
}

/**
 * The page's refresh cookie and its mark, set (a token) or cleared (null) together:
 * the only way a route writes either.
 */
export function refreshCookieHeaders(req: Pick<Request, 'headers'>, token: string | null, secure: boolean): string[] {
  return [
    refreshCookieHeader(refreshCookieName(req, secure), token, secure),
    refreshMarkHeader(refreshMarkNameFor(req, secure), token !== null, secure),
  ]
}

/**
 * Whether the page that asked is https. A tunnel or a reverse proxy ends TLS
 * before this server, so the page says so itself (`?secure=1`, from its own
 * location), beside the proxy's X-Forwarded-Proto. A Secure cookie on an http
 * page would be dropped by the browser.
 */
export function pageIsSecure(req: Pick<Request, 'headers'> & { query?: unknown; secure?: boolean }): boolean {
  const query = (req.query ?? {}) as Record<string, unknown>
  if (query.secure === '1') return true
  if (req.secure === true) return true
  const proto = req.headers['x-forwarded-proto']
  const first = (Array.isArray(proto) ? proto[0] : proto)?.split(',')[0]?.trim().toLowerCase()
  return first === 'https'
}

/** One cookie's value from a Cookie header ('' when absent or unreadable). */
export function cookieValue(raw: string | undefined, name: string): string {
  if (!raw) return ''
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0 || part.slice(0, eq).trim() !== name) continue
    try {
      return decodeURIComponent(part.slice(eq + 1).trim())
    } catch {
      return ''
    }
  }
  return ''
}

/**
 * The device token a GET or HEAD carries in a cookie: an `<img>`, an HTML
 * preview frame or a download cannot send a header. The page's own
 * `walnut_device` first (it follows the page's current token at once), else the
 * server's `walnut_signin`. Never for any other method, so a cookie can only
 * ever read; both are SameSite=Strict, so no other site's page can make the
 * browser send one at all.
 */
export function cookieCredential(req: Pick<Request, 'method' | 'headers'>): string {
  if (req.method !== 'GET' && req.method !== 'HEAD') return ''
  const raw = req.headers.cookie
  if (!raw) return ''
  return cookieValue(raw, DEVICE_COOKIE) || cookieValue(raw, SIGNIN_COOKIE)
}
