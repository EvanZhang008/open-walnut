/**
 * Config routes — read/write application configuration.
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { getConfig, updateConfig } from '../../core/config-manager.js'
import { bus, EventNames } from '../../core/event-bus.js'
import { VALID_PRIORITIES } from '../../core/types.js'
import { log } from '../../logging/index.js'
import { buildProviderMap, resolveProvider, type ProviderConfig } from '../../agent/providers/index.js'
import { autoDetectApiKey } from '../../agent/providers/secret.js'

export const configRouter = Router()

// GET /api/config
configRouter.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const config = await getConfig()
    // Include env var bearer token hint so the UI can show it without a test call
    const envBearerToken = process.env.AWS_BEARER_TOKEN_BEDROCK
    // Only show env hint if no token is configured in either legacy or new-style config
    const hasConfigToken = !!(config.provider?.bedrock_bearer_token || config.providers?.bedrock?.bearer_token)
    const envTokenHint = !hasConfigToken && envBearerToken
      ? envBearerToken.slice(0, 8) + '••••••••' + envBearerToken.slice(-4)
      : undefined
    res.json({ config, envTokenHint })
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
    const token = bedrock_bearer_token
      || config.provider?.bedrock_bearer_token
      || config.providers?.bedrock?.bearer_token
      || process.env.AWS_BEARER_TOKEN_BEDROCK

    if (!token) {
      res.json({ ok: false, error: 'No bearer token configured (set in config or AWS_BEARER_TOKEN_BEDROCK env var)' })
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

    // If token came from env (not config or request body), send a masked hint so UI can display it
    const fromEnv = !bedrock_bearer_token && !config.provider?.bedrock_bearer_token && !config.providers?.bedrock?.bearer_token
    const envTokenHint = fromEnv && token ? token.slice(0, 8) + '••••••••' + token.slice(-4) : undefined

    res.json({ ok: true, latencyMs, envTokenHint })
  } catch (err) {
    log.warn('test-connection failed', { error: (err as Error).message })
    res.json({ ok: false, error: (err as Error).message })
  }
})

// GET /api/config/providers — list all providers with status
configRouter.get('/providers', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const config = await getConfig()
    const merged = buildProviderMap(config.providers)

    // Determine which providers are auto-detected vs explicit
    const explicitNames = new Set(Object.keys(config.providers ?? {}))

    const providers: Record<string, {
      api: string
      base_url?: string
      status: 'ready' | 'no_key' | 'not_implemented'
      key_hint?: string  // last 4 chars of resolved key
      auto_detected: boolean
    }> = {}

    for (const [name, prov] of Object.entries(merged)) {
      // Try to resolve the key from env
      const envKey = autoDetectApiKey(name)
      const hasKey = !!(prov.api_key || prov.bearer_token || envKey)

      // Some protocols don't need a key
      const keyNotRequired = prov.api === 'bedrock' || prov.api === 'ollama'

      // Check if adapter is implemented
      const implemented = prov.api === 'bedrock' || prov.api === 'anthropic-messages'

      // Mask key: show last 4 chars
      const rawKey = prov.api_key || prov.bearer_token || envKey
      const keyHint = rawKey && rawKey.length > 4 ? `...${rawKey.slice(-4)}` : undefined

      providers[name] = {
        api: prov.api,
        base_url: prov.base_url,
        status: !implemented ? 'not_implemented' : (hasKey || keyNotRequired) ? 'ready' : 'no_key',
        key_hint: keyHint,
        auto_detected: !explicitNames.has(name),
      }
    }

    res.json({ providers })
  } catch (err) {
    next(err)
  }
})

// POST /api/config/test-provider — test a specific provider connection
configRouter.post('/test-provider', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { provider_name, provider_config } = req.body as {
      provider_name: string
      provider_config?: ProviderConfig
    }

    if (!provider_name) {
      res.status(400).json({ ok: false, error: 'provider_name is required' })
      return
    }

    // Build the full provider map, overlay test config if provided
    const config = await getConfig()
    const providers = buildProviderMap(config.providers)
    if (provider_config) {
      providers[provider_name] = provider_config
    }

    if (!providers[provider_name]) {
      res.json({ ok: false, error: `Provider "${provider_name}" not found` })
      return
    }

    const { adapter, config: resolvedConfig } = resolveProvider(provider_name, providers)

    // Build a minimal test request
    const protocol = resolvedConfig.api
    let testModel: string
    switch (protocol) {
      case 'bedrock':
        testModel = 'us.anthropic.claude-haiku-4-5-20251001-v1:0'
        break
      case 'anthropic-messages':
        testModel = 'claude-haiku-4-5-20251001'
        break
      default:
        res.json({ ok: false, error: `Testing not yet supported for protocol "${protocol}"` })
        return
    }

    const start = Date.now()
    await adapter.sendMessage({
      providerConfig: resolvedConfig,
      model: testModel,
      maxTokens: 1,
      system: 'Respond with OK.',
      messages: [{ role: 'user', content: 'test' }],
    })
    const latencyMs = Date.now() - start

    res.json({ ok: true, latencyMs })
  } catch (err) {
    log.web.warn('test-provider failed', { error: (err as Error).message })
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
