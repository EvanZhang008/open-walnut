/**
 * Signing a browser in with a code (src/core/browser-pairing.ts,
 * docs/plan/walnut-servers-everywhere.md "Signing in a browser").
 *
 *   POST /api/devices/browser-code   → { code, expiresAt, url?, link?, addresses }
 *     The person at this machine mints a code. `link` opens this server's tunnel
 *     address with the code after `#pair=`, which a browser never sends to a server.
 *     `addresses` adds the tunnels of the servers on this Mac's hosts, which stay up
 *     while it sleeps (Connect your phone prefers those).
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
import { createDeviceAs, listDevices } from '../../core/device-auth.js'
import { LOCAL_ACTOR } from '../../core/device-actor.js'
import { clearAuthFailures, isAuthRateLimited, recordAuthFailure } from '../middleware/auth-rate-limit.js'
import { getExposeRuntime } from '../expose-runtime.js'
import { CLOUD_MODE } from '../../constants.js'
import { getConfig } from '../../core/config-manager.js'
import { getHostServerManager } from '../../core/host-server/index.js'
import { isPersonAtThisMachine } from './expose.js'
import { log } from '../../logging/index.js'

export const browserCodeRouter = Router()
export const browserPairV1Router = Router()

/** One address a browser can open Walnut at, with the code after `#pair=`. */
export interface SignInAddress {
  /** `this-computer`, or the host whose server answers there. */
  where: string
  label: string
  url: string
  link: string
  /** A host's server stays up while this computer sleeps; this computer's tunnel does not. */
  alwaysOn: boolean
}

const withCode = (url: string, code: string) => `${url.replace(/\/+$/, '')}/#pair=${code}`

/** The tunnels of the servers this Mac keeps on its hosts, connected right now. A code
 *  minted here works there: a host server forwards sign-in to this Mac, and keeps a copy
 *  of the signed-in browsers for when it is away. */
async function hostAddresses(code: string): Promise<SignInAddress[]> {
  if (CLOUD_MODE) return []
  const manager = getHostServerManager()
  if (!manager) return []
  const hosts = (await getConfig()).hosts ?? {}
  const out: SignInAddress[] = []
  for (const [hostKey, host] of Object.entries(hosts)) {
    if (!host || host.cloud_box) continue
    const view = manager.view(hostKey)
    const expose = view.phase === 'running' ? view.server?.expose : undefined
    if (expose?.state !== 'connected' || !expose.url) continue
    out.push({ where: hostKey, label: host.label?.trim() || hostKey, url: expose.url, link: withCode(expose.url, code), alwaysOn: true })
  }
  return out
}

browserCodeRouter.post('/browser-code', async (req: Request, res: Response, next: NextFunction) => {
  if (!isPersonAtThisMachine(req)) {
    res.status(403).json({ error: 'Only you, at this computer, can sign a browser in.', code: 'person_at_this_machine' })
    return
  }
  try {
    const { code, expiresAt } = mintBrowserCode()
    const status = getExposeRuntime()?.status()
    const url = status?.state === 'connected' ? status.url : undefined
    const own: SignInAddress[] = url ? [{ where: 'this-computer', label: 'This computer', url, link: withCode(url, code), alwaysOn: false }] : []
    let hosts: SignInAddress[] = []
    try { hosts = await hostAddresses(code) } catch (err) {
      log.web.warn('browser sign-in: host addresses unavailable', { error: err instanceof Error ? err.message : String(err) })
    }
    const addresses = [...own, ...hosts]
    log.web.info('browser sign-in code minted', { expiresAt, exposed: Boolean(url), hostAddresses: hosts.length })
    res.json({
      code,
      expiresAt,
      // `url`/`link`: this computer's tunnel as before, else the first host's.
      ...(addresses[0] ? { url: addresses[0].url, link: addresses[0].link } : {}),
      addresses,
    })
  } catch (err) {
    next(err)
  }
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
    const device = await createDeviceAs(name, { by: LOCAL_ACTOR })
    clearAuthFailures(codeKey)
    clearAuthFailures(ip)
    log.web.info('browser signed in', { device: name })
    res.json({ token: device.token, name })
  } catch (err) {
    next(err)
  }
})
