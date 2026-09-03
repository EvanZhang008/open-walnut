/**
 * Config routes — read/write application configuration.
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { getConfig, updateConfig } from '../../core/config-manager.js'
import { CLOUD_MODE, WALNUT_INSTALL_DIR, NOTES_DIR } from '../../constants.js'
import { bus, EventNames } from '../../core/event-bus.js'
import { VALID_PRIORITIES } from '../../core/types.js'
import { log } from '../../logging/index.js'
import { buildProviderMap, resolveProvider, type ProviderConfig } from '../../agent/providers/index.js'
import { autoDetectApiKey } from '../../agent/providers/secret.js'
import { getModelsForProvider } from '../../agent/providers/model-catalog.js'
import { KNOWN_PROVIDERS, DEFAULT_BASE_URLS } from '../../agent/providers/defaults.js'
import type { ModelEntry } from '../../agent/providers/types.js'

export const configRouter = Router()

/**
 * Whether the built web app is still on disk where this server serves it from.
 * Registered by the server (which owns the resolved static dir) so /api/config
 * can report it: a deploy boots from a staged copy under TMPDIR, and that copy
 * has been deleted under a live server before (2026-09-02) — the API stayed
 * green while every asset 404ed. Undefined in dev / when static serving is off.
 */
let staticRootReporter: (() => { staticDir: string; ok: boolean; mirrorDir?: string; mirrorReady?: boolean }) | null = null

export function setStaticRootReporter(fn: () => { staticDir: string; ok: boolean; mirrorDir?: string; mirrorReady?: boolean }): void {
  staticRootReporter = fn
}

// Secret masking lives in core so the bug-report bundler can reuse it.
// CLOUD-mode rationale: config.yaml is git-synced to the public box, and
// `GET /api/config` is reachable by ANY paired device — returning plaintext
// provider keys / bearer tokens there would hand a phone token holder the
// Bedrock credentials. On the trusted-LAN Mac it stays unmasked.
import { redactConfig } from '../../core/config-redact.js'

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
    // installDir: Walnut's own source checkout (null on npm installs / cloud
    // bundles) — drives the "Fix Walnut" quick-start button. Cloud replicas
    // proxy sessions to daemons elsewhere, so a local path would be wrong there.
    // notesDir: the vault root — cwd for "Start Claude Code session" launched
    // from the /notes page. Local-only for the same reason as installDir.
    // processNice: >0 means the server inherited a positive nice (launched from
    // a niced shell) and will be scheduler-starved under load — surfaced so
    // fix-walnut / bug reports can spot it without shell access.
    let processNice = 0
    try { processNice = (await import('node:os')).getPriority() } catch { /* diagnostics only */ }
    // memory: same purpose as processNice — a diagnostic a bug report can carry
    // without shell access. Unbounded whole-file JSONL reads drove RSS to ~3 GB
    // within minutes and ended in V8 OOM aborts; those reads are gone, but the
    // symptom was invisible from the UI, so the number is now always available.
    // uptimeSec is the denominator that makes it meaningful (2 GB after a week is
    // ordinary; 2 GB after five minutes is the bug).
    const mem = process.memoryUsage()
    const memory = {
      rssMb: Math.round(mem.rss / 1048576),
      heapUsedMb: Math.round(mem.heapUsed / 1048576),
      heapTotalMb: Math.round(mem.heapTotal / 1048576),
      externalMb: Math.round(mem.external / 1048576),
      uptimeSec: Math.round(process.uptime()),
    }
    // canRevealLocalFiles: whether POST /api/files/reveal can hand a path to the
    // desktop (`open`) — macOS console only, never a cloud replica. The UI hides
    // its "Reveal in Finder / Open in default app" items when false instead of
    // offering menu entries that always 400.
    const canRevealLocalFiles = !CLOUD_MODE && process.platform === 'darwin'
    // remoteIdUniquenessGaps: non-empty means a sync plugin's remote-id UNIQUE
    // index could NOT be opened because the tasks table already holds two rows
    // owning one remote id. That is the task-forking bug's footprint, and the
    // constraint is the guarantee against it — so a degraded state is reported
    // here rather than being silently tolerated. Empty = enforced by the DB.
    let remoteIdUniquenessGaps: ReadonlyArray<{ source: string; path: string; groups: number }> = []
    try {
      const { getExtIndexUniquenessGaps } = await import('../../core/task-db.js')
      remoteIdUniquenessGaps = getExtIndexUniquenessGaps()
    } catch { /* diagnostics only */ }
    // webAssets: reported only when this process serves them (production), so a
    // client or monitor can tell "the app is broken" from "the app is slow".
    const webAssets = staticRootReporter?.() ?? null
    res.json({ config: CLOUD_MODE ? redactConfig(config) : config, envTokenHint, installDir: CLOUD_MODE ? null : WALNUT_INSTALL_DIR, notesDir: CLOUD_MODE ? null : NOTES_DIR, processNice, memory, canRevealLocalFiles, remoteIdUniquenessGaps, cloud: CLOUD_MODE, webAssets })
  } catch (err) {
    next(err)
  }
})

// POST /api/config/test-connection — test Bedrock connection with any auth method
configRouter.post('/test-connection', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { bedrock_region, bedrock_bearer_token, bedrock_access_key, bedrock_secret_key, bedrock_profile, bedrock_credential_export } = req.body
    const config = await getConfig()
    const region = bedrock_region || config.provider?.bedrock_region || config.providers?.bedrock?.region || 'us-west-2'

    const { default: AnthropicBedrock } = await import('@anthropic-ai/bedrock-sdk')
    let client: InstanceType<typeof AnthropicBedrock>
    let authMethod = 'auto'

    // Priority: explicit request params → config → env → auto-detect
    const token = bedrock_bearer_token
      || config.provider?.bedrock_bearer_token
      || config.providers?.bedrock?.bearer_token
      || process.env.AWS_BEARER_TOKEN_BEDROCK
    const accessKey = bedrock_access_key || config.providers?.bedrock?.aws_access_key_id
    const secretKey = bedrock_secret_key || config.providers?.bedrock?.aws_secret_access_key
    const profile = bedrock_profile || config.providers?.bedrock?.aws_profile
    const credentialExport = bedrock_credential_export || config.providers?.bedrock?.aws_credential_export

    if (bedrock_credential_export || (!bedrock_bearer_token && !bedrock_access_key && !bedrock_profile && credentialExport)) {
      // Credential-process command → temp creds
      const { runCredentialProcess } = await import('../../core/aws-credential-process.js')
      const creds = await runCredentialProcess(credentialExport)
      client = new AnthropicBedrock({
        awsRegion: region,
        awsAccessKey: creds.accessKeyId,
        awsSecretKey: creds.secretAccessKey,
        ...(creds.sessionToken && { awsSessionToken: creds.sessionToken }),
      } as unknown as ConstructorParameters<typeof AnthropicBedrock>[0])
      authMethod = 'credential_process'
    } else if (bedrock_bearer_token || (!bedrock_access_key && !bedrock_profile && token)) {
      // Bearer token auth
      client = new AnthropicBedrock({
        awsRegion: region,
        skipAuth: true,
        authToken: token,
      } as unknown as ConstructorParameters<typeof AnthropicBedrock>[0])
      authMethod = 'bearer_token'
    } else if (bedrock_access_key && bedrock_secret_key) {
      // Explicit access keys from request
      client = new AnthropicBedrock({ awsRegion: region, awsAccessKey: bedrock_access_key, awsSecretKey: bedrock_secret_key })
      authMethod = 'access_keys'
    } else if (accessKey && secretKey) {
      // Access keys from config
      client = new AnthropicBedrock({ awsRegion: region, awsAccessKey: accessKey, awsSecretKey: secretKey })
      authMethod = 'access_keys'
    } else if (bedrock_profile || profile) {
      // AWS profile
      const profileName = bedrock_profile || profile
      client = new AnthropicBedrock({
        awsRegion: region,
        providerChainResolver: () =>
          import('@aws-sdk/credential-providers').then(({ fromNodeProviderChain }) =>
            fromNodeProviderChain({ profile: profileName }),
          ),
      } as unknown as ConstructorParameters<typeof AnthropicBedrock>[0])
      authMethod = 'profile'
    } else {
      // Auto-detect (default credential chain)
      client = new AnthropicBedrock({ awsRegion: region })
      authMethod = 'auto'
    }

    const start = Date.now()
    await client.messages.create({
      model: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'hi' }],
    })
    const latencyMs = Date.now() - start

    res.json({ ok: true, latencyMs, authMethod })
  } catch (err) {
    log.web.warn('test-connection failed', { error: (err as Error).message })
    res.json({ ok: false, error: (err as Error).message })
  }
})

// GET /api/config/aws-profiles — list AWS profiles from ~/.aws/config + ~/.aws/credentials
configRouter.get('/aws-profiles', async (_req: Request, res: Response) => {
  try {
    const { readFileSync, existsSync } = await import('fs')
    const { homedir } = await import('os')
    const { join } = await import('path')
    const home = homedir()
    const profiles = new Set<string>()

    // Parse profile names from INI-style files
    const parseProfiles = (filePath: string, configStyle: boolean) => {
      if (!existsSync(filePath)) return
      const content = readFileSync(filePath, 'utf-8')
      for (const line of content.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) continue
        let name = trimmed.slice(1, -1).trim()
        // ~/.aws/config uses [profile foo], ~/.aws/credentials uses [foo]
        if (configStyle && name.startsWith('profile ')) name = name.slice(8).trim()
        if (name === 'default' || name.length > 0) profiles.add(name)
      }
    }

    parseProfiles(join(home, '.aws', 'credentials'), false)
    parseProfiles(join(home, '.aws', 'config'), true)

    res.json({ profiles: [...profiles].sort() })
  } catch {
    res.json({ profiles: [] })
  }
})

// GET /api/config/credential-trace — step-by-step Bedrock credential resolution.
// Shows every layer the resolver reads (Walnut config vs Claude Code settings vs
// shell env vs ~/.aws), what it looked for, and which layer won. `?verify=1`
// additionally exercises the winning credential with STS GetCallerIdentity so
// an expired ~/.aws cache can't masquerade as "ready" (secrets never leave the
// box — trace values are masked, verify returns only the ARN/account/expiry).
configRouter.get('/credential-trace', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const config = await getConfig()
    const {
      traceCredentialResolution, resolveCredentials,
      readClaudeSettingsEnv, readClaudeCredentialExport,
    } = await import('../../core/credential-resolver.js')
    const fs = await import('node:fs')
    const os = await import('node:os')
    const path = await import('node:path')
    const home = os.homedir()
    const exists = (p: string) => { try { return fs.existsSync(p) } catch { return false } }

    const trace = traceCredentialResolution({
      config,
      claudeEnv: readClaudeSettingsEnv(),
      processEnv: process.env,
      awsFiles: {
        credentials: exists(path.join(home, '.aws', 'credentials')),
        config: exists(path.join(home, '.aws', 'config')),
      },
      claudeCredentialExport: readClaudeCredentialExport(),
    })

    if (req.query.verify === '1') {
      const { verifyResolvedCredential } = await import('../../core/credential-verify.js')
      const verify = await verifyResolvedCredential(resolveCredentials(config))
      res.json({ trace, verify })
      return
    }
    res.json({ trace })
  } catch (err) {
    next(err)
  }
})

/** Cached Ollama model list — refreshed at most once per 30s. */
let _ollamaCache: { models: ModelEntry[]; ts: number } = { models: [], ts: 0 }
// 30s balances model freshness after `ollama pull` vs avoiding repeated /api/tags I/O on every settings page load.
const OLLAMA_CACHE_TTL = 30_000

/** Fetch installed models from a running Ollama server. Cached for 30s. Returns [] on any error. */
async function fetchOllamaModels(baseUrl?: string): Promise<ModelEntry[]> {
  if (Date.now() - _ollamaCache.ts < OLLAMA_CACHE_TTL) return _ollamaCache.models
  const url = (baseUrl ?? DEFAULT_BASE_URLS['ollama'] ?? 'http://localhost:11434') + '/api/tags'
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(2000) })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const data = await resp.json() as { models?: { name: string; size?: number; modified_at?: string }[] }
    if (!Array.isArray(data.models)) throw new Error('Unexpected response: models is not an array')
    const models = data.models.map(m => ({
      id: m.name,
      provider: 'ollama' as const,
      label: m.name,
    }))
    _ollamaCache = { models, ts: Date.now() }
    return models
  } catch (err) {
    log.web.warn('fetchOllamaModels failed', { url, error: (err as Error).message })
    _ollamaCache = { models: [], ts: Date.now() }
    return []
  }
}

/**
 * Build the providers status payload (shared by GET /api/config/providers and
 * the /api/v1 read — v1 strips `key_hint` before serving).
 */
export async function buildProvidersPayload(): Promise<{
  providers: Record<string, {
    api: string
    base_url?: string
    status: 'ready' | 'no_key' | 'not_implemented'
    key_hint?: string
    auto_detected: boolean
    models: ModelEntry[]
    credential_source?: string
    credential_detail?: string
  }>
}> {
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
      models: import('../../agent/providers/types.js').ModelEntry[]
      credential_source?: string  // bedrock: 'bearer_token' | 'api_key' | 'aws_credentials_file'
      credential_detail?: string  // claude-cli: how the CLI signs in, e.g. "Bedrock (us-west-2)"
    }> = {}

    for (const [name, prov] of Object.entries(merged)) {
      // Ollama models are runtime-discovered from /api/tags (empty code catalog).
      // Merge dynamic results with user config overrides.
      if (prov.api === 'ollama') {
        const dynamicModels = await fetchOllamaModels(prov.base_url)
        const isReachable = dynamicModels.length > 0
        // Dynamic models as base, user config overrides on top (same-ID wins)
        const userOverrides = prov.models ?? []
        const ollamaModels: ModelEntry[] = [...dynamicModels]
        for (const override of userOverrides) {
          const idx = ollamaModels.findIndex(m => m.id === override.id)
          if (idx >= 0) ollamaModels[idx] = { ...ollamaModels[idx], ...override }
          else ollamaModels.push({ ...override, provider: 'ollama' })
        }
        providers[name] = {
          api: prov.api,
          base_url: prov.base_url,
          status: isReachable ? 'ready' : 'no_key',
          auto_detected: !explicitNames.has(name),
          models: ollamaModels,
        }
        continue
      }

      // claude-cli is keyless: "ready" means the local CLI is installed. Its login
      // (Bedrock, subscription, a key) is the CLI's own; we only name the mode.
      if (prov.api === 'claude-cli') {
        const { detectClaudeCli } = await import('../../core/claude-cli-detect.js')
        const caps = detectClaudeCli()
        providers[name] = {
          api: prov.api,
          base_url: prov.base_url,
          status: caps.installed ? 'ready' : 'no_key',
          auto_detected: !explicitNames.has(name),
          models: getModelsForProvider(name, prov.models),
          credential_source: caps.installed ? `cli_${caps.auth.mode}` : 'cli_not_installed',
          credential_detail: caps.installed ? caps.auth.label : undefined,
        }
        continue
      }

      // Try to resolve the key from env
      const envKey = autoDetectApiKey(name)
      let hasKey = !!(prov.api_key || prov.bearer_token || envKey
        || prov.aws_access_key_id || prov.aws_profile || prov.aws_credential_export)

      // For Bedrock: check the full AWS credential chain when no explicit key is found
      let awsCredentialSource: 'env' | 'credentials_file' | 'config_file' | undefined
      if (prov.api === 'bedrock' && !hasKey) {
        // AWS_ACCESS_KEY_ID env var (standard AWS SDK credential chain)
        if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
          awsCredentialSource = 'env'
          hasKey = true
        }
        if (!hasKey) {
          try {
            const { existsSync } = await import('fs')
            const { homedir } = await import('os')
            const home = homedir()
            if (existsSync(`${home}/.aws/credentials`)) {
              awsCredentialSource = 'credentials_file'
              hasKey = true
            } else if (existsSync(`${home}/.aws/config`)) {
              // May contain SSO profiles or credential_process
              awsCredentialSource = 'config_file'
              hasKey = true
            }
          } catch { /* ignore */ }
        }
      }

      // Must match adapter implementations in registry.ts getOrCreateAdapter()
      const implemented = prov.api === 'bedrock' || prov.api === 'anthropic-messages'
        || prov.api === 'openai-chat' || prov.api === 'google-generative-ai'

      // Mask key: show last 4 chars
      const rawKey = prov.api_key || prov.bearer_token || envKey
      const keyHint = rawKey && rawKey.length > 4 ? `...${rawKey.slice(-4)}` : undefined

      // Build credential source label for Bedrock
      let credentialSource: string | undefined
      if (prov.api === 'bedrock' && hasKey) {
        if (prov.bearer_token) credentialSource = 'bearer_token'
        else if (prov.aws_access_key_id) credentialSource = 'access_keys'
        else if (prov.aws_profile) credentialSource = 'profile'
        else if (prov.aws_credential_export) credentialSource = 'credential_process'
        else if (envKey) credentialSource = 'env_api_key'
        else if (prov.api_key) credentialSource = 'api_key'
        else if (awsCredentialSource) credentialSource = `aws_${awsCredentialSource}`
      }

      providers[name] = {
        api: prov.api,
        base_url: prov.base_url,
        status: !implemented ? 'not_implemented' : hasKey ? 'ready' : 'no_key',
        key_hint: keyHint,
        auto_detected: !explicitNames.has(name),
        models: getModelsForProvider(name, prov.models),
        ...(credentialSource && { credential_source: credentialSource }),
      }
    }

    // Include catalog-only providers not in merged map so UI shows all known providers
    for (const name of Object.keys(KNOWN_PROVIDERS)) {
      if (!providers[name]) {
        const template = KNOWN_PROVIDERS[name]
        // claude-cli is keyless: the installed binary is the credential.
        if (template.api === 'claude-cli') {
          const { detectClaudeCli } = await import('../../core/claude-cli-detect.js')
          const caps = detectClaudeCli()
          providers[name] = {
            api: template.api,
            status: caps.installed ? 'ready' : 'no_key',
            auto_detected: false,
            models: getModelsForProvider(name),
            credential_source: caps.installed ? `cli_${caps.auth.mode}` : 'cli_not_installed',
            credential_detail: caps.installed ? caps.auth.label : undefined,
          }
          continue
        }
        providers[name] = {
          api: template.api,
          base_url: template.base_url,
          status: 'no_key',
          auto_detected: false,
          models: getModelsForProvider(name),
        }
      }
    }

    return { providers }
}

// GET /api/config/providers — list all providers with status
configRouter.get('/providers', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await buildProvidersPayload())
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

    // Build a minimal test request — pick a cheap model per protocol/provider
    const protocol = resolvedConfig.api
    let testModel: string
    const TEST_MODELS: Record<string, Record<string, string>> = {
      'bedrock': { '*': 'us.anthropic.claude-haiku-4-5-20251001-v1:0' },
      'anthropic-messages': { '*': 'claude-haiku-4-5-20251001' },
      'openai-chat': {
        'openai': 'gpt-4o-mini',
        'openrouter': 'nvidia/nemotron-3-nano-30b-a3b:free', // Uses :free model to test connectivity without requiring paid credits
        'deepseek': 'deepseek-chat',
        '*': 'gpt-4o-mini',
      },
      'google-generative-ai': { '*': 'gemini-3-flash-preview' },
      // claude-cli spawns the local `claude -p`; a short alias resolves to the
      // subscription's model. maxTokens is ignored by the CLI (it runs its own turn).
      'claude-cli': { '*': 'haiku' },
    }
    const protocolModels = TEST_MODELS[protocol]
    if (!protocolModels) {
      res.json({ ok: false, error: `Testing not yet supported for protocol "${protocol}"` })
      return
    }
    testModel = protocolModels[provider_name] ?? protocolModels['*']

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
    bus.emit(EventNames.CONFIG_CHANGED, { config: merged }, ['web-ui', 'main-agent', 'heartbeat-config', 'setup-health', 'plugin-config-reload'], { source: 'api' })
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})
