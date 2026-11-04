/**
 * GET /api/devices/browser-session on the plain host server while it shows the
 * alone page (src/web/routes/browser-session.ts is the full server's). Any other
 * time the request goes to the Mac or the companion like every request.
 *
 * A phone whose page storage Safari cleared (7 days without a visit) has only its
 * HttpOnly `walnut_signin` cookie left. The alone page asks here with no header,
 * the cookie rides, and a token this server's device copy knows comes back with
 * the cookie renewed. Anything else (no token, no copy from the Mac yet, a token
 * the copy does not name) is 204 and sets nothing.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { cookieCredential, deviceCookieHeader, pageIsSecure } from '../web/middleware/device-cookie.js'
import { askedByThePage } from '../web/routes/browser-session.js'
import type { DeviceCopy } from './device-copy.js'

export const BROWSER_SESSION_URL = '/api/devices/browser-session'

export function isBrowserSessionRequest(req: IncomingMessage): boolean {
  if (req.method !== 'GET') return false
  return new URL(req.url ?? '/', 'http://x').pathname === BROWSER_SESSION_URL
}

export function answerBrowserSession(req: IncomingMessage, res: ServerResponse, devices: Pick<DeviceCopy, 'held' | 'verify'>): void {
  const url = new URL(req.url ?? '/', 'http://x')
  const header = req.headers.authorization
  const token = header?.startsWith('Bearer ') ? header.slice(7) : cookieCredential({ method: req.method ?? 'GET', headers: req.headers })
  const name = token && devices.held() ? devices.verify(token) : null
  if (!token || !name || !askedByThePage(req.headers)) {
    res.writeHead(204, { 'cache-control': 'no-store' })
    res.end()
    return
  }
  const body = JSON.stringify({ token, name })
  const secure = pageIsSecure({ headers: req.headers, query: { secure: url.searchParams.get('secure') ?? undefined } })
  res.writeHead(200, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    'set-cookie': deviceCookieHeader(token, secure),
  })
  res.end(body)
}
