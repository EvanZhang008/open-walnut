/**
 * API key authentication middleware.
 *
 * - Requests from localhost/loopback skip auth (backward compat with web SPA).
 * - Remote requests require `Authorization: Bearer <key>` matching a key in config.yaml.
 * - Keys are stored in config.yaml under `api_keys[]`.
 */

import type { Request, Response, NextFunction } from 'express'
import { getConfig } from '../../core/config-manager.js'
import { log } from '../../logging/index.js'

const LOCALHOST_ADDRS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost'])

function isLocalhost(req: Request): boolean {
  const ip = req.ip ?? req.socket.remoteAddress ?? ''
  return LOCALHOST_ADDRS.has(ip)
}

/**
 * Express middleware: authenticate remote requests via Bearer token.
 */
export async function authMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  // Localhost requests always pass through (backward compat with web SPA)
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
