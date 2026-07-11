/**
 * API authentication middleware.
 *
 * Trusted-LAN mode (default, Mac at home):
 * - Requests from localhost/private networks skip auth (backward compat with web SPA).
 * - Remote requests require `Authorization: Bearer <key>` matching a key in config.yaml.
 * - Keys are stored in config.yaml under `api_keys[]`.
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
import { log } from '../../logging/index.js'

const LOCALHOST_ADDRS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost'])

// Paths (relative to the /api mount) that stay public in cloud mode:
// - /v1/setup/*: first-boot claim flow — must work before any token exists.
// - /system/health: monitoring / load-balancer health checks.
const CLOUD_EXEMPT_PREFIXES = ['/v1/setup/']
const CLOUD_EXEMPT_PATHS = new Set(['/system/health'])

function isCloudExemptPath(mountRelativePath: string): boolean {
  if (CLOUD_EXEMPT_PATHS.has(mountRelativePath)) return true
  return CLOUD_EXEMPT_PREFIXES.some((p) => mountRelativePath.startsWith(p))
}

// Walnut is a personal tool that runs on a home/office LAN. Devices on the same
// private network (phones, tablets) need API access without API keys; only
// requests arriving from the public internet require Bearer auth.
// NOTE: this bypass is disabled entirely in cloud mode.
function isPrivateNetwork(ip: string): boolean {
  // Strip ::ffff: prefix for IPv4-mapped IPv6
  const v4 = ip.startsWith('::ffff:') ? ip.slice(7) : ip
  if (LOCALHOST_ADDRS.has(ip)) return true
  // 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
  const parts = v4.split('.').map(Number)
  if (parts.length !== 4) return false
  return parts[0] === 10
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168)
}

function isLocalhost(req: Request): boolean {
  const ip = req.ip ?? req.socket.remoteAddress ?? ''
  return isPrivateNetwork(ip)
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

  // Localhost/private-LAN requests always pass through (backward compat with web SPA)
  if (isLocalhost(req)) {
    next()
    return
  }

  const authHeader = req.headers.authorization
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authentication required. Use Authorization: Bearer <api_key>' })
    return
  }

  const token = authHeader.slice(7) // strip "Bearer "
  try {
    const config = await getConfig()
    const keys = config.api_keys ?? []
    const match = keys.find((k) => k.key === token)

    if (!match) {
      log.web.warn('auth: invalid API key', { ip: req.ip })
      res.status(403).json({ error: 'Invalid API key' })
      return
    }

    // Attach key info to request for downstream use
    ;(req as Request & { apiKeyName?: string }).apiKeyName = match.name
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
    recordAuthFailure(ip)
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
