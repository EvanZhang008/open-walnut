/**
 * First-boot claim flow (cloud mode).
 *
 * GET  /api/v1/setup/status — public: { claimed: boolean }
 * POST /api/v1/setup/claim  — public, rate-limited: exchange the one-time
 *   setup token (printed to the server log while zero devices exist) for the
 *   first device token. Closes permanently once any device is paired.
 *
 * Both endpoints are exempt from authMiddleware (see CLOUD_EXEMPT_PREFIXES in
 * src/web/middleware/auth.ts) — they must work before any token exists.
 */

import { Router } from 'express'
import { claimInstance, isClaimed } from '../../core/device-auth.js'
import { recordAuthFailure, isAuthRateLimited } from '../middleware/auth-rate-limit.js'
import { log } from '../../logging/index.js'

export const setupRouter = Router()

// GET /api/v1/setup/status — lets a client (iOS app, web login screen) decide
// whether to show the claim UI or the token-entry UI.
setupRouter.get('/status', async (_req, res, next) => {
  try {
    res.json({ claimed: await isClaimed() })
  } catch (err) {
    next(err)
  }
})

// POST /api/v1/setup/claim { setupToken, deviceName } → { deviceName, token }
setupRouter.post('/claim', async (req, res, next) => {
  const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown'
  try {
    if (isAuthRateLimited(ip)) {
      log.web.warn('setup/claim: rate limited', { ip })
      res.status(429).json({ error: 'Too many attempts. Try again later.' })
      return
    }

    const { setupToken, deviceName } = (req.body ?? {}) as { setupToken?: string; deviceName?: string }
    if (!setupToken || typeof setupToken !== 'string' || !deviceName || typeof deviceName !== 'string') {
      recordAuthFailure(ip)
      res.status(400).json({ error: 'Missing setupToken or deviceName' })
      return
    }

    if (await isClaimed()) {
      // Permanently closed — do NOT leak whether the setup token was right.
      res.status(403).json({ error: 'Instance already claimed' })
      return
    }

    try {
      const { name, token } = await claimInstance(setupToken, deviceName)
      log.web.info('setup/claim: instance claimed', { deviceName: name, ip })
      // The token is returned ONCE — it is never shown again.
      res.json({ deviceName: name, token })
    } catch (err) {
      recordAuthFailure(ip)
      const message = err instanceof Error ? err.message : String(err)
      log.web.warn('setup/claim: rejected', { ip, reason: message })
      const status = message.includes('already claimed') ? 403 : 401
      res.status(status).json({ error: message })
    }
  } catch (err) {
    next(err)
  }
})
