/**
 * Push notification token registration routes.
 *
 * POST /api/push/register   — register a push token (bound to API key)
 * DELETE /api/push/register — unregister a push token
 * GET /api/push/status      — current push registration status
 */

import { Router } from 'express'
import { getConfig, saveConfig } from '../../core/config-manager.js'
import { log } from '../../logging/index.js'
import type { PushTokenEntry } from '../../core/types.js'

export const pushRouter = Router()

// POST /api/push/register — register an Expo push token
pushRouter.post('/register', async (req, res, next) => {
  try {
    const { token, platform } = req.body as { token?: string; platform?: string }

    if (!token || typeof token !== 'string') {
      res.status(400).json({ error: 'Missing or invalid token' })
      return
    }
    if (!platform || !['ios', 'android'].includes(platform)) {
      res.status(400).json({ error: 'Missing or invalid platform (ios/android)' })
      return
    }

    // Get the API key name from the authenticated request
    const keyName = (req as typeof req & { apiKeyName?: string }).apiKeyName ?? 'localhost'

    const config = await getConfig()
    const tokens = config.push_tokens ?? []

    // Upsert: remove existing token for this device, add new one
    const filtered = tokens.filter((t: PushTokenEntry) => t.token !== token)
    filtered.push({
      token,
      platform: platform as 'ios' | 'android',
      key_name: keyName,
      registered_at: new Date().toISOString(),
    })

    await saveConfig({ ...config, push_tokens: filtered })
    log.web.info('push: token registered', { keyName, platform, tokenPrefix: token.slice(0, 30) })
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

// DELETE /api/push/register — unregister a push token
pushRouter.delete('/register', async (req, res, next) => {
  try {
    const { token } = req.body as { token?: string }
    if (!token) {
      res.status(400).json({ error: 'Missing token' })
      return
    }

    const config = await getConfig()
    const tokens = config.push_tokens ?? []
    const filtered = tokens.filter((t: PushTokenEntry) => t.token !== token)

    await saveConfig({ ...config, push_tokens: filtered })
    log.web.info('push: token unregistered', { tokenPrefix: token.slice(0, 30) })
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

// GET /api/push/status — check push registration status
pushRouter.get('/status', async (_req, res, next) => {
  try {
    const config = await getConfig()
    const tokens = config.push_tokens ?? []
    res.json({
      registered: tokens.length > 0,
      count: tokens.length,
      tokens: tokens.map((t: PushTokenEntry) => ({
        platform: t.platform,
        key_name: t.key_name,
        registered_at: t.registered_at,
        // Don't expose full token
        token_prefix: t.token.slice(0, 30) + '...',
      })),
    })
  } catch (err) {
    next(err)
  }
})
