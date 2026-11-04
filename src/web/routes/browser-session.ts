/**
 * Keeping a signed-in browser signed in (docs/plan/walnut-servers-everywhere.md,
 * "Signing in a browser").
 *
 *   GET /api/devices/browser-session[?secure=1] → { token, name } | 204
 *
 * A browser keeps its device token in localStorage. Safari removes a site's
 * script storage after 7 days of browsing without a visit to it, and keeps a
 * cookie the page's script wrote 7 days at most (2026-11-04, the user: "if
 * cookie is cleared need another code"; "how long will cookie usually last"). So
 * at every open the page asks this route with its token, and the answer sets the
 * token in the server's own HttpOnly `walnut_signin` cookie for 400 days
 * (deviceCookieHeader), which neither rule touches. A page that finds its
 * localStorage empty asks with no header: the cookie rides, and the answer gives
 * the token back, which the page stores again (web/src/api/device-token.ts).
 *
 * The route trusts only what the auth middleware of this server's role checked
 * (the primary's, the cloud companion's, a host replica's): it answers a token
 * only when that middleware named a device for it (`deviceName`), so an API key,
 * a machine credential, a removed or unknown token, or a caller this computer
 * trusts without a token gets 204 and no cookie. The token in the answer is the
 * one the request carried, never another. Every role answers it itself (a host
 * replica's route table keeps it local; the companion forwards only /api/v1), so
 * a phone signs back in through whichever server its address reaches, the Mac
 * away included; the plain host server answers it from its device copy while it
 * shows the alone page (host-server/browser-session.ts).
 */

import type { Request, Response } from 'express'
import { cookieCredential, deviceCookieHeader, pageIsSecure } from '../middleware/device-cookie.js'

export const BROWSER_SESSION_PATH = '/browser-session'

/** The token the request carried: its Bearer header, else (a GET) its cookie (cookieCredential). */
export function presentedToken(req: Pick<Request, 'method' | 'headers'>): string {
  const header = req.headers.authorization
  return header?.startsWith('Bearer ') ? header.slice(7) : cookieCredential(req)
}

/**
 * Only the page itself asks (a same-origin fetch). A browser that says the call
 * came from anywhere else (Sec-Fetch-Site: another site, an address typed in,
 * a link) gets no token back, whatever a CORS rule may allow some day.
 */
export function askedByThePage(headers: Request['headers']): boolean {
  const site = headers['sec-fetch-site']
  return site === undefined || site === 'same-origin'
}

export function browserSessionHandler(req: Request, res: Response): void {
  res.set('Cache-Control', 'no-store')
  const token = presentedToken(req)
  const device = (req as Request & { deviceName?: string }).deviceName
  if (!token || !device || !askedByThePage(req.headers)) {
    res.status(204).end()
    return
  }
  res.append('Set-Cookie', deviceCookieHeader(token, pageIsSecure(req)))
  res.json({ token, name: device })
}
