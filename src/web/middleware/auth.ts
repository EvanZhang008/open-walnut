/**
 * API authentication middleware.
 *
 * Primary mode (default, the user's Mac):
 * - Requests from THIS machine skip auth: a direct loopback socket with a
 *   loopback Host and Origin (see local-trust.ts for why all three matter).
 * - Every other caller, private networks included, sends
 *   `Authorization: Bearer <credential>`: a device token (the pairing QR
 *   carries one) or a config.yaml `api_keys[]` key. Daemon machine tokens
 *   are refused here, as everywhere outside /bridge.
 *
 * Cloud mode (WALNUT_CLOUD_MODE=1, public EC2 box):
 * - The private-network bypass is DISABLED — every request must present a
 *   Bearer credential: a device token (auth.json, see src/core/device-auth.ts)
 *   or a legacy config.yaml API key.
 * - Exempt paths: the first-boot claim endpoints (/api/v1/setup/*) and the
 *   monitoring health check (/api/system/health). Static SPA assets are served
 *   outside the /api mount, so they are inherently exempt.
 * - Auth failures are rate-limited in-app (10/min per IP → 429).
 */

import type { Request, Response, NextFunction } from 'express'
import { getConfig } from '../../core/config-manager.js'
import { CLOUD_MODE } from '../../constants.js'
import { verifyDeviceToken } from '../../core/device-auth.js'
import { recordAuthFailure, isAuthRateLimited } from './auth-rate-limit.js'
import { classifyLocalRequest, isCrossSiteRefusal } from './local-trust.js'
import { log } from '../../logging/index.js'

// Paths (relative to the /api mount) that stay public in cloud mode:
// - /v1/setup/*: first-boot claim flow — must work before any token exists.
// - /system/health: monitoring / load-balancer health checks.
const CLOUD_EXEMPT_PREFIXES = ['/v1/setup/']
const CLOUD_EXEMPT_PATHS = new Set(['/system/health'])

function isCloudExemptPath(mountRelativePath: string): boolean {
  if (CLOUD_EXEMPT_PATHS.has(mountRelativePath)) return true
  return CLOUD_EXEMPT_PREFIXES.some((p) => mountRelativePath.startsWith(p))
}

function requestIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown'
}

/**
 * Validate a Bearer credential string: device token first (cloud credential),
 * then legacy config.yaml API keys. Returns the credential's display name.
 * kind 'machine' = daemon bridge credential — valid ONLY for the /bridge WS
 * upgrade; every other consumer must reject it.
 */
export async function validateBearerCredential(token: string): Promise<{ name: string; kind: 'device' | 'api_key' | 'machine' } | null> {
  const device = await verifyDeviceToken(token)
  if (device) return { name: device.name, kind: device.kind === 'machine' ? 'machine' : 'device' }
  const keyName = await validateApiKey(token)
  if (keyName) return { name: keyName, kind: 'api_key' }
  return null
}

/**
 * Express middleware: authenticate requests via Bearer token.
 */
export async function authMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (CLOUD_MODE) {
    await cloudAuthMiddleware(req, res, next)
    return
  }

  const trust = classifyLocalRequest(req)
  const header = req.headers.authorization
  const bearer = header?.startsWith('Bearer ') ? header.slice(7) : ''

  if (trust.trusted) {
    // Still IDENTIFY a device that bothered to present a token. The waiver only
    // drops the requirement to authenticate; it must not erase who the caller
    // is, or routes keyed on device identity (POST /api/v1/devices/self) break.
    if (bearer) {
      try {
        const cred = await validateBearerCredential(bearer)
        if (cred) {
          ;(req as Request & { apiKeyName?: string }).apiKeyName = cred.name
          ;(req as Request & { deviceName?: string }).deviceName = cred.kind === 'device' ? cred.name : undefined
        }
      } catch { /* identification is best-effort here; the waiver still applies */ }
    }
    next()
    return
  }

  const ip = requestIp(req)
  if (!bearer) {
    if (isCrossSiteRefusal(trust)) {
      // A page on another site (or a DNS-rebound name) driving this machine's
      // browser. Say so: "authentication required" would send a developer
      // hunting for a token they do not need from their own origin.
      log.web.warn('auth: cross-site request refused', { reason: trust.reason, origin: req.headers.origin, host: req.headers.host, path: req.path })
      res.status(403).json({ error: 'Refused: this request came from another site. Open Walnut at http://localhost instead.' })
      return
    }
    // `code` lets the web console tell "this browser is not paired" apart from
    // any other 401 (web/src/api/unpaired.ts).
    res.status(401).json({ error: 'Authentication required. Pair this device in the Walnut console (Settings > Phones & Cloud) or with `walnut device add <name>`, and send Authorization: Bearer <token>', code: 'not_paired' })
    return
  }

  if (isAuthRateLimited(ip)) {
    log.web.warn('auth: rate limited', { ip })
    res.status(429).json({ error: 'Too many authentication failures. Try again later.' })
    return
  }

  try {
    const cred = await validateBearerCredential(bearer)
    if (!cred || cred.kind === 'machine') {
      recordAuthFailure(ip)
      log.web.warn('auth: invalid credential', { ip, machine: cred?.kind === 'machine' })
      res.status(401).json({ error: 'Invalid or revoked token', code: 'token_refused' })
      return
    }
    ;(req as Request & { apiKeyName?: string }).apiKeyName = cred.name
    ;(req as Request & { deviceName?: string }).deviceName = cred.kind === 'device' ? cred.name : undefined
    next()
  } catch (err) {
    log.web.error('auth middleware error', { error: err instanceof Error ? err.message : String(err) })
    res.status(500).json({ error: 'Internal auth error' })
  }
}

/**
 * Cloud-mode auth: no LAN bypass, device tokens (or legacy API keys) required
 * on every /api request except the claim flow and the health check.
 */
async function cloudAuthMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  // req.path here is relative to the /api mount point (e.g. '/tasks').
  if (isCloudExemptPath(req.path)) {
    next()
    return
  }

  const ip = requestIp(req)
  if (isAuthRateLimited(ip)) {
    log.web.warn('auth: rate limited', { ip })
    res.status(429).json({ error: 'Too many authentication failures. Try again later.' })
    return
  }

  const authHeader = req.headers.authorization
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    // A token-ABSENT request is the normal first contact (an unpaired browser
    // loading the SPA fires a dozen of these on boot), not a guessing attempt —
    // it cannot brute-force anything. Counting it burned the whole 10/min budget
    // on one page load and 429-locked the very device trying to pair. Only
    // invalid-token attempts (below) feed the limiter. Same rule as git-http.
    res.status(401).json({ error: 'Authentication required. Use Authorization: Bearer <device_token>' })
    return
  }

  try {
    const cred = await validateBearerCredential(authHeader.slice(7))
    if (!cred || cred.kind === 'machine') {
      // Machine tokens are bridge-upgrade-only: a leaked daemon credential
      // must not open the whole REST surface.
      recordAuthFailure(ip)
      log.web.warn('auth: invalid device token', { ip, machine: cred?.kind === 'machine' })
      res.status(401).json({ error: 'Invalid or revoked token' })
      return
    }
    ;(req as Request & { apiKeyName?: string; deviceName?: string }).apiKeyName = cred.name
    ;(req as Request & { deviceName?: string }).deviceName = cred.kind === 'device' ? cred.name : undefined
    next()
  } catch (err) {
    log.web.error('cloud auth middleware error', { error: err instanceof Error ? err.message : String(err) })
    res.status(500).json({ error: 'Internal auth error' })
  }
}

/**
 * Validate an API key string against config. Returns the key name or null.
 */
export async function validateApiKey(key: string): Promise<string | null> {
  try {
    const config = await getConfig()
    const keys = config.api_keys ?? []
    const match = keys.find((k) => k.key === key)
    return match?.name ?? null
  } catch {
    return null
  }
}
