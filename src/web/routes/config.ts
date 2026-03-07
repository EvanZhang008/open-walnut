/**
 * Config routes — read/write application configuration.
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { getConfig, updateConfig } from '../../core/config-manager.js'
import { bus, EventNames } from '../../core/event-bus.js'
import { VALID_PRIORITIES } from '../../core/types.js'
import { log } from '../../logging/index.js'

export const configRouter = Router()

// GET /api/config
configRouter.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const config = await getConfig()
    res.json({ config })
  } catch (err) {
    next(err)
  }
})

// POST /api/config/test-connection — test Bedrock connection
configRouter.post('/test-connection', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { bedrock_region, bedrock_bearer_token } = req.body
    const config = await getConfig()
    const region = bedrock_region || config.provider?.bedrock_region || 'us-west-2'
    const token = bedrock_bearer_token || config.provider?.bedrock_bearer_token

    if (!token) {
      res.json({ ok: false, error: 'No bearer token provided' })
      return
    }

    // Dynamic import to avoid pulling heavy dependency at module load
    const { default: AnthropicBedrock } = await import('@anthropic-ai/bedrock-sdk')
    // Must match the auth pattern in adapter-bedrock.ts: skipAuth + authToken for bearer tokens
    const client = new AnthropicBedrock({
      awsRegion: region,
      skipAuth: true,
      authToken: token,
    } as unknown as ConstructorParameters<typeof AnthropicBedrock>[0])

    const start = Date.now()
    await client.messages.create({
      model: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'hi' }],
    })
    const latencyMs = Date.now() - start

    res.json({ ok: true, latencyMs })
  } catch (err) {
    log.warn('test-connection failed', { error: (err as Error).message })
    res.json({ ok: false, error: (err as Error).message })
  }
})

// PUT /api/config
configRouter.put('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = req.body

    if (body.version !== undefined && body.version !== 1) {
      res.status(400).json({ error: 'version must be 1' })
      return
    }
    if (body.defaults !== undefined) {
      if (typeof body.defaults !== 'object' || body.defaults === null) {
        res.status(400).json({ error: 'defaults must be an object' })
        return
      }
      if (body.defaults.priority !== undefined && !VALID_PRIORITIES.includes(body.defaults.priority)) {
        res.status(400).json({ error: `defaults.priority must be one of: ${VALID_PRIORITIES.join(', ')}` })
        return
      }
    }

    await updateConfig(body)
    // Re-read merged config so the event carries the full picture
    const merged = await getConfig()
    bus.emit(EventNames.CONFIG_CHANGED, { config: merged }, ['web-ui', 'main-agent', 'heartbeat-config'], { source: 'api' })
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})
