/**
 * A browser renews its own sign-in (core/browser-sign-in.ts).
 *
 *   POST /api/auth/browser/refresh[?secure=1]
 *     The refresh cookie (walnut_refresh[_s][_<port>], one per origin: device-cookie.ts
 *     refreshCookieName; Path=/api/auth/browser) rides by
 *     itself; the page also sends the token it holds, which starts the pair of
 *     a browser signed in before renewing existed (Authorization, else the
 *     walnut_signin or walnut_device cookie of the builds before).
 *       200 { token, name, accessUntil, accessMs }   a new pair, the cookie set
 *       204                                          nothing to renew here
 *       401 { code: refresh_refused | refresh_reused | refresh_expired | refresh_missing }
 *                                                    signed out, cookie cleared
 *       409 { code: refresh_raced }                  ask again in a second
 *       429 { code: rate_limited }
 *     Public at the auth middleware (it is how an expired access token is
 *     replaced), primary only. A host replica forwards it to the Mac, and a
 *     plain host server too; while the Mac is away they answer 503 and the page
 *     keeps the token it has.
 *
 *   POST /api/devices/browser-sign-ins/revoke [{ names }]  → { revoked: [names], refused: [names] }
 *     Signs out every browser signed in with a code (never the extension, a
 *     phone app or an API key), each under the rule of removing that device;
 *     with `names`, only those of them (the ones Settings listed).
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { readDeviceRegistry, revokeDeviceAs } from '../../core/device-auth.js'
import { DeviceChangeRefused } from '../../core/device-actor.js'
import { BROWSER_SIGN_IN_NAME, renewBrowserSignIn } from '../../core/browser-sign-in.js'
import { log } from '../../logging/index.js'
import {
  DEVICE_COOKIE, SIGNIN_COOKIE, cookieValue, deviceCookieHeader, pageIsSecure, refreshCookieHeader, refreshCookieName,
} from '../middleware/device-cookie.js'
import { isAuthRateLimited, recordAuthFailure, RATE_LIMITED_BODY, RATE_LIMIT_RETRY_AFTER_S } from '../middleware/auth-rate-limit.js'
import { askedByThePage } from './browser-session.js'
import { actorOf } from './devices.js'

/** Relative to the /api mount: the auth middleware lets it through (middleware/auth.ts). */
export const BROWSER_REFRESH_API_PATH = '/auth/browser/refresh'

export const browserRefreshRouter = Router()

function signedOut(res: Response, cookie: string, secure: boolean, code: string, error: string): void {
  res.append('Set-Cookie', refreshCookieHeader(cookie, null, secure))
  res.status(401).json({ error, code })
}

browserRefreshRouter.post('/refresh', async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.set('Cache-Control', 'no-store')
    // Only the page's own call: SameSite=Strict keeps the cookie off any other site's request already.
    if (!askedByThePage(req.headers)) {
      res.status(403).json({ error: 'Refused: a sign-in renews only from its own page.', code: 'cross_site' })
      return
    }
    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown'
    if (isAuthRateLimited(ip)) {
      res.status(429).set('Retry-After', RATE_LIMIT_RETRY_AFTER_S).json(RATE_LIMITED_BODY)
      return
    }
    const raw = req.headers.cookie
    const secure = pageIsSecure(req)
    // This page's own cookie (one per origin): another Walnut's on the same host name is never read.
    const cookie = refreshCookieName(req, secure)
    const refreshToken = cookieValue(raw, cookie)
    const header = req.headers.authorization
    const oldToken = header?.startsWith('Bearer ') ? header.slice(7) : (cookieValue(raw, SIGNIN_COOKIE) || cookieValue(raw, DEVICE_COOKIE))
    const out = await renewBrowserSignIn({ refreshToken, oldToken })
    switch (out.kind) {
      case 'renewed':
        res.append('Set-Cookie', refreshCookieHeader(cookie, out.refreshToken, secure))
        // The long-lived token of the builds before goes: the refresh cookie replaces it.
        if (cookieValue(raw, SIGNIN_COOKIE)) res.append('Set-Cookie', deviceCookieHeader(null, secure))
        res.json({ token: out.token, name: out.name, accessUntil: out.accessUntil, accessMs: out.accessMs })
        return
      case 'raced':
        res.status(409).set('Retry-After', '1').json({ error: 'This sign-in was renewed a moment ago; ask again.', code: 'refresh_raced' })
        return
      case 'limited':
        res.status(429).set('Retry-After', '60').json({ error: 'This sign-in renewed too often; try again in a minute.', code: 'rate_limited' })
        return
      case 'replayed':
        signedOut(res, cookie, secure, 'refresh_reused', 'This browser was signed out: its sign-in was used from somewhere else. Sign in again with a new link.')
        return
      case 'idle':
        signedOut(res, cookie, secure, 'refresh_expired', 'This browser was signed out after a year without use. Sign in again with a new link.')
        return
      case 'lost':
        signedOut(res, cookie, secure, 'refresh_missing', 'This browser was signed out: its sign-in cookie is gone. Sign in again with a new link.')
        return
      case 'refused':
        if (out.removed) {
          // A token it once issued, not a guess: no count toward the address limit.
          signedOut(res, cookie, secure, 'device_removed', 'This browser was signed out on the computer Walnut runs on. Sign in again with a new link.')
          return
        }
        recordAuthFailure(ip, refreshToken || oldToken)
        log.web.warn('browser sign-in: a renewal with a token nothing here knows', { ip, cookie: !!refreshToken })
        signedOut(res, cookie, secure, 'refresh_refused', 'This browser is not signed in any more. Sign in again with a new link.')
        return
      case 'nothing':
        if (out.staleCookie) res.append('Set-Cookie', refreshCookieHeader(cookie, null, secure))
        res.status(204).end()
        return
    }
  } catch (err) {
    next(err)
  }
})

export const browserSignInsRouter = Router()

browserSignInsRouter.post('/browser-sign-ins/revoke', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const by = actorOf(req)
    // `names`: the ones the person saw listed and confirmed, so the count they read is the
    // count signed out; one that signed in after the list was drawn stays (and is listed next).
    const asked = (req.body as { names?: unknown } | undefined)?.names
    if (asked !== undefined && !(Array.isArray(asked) && asked.every((n) => typeof n === 'string'))) {
      // Never "every browser" by mistake: a list that is not one is refused.
      res.status(400).json({ error: '`names` must be a list of device names.', code: 'bad_names' })
      return
    }
    const only = asked === undefined ? null : new Set(asked as string[])
    const names = (await readDeviceRegistry()).devices
      .filter((d) => d.kind !== 'machine' && BROWSER_SIGN_IN_NAME.test(d.name) && (!only || only.has(d.name)))
      .map((d) => d.name)
    const revoked: string[] = []
    const refused: string[] = []
    for (const name of names) {
      try {
        if (await revokeDeviceAs(name, { by })) revoked.push(name)
      } catch (err) {
        if (!(err instanceof DeviceChangeRefused)) throw err
        refused.push(name)
      }
    }
    log.web.info(only ? 'browser sign-in: the listed browsers signed out' : 'browser sign-in: every browser signed out', { revoked: revoked.length, refused: refused.length })
    res.json({ revoked, refused })
  } catch (err) {
    next(err)
  }
})
