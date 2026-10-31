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
 * The device token a GET or HEAD carries in the `walnut_device` cookie: an
 * `<img>`, an HTML preview frame or a download cannot send a header. Never for
 * any other method, so a cookie can only ever read; the browser sets it
 * SameSite=Strict, so no other site's page can make it send one at all.
 */
export function cookieCredential(req: Pick<Request, 'method' | 'headers'>): string {
  if (req.method !== 'GET' && req.method !== 'HEAD') return ''
  const raw = req.headers.cookie
  if (!raw) return ''
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0 || part.slice(0, eq).trim() !== DEVICE_COOKIE) continue
    try {
      return decodeURIComponent(part.slice(eq + 1).trim())
    } catch {
      return ''
    }
  }
  return ''
}
