/**
 * Signing a browser in with a code (src/core/browser-pairing.ts,
 * docs/plan/walnut-servers-everywhere.md "Signing in a browser").
 *
 *   POST /api/devices/browser-code   → { code, expiresAt, url?, link? }
 *     The person at this machine mints a code. `link` opens this server's tunnel
 *     address with the code after `#pair=`, which a browser never sends to a server.
 *   POST /api/v1/browser-pair { code } → { token, name }
 *     Public (the browser has nothing else yet). Wrong codes are rate limited per
 *     caller address in their own count: through a tunnel every caller is the
 *     tunnel's loopback address, and a browser still holding a removed token
 *     spends the token count on its first page load, which must not lock it out
 *     of entering a fresh code. A right code clears both counts for the address.
 */

import crypto from 'node:crypto'
import { Router, type Request, type Response, type NextFunction } from 'express'
import { consumeBrowserCode, mintBrowserCode } from '../../core/browser-pairing.js'
import { createDevice, listDevices } from '../../core/device-auth.js'
import { LOCAL_ACTOR } from '../../core/device-actor.js'
import { clearAuthFailures, isAuthRateLimited, recordAuthFailure } from '../middleware/auth-rate-limit.js'
import { getExposeRuntime } from '../expose-runtime.js'
import { isPersonAtThisMachine } from './expose.js'
import { log } from '../../logging/index.js'

export const browserCodeRouter = Router()
export const browserPairV1Router = Router()

browserCodeRouter.post('/browser-code', (req: Request, res: Response) => {
  if (!isPersonAtThisMachine(req)) {
    res.status(403).json({ error: 'Only you, at this computer, can sign a browser in.', code: 'person_at_this_machine' })
    return
  }
  const { code, expiresAt } = mintBrowserCode()
  const status = getExposeRuntime()?.status()
  const url = status?.state === 'connected' ? status.url : undefined
  log.web.info('browser sign-in code minted', { expiresAt, exposed: Boolean(url) })
  res.json({
    code,
    expiresAt,
    ...(url ? { url, link: `${url.replace(/\/+$/, '')}/#pair=${code}` } : {}),
  })
})

async function freshBrowserName(): Promise<string> {
  const taken = new Set((await listDevices()).map((d) => d.name))
  for (;;) {
    const name = `browser-${crypto.randomBytes(3).toString('hex')}`
    if (!taken.has(name)) return name
  }
}

browserPairV1Router.post('/browser-pair', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown'
    const codeKey = `browser-code:${ip}`
    if (isAuthRateLimited(codeKey)) {
      res.status(429).json({ error: { code: 'rate_limited', message: 'Too many wrong codes. Wait a minute, then try again.' } })
      return
    }
    const code = (req.body as { code?: unknown } | undefined)?.code
    if (typeof code !== 'string' || code.length > 32 || !consumeBrowserCode(code)) {
      recordAuthFailure(codeKey)
      log.web.warn('browser sign-in: wrong or expired code', { ip })
      res.status(400).json({ error: { code: 'invalid_code', message: 'That code is wrong or has expired. Make a new one in Walnut on your computer.' } })
      return
    }
    const name = await freshBrowserName()
    const device = await createDevice(name, { by: LOCAL_ACTOR })
    clearAuthFailures(codeKey)
    clearAuthFailures(ip)
    log.web.info('browser signed in', { device: name })
    res.json({ token: device.token, name })
  } catch (err) {
    next(err)
  }
})
