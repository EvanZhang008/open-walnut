/**
 * /api/devices — manage device tokens from the web console (the UI companion
 * to the `walnut device` CLI). The POST response carries the plaintext token
 * and a wn://pair URI exactly once — the console renders it as a QR code for
 * the iOS app to scan; only the hash is stored.
 *
 * Auth: inherited from the global /api authMiddleware (device Bearer tokens
 * in cloud mode, LAN bypass otherwise) — same trust level as the rest of the
 * console. A paired device minting more devices is by design (the console
 * itself is a paired device in cloud mode).
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { createDevice, revokeDevice, listDevices } from '../../core/device-auth.js'
import { log } from '../../logging/index.js'

export const devicesRouter = Router()

// GET /api/devices — list (no secrets)
devicesRouter.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ devices: await listDevices() })
  } catch (err) {
    next(err)
  }
})

// POST /api/devices { name } → { name, token, pairingURI, createdAt }
// The token/URI appear ONLY in this response.
devicesRouter.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : ''
    if (!name) {
      res.status(400).json({ error: 'name is required' })
      return
    }
    // The scanning phone needs the server address too — the console's origin
    // (forwarded through the proxy) IS the reachable URL for this instance.
    const origin = `${req.protocol}://${req.get('host') ?? ''}`
    const { token, createdAt } = await createDevice(name)
    const pairingURI = `wn://pair?name=${encodeURIComponent(name)}&token=${token}&server=${encodeURIComponent(origin)}`
    log.web.info('devices: created via console', { name })
    res.status(201).json({ name, token, pairingURI, createdAt })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes('already exists') || message.includes('Invalid device name')) {
      res.status(400).json({ error: message })
      return
    }
    next(err)
  }
})

// DELETE /api/devices/:name — revoke
devicesRouter.delete('/:name', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const name = String(req.params.name ?? '')
    const removed = await revokeDevice(name)
    if (!removed) {
      res.status(404).json({ error: `Device "${name}" not found` })
      return
    }
    log.web.info('devices: revoked via console', { name })
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})
