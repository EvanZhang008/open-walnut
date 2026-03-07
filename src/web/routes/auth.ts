/**
 * API key management routes.
 *
 * POST /api/auth/keys     — create a new API key
 * GET /api/auth/keys      — list API keys (key values hidden)
 * DELETE /api/auth/keys/:name — delete an API key by name
 */

import { Router } from 'express'
import crypto from 'node:crypto'
import { getConfig, saveConfig } from '../../core/config-manager.js'
import { log } from '../../logging/index.js'

export const authRouter = Router()

/**
 * Generate a random API key with `wlnt_sk_` prefix.
 */
function generateApiKey(): string {
  return `wlnt_sk_${crypto.randomBytes(24).toString('hex')}`
}

// POST /api/auth/keys — create a new API key
authRouter.post('/keys', async (req, res, next) => {
  try {
    const { name } = req.body as { name?: string }
    if (!name || typeof name !== 'string' || name.length < 1) {
      res.status(400).json({ error: 'Missing or invalid name' })
      return
    }

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
    })

    await saveConfig({ ...config, api_keys: keys })
    log.web.info('auth: API key created', { name })

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
    const config = await getConfig()
    const keys = config.api_keys ?? []
    const filtered = keys.filter((k) => k.name !== name)

    if (filtered.length === keys.length) {
      res.status(404).json({ error: `Key "${name}" not found` })
      return
    }

    // Also remove any push tokens bound to this key
    const pushTokens = (config.push_tokens ?? []).filter((t) => t.key_name !== name)

    await saveConfig({ ...config, api_keys: filtered, push_tokens: pushTokens })
    log.web.info('auth: API key deleted', { name })
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})
