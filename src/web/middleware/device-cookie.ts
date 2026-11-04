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

function cookieValue(raw: string, name: string): string {
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
