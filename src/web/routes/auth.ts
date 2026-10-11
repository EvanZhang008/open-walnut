/**
 * API key management routes.
 *
 * POST /api/auth/keys     — create a new API key
 * GET /api/auth/keys      — list API keys (key values hidden)
 * DELETE /api/auth/keys/:name — delete an API key by name
 *
 * Creating and deleting keys is for this machine itself, and on a cloud
 * companion for its owner, whose keys stop working when its pairing goes
 * (core/device-actor.ts apiKeyDecision). Never for a phone, another device, or
 * a key: a key made by a phone was a way to pair a device that was not
 * recorded as one (2026-10-03).
 */

import { Router, type Request, type Response } from 'express'
import crypto from 'node:crypto'
import { getConfig, updateConfig } from '../../core/config-manager.js'
import { apiKeyMaker } from '../../core/device-auth.js'
import { DeviceChangeRefused } from '../../core/device-actor.js'
import { log } from '../../logging/index.js'
import { actorOf } from './devices.js'
import { revokePushTokensForDevice } from './push.js'

export const authRouter = Router()

/**
 * Generate a random API key with `wlnt_sk_` prefix.
 */
function generateApiKey(): string {
  return `wlnt_sk_${crypto.randomBytes(24).toString('hex')}`
}

/** May this caller create or delete keys? Answers the refusal and returns null when not. */
async function keyMaker(req: Request, res: Response): Promise<{ deviceId?: string } | null> {
  try {
    return await apiKeyMaker(actorOf(req))
  } catch (err) {
    if (!(err instanceof DeviceChangeRefused)) throw err
    log.web.warn('auth: API key change refused', { caller: (req as Request & { apiKeyName?: string }).apiKeyName, code: err.code })
    res.status(err.status).json({ error: err.message, code: err.code })
    return null
  }
}

// POST /api/auth/keys — create a new API key
authRouter.post('/keys', async (req, res, next) => {
  try {
    const { name } = req.body as { name?: string }
    if (!name || typeof name !== 'string' || name.length < 1) {
      res.status(400).json({ error: 'Missing or invalid name' })
      return
    }
    const maker = await keyMaker(req, res)
    if (!maker) return

    const config = await getConfig()
    const keys = config.api_keys ?? []

    // Check for duplicate name
    if (keys.some((k) => k.name === name)) {
      res.status(409).json({ error: `Key with name "${name}" already exists` })
      return
    }

    const key = generateApiKey()
    keys.push({
      name,
      key,
      created_at: new Date().toISOString(),
      ...(maker.deviceId ? { device_id: maker.deviceId } : {}),
    })

    await updateConfig({ api_keys: keys })
    log.web.info('auth: API key created', { name, ...(maker.deviceId ? { deviceId: maker.deviceId } : {}) })

    // Return the key ONCE — it won't be shown again
    res.json({ name, key, created_at: keys[keys.length - 1].created_at })
  } catch (err) {
    next(err)
  }
})

// GET /api/auth/keys — list API keys (values hidden)
authRouter.get('/keys', async (_req, res, next) => {
  try {
    const config = await getConfig()
    const keys = config.api_keys ?? []
    res.json(
      keys.map((k) => ({
        name: k.name,
        created_at: k.created_at,
        key_preview: k.key.slice(0, 12) + '...',
      }))
    )
  } catch (err) {
    next(err)
  }
})

// DELETE /api/auth/keys/:name — delete an API key
authRouter.delete('/keys/:name', async (req, res, next) => {
  try {
    const { name } = req.params
    if (!await keyMaker(req, res)) return
    const config = await getConfig()
    const keys = config.api_keys ?? []
    const filtered = keys.filter((k) => k.name !== name)

    if (filtered.length === keys.length) {
      res.status(404).json({ error: `Key "${name}" not found` })
      return
    }

    await updateConfig({ api_keys: filtered })
    // Also drop any push tokens bound to this key — a revoked credential whose
    // device keeps getting letter subjects on its lock screen is a privacy leak,
    // not a leftover. Delegated because the rows may live on the PRIMARY (this
    // box relays registrations when it is a replica), and because the delete has
    // to be atomic: the read-then-updateConfig this replaced could reinstate or
    // drop a registration that landed in between.
    const push = await revokePushTokensForDevice(name)
    log.web.info('auth: API key deleted', {
      name, pushTokensRevoked: push.removed, ...(push.pending ? { pushRevokePending: push.pending } : {}),
    })
    res.json({
      ok: true,
      pushTokensRevoked: push.removed,
      ...(push.pending ? { pushRevokePending: true } : {}),
    })
  } catch (err) {
    next(err)
  }
})
