/**
 * "Import from Claude Code" points pi at the gateway Claude Code uses (src/core/agents/pi-gateway.ts):
 * when Claude Code names ANTHROPIC_BEDROCK_BASE_URL (Bedrock) or ANTHROPIC_BASE_URL (Anthropic),
 * pi gets Walnut's own `claude-code-gateway` provider in models.json and starts on it, so no
 * pi turn reaches the cloud provider behind the gateway directly. Real functions over an
 * in-memory host; nothing here reads the machine's files.
 */
import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { loadClaudeCodeFiles, type ClaudeCodeReader } from '../../src/data/pi/walnut-claude-code.js'
import {
  applyClaudeCodeImport,
  piStartFromClaudeCode,
  previewClaudeCodeImport,
  type ImportTransport,
} from '../../src/core/agents/claude-code-import.js'
import { piGatewayEntry, PI_GATEWAY_PROVIDER } from '../../src/core/agents/pi-gateway.js'
import { gatewayChangeLine, importSummaryLine } from '../../web/src/components/settings/sections/claude-code-import-text.js'

const HOME = '/home/u'
const CC = '~/.claude/settings.json'
const MODELS = '~/.pi/agent/models.json'
const SETTINGS = '~/.pi/agent/settings.json'
const pi = { installed: true, version: '1.4.0', needsUpdateForMcp: false }
const json = (v: unknown): string => JSON.stringify(v)

function start(settings: unknown, processEnv: Record<string, string | undefined> = {}) {
  const text = json(settings)
  const reader: ClaudeCodeReader = {
    readText: (p) => (p === `${HOME}/.claude/settings.json` ? text : undefined),
    isDir: () => false, isFile: (p) => p === `${HOME}/.claude/settings.json`, listDir: () => [], realpath: (p) => p,
  }
  return piStartFromClaudeCode(loadClaudeCodeFiles(reader, HOME, processEnv), processEnv)
}

/** A host's files in memory, with the daemon's sha256-guarded write. */
function host(tree: Record<string, string>): ImportTransport & { tree: Record<string, string>; writes: string[] } {
  const sha = (v: string) => createHash('sha256').update(Buffer.from(v, 'utf8')).digest('hex')
  const writes: string[] = []
  return {
    tree, writes,
    readBytes: async (p) => (tree[p] === undefined ? null : Buffer.from(tree[p], 'utf8')),
    listDir: async (p) => {
      const names = Object.keys(tree).filter((k) => k.startsWith(p + '/')).map((k) => k.slice(p.length + 1).split('/')[0])
      if (names.length === 0) throw new Error('ENOENT')
      return [...new Set(names)]
    },
    writeAtomic: async (p, text, expected) => {
      if ((tree[p] === undefined ? 'absent' : sha(tree[p])) !== expected) throw new Error('fs.write refused (EMODIFIED)')
      tree[p] = text
      writes.push(p)
    },
  }
}

const bedrockGateway = {
  model: 'global.anthropic.claude-opus-5-5[1m]',
  env: {
    CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: 'us-west-2', AWS_BEARER_TOKEN_BEDROCK: 'tok-secret-value',
    ANTHROPIC_BEDROCK_BASE_URL: 'http://127.0.0.1:9000/',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'global.anthropic.claude-opus-5-5[1m]', ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: 'Opus 5.5',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'global.anthropic.claude-sonnet-5-5[1m]',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'global.anthropic.claude-haiku-5-5',
    ANTHROPIC_SMALL_FAST_MODEL: 'global.anthropic.claude-haiku-5-5',
    // Not carried: a gateway may not serve Claude Code's custom option on the Converse paths pi uses.
    ANTHROPIC_CUSTOM_MODEL_OPTION: 'example-custom-model', ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: 'Custom',
  },
}

describe('the start choice with a gateway', () => {
  it('Bedrock side: a Walnut provider at ANTHROPIC_BEDROCK_BASE_URL speaking the Bedrock runtime api, keyed by the variable, never its value', () => {
    const s = start(bedrockGateway)
    expect(s.provider).toBe(PI_GATEWAY_PROVIDER)
    expect(s.model).toBe('global.anthropic.claude-opus-5-5')
    expect(s.gateway).toMatchObject({ from: 'ANTHROPIC_BEDROCK_BASE_URL', api: 'bedrock-converse-stream', baseUrl: 'http://127.0.0.1:9000', apiKey: '$AWS_BEARER_TOKEN_BEDROCK', keyFrom: 'variable', authHeader: false })
    // The model ids Claude Code uses, in order, once each, with its names and its 1M variants.
    expect(s.gateway!.models).toEqual([
      { id: 'global.anthropic.claude-opus-5-5', name: 'Opus 5.5', contextWindow: 1_000_000 },
      { id: 'global.anthropic.claude-sonnet-5-5', contextWindow: 1_000_000 },
      { id: 'global.anthropic.claude-haiku-5-5', contextWindow: 200_000 },
    ])
    const entry = piGatewayEntry(s.gateway!)
    expect(entry).toMatchObject({ baseUrl: 'http://127.0.0.1:9000', api: 'bedrock-converse-stream', apiKey: '$AWS_BEARER_TOKEN_BEDROCK' })
    expect((entry.models as Array<Record<string, unknown>>)[0]).toEqual({ id: 'global.anthropic.claude-opus-5-5', name: 'Opus 5.5', reasoning: true, input: ['text', 'image'], contextWindow: 1_000_000, maxTokens: 32_000 })
    expect(JSON.stringify(entry)).not.toContain('tok-secret-value')
  })

  it('a gateway URL from the host environment counts as Claude Code\'s, as Claude Code reads it there too', () => {
    const s = start({ env: { CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_DEFAULT_SONNET_MODEL: 'us.anthropic.claude-sonnet-5-5' } }, { ANTHROPIC_BEDROCK_BASE_URL: 'https://gw.example.com/bedrock' })
    expect(s.provider).toBe(PI_GATEWAY_PROVIDER)
    expect(s.gateway!.baseUrl).toBe('https://gw.example.com/bedrock')
  })

  it('Bedrock side with CLAUDE_CODE_SKIP_BEDROCK_AUTH: a placeholder key and nothing signed', () => {
    const s = start({ model: 'opus', env: { CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_SKIP_BEDROCK_AUTH: '1', AWS_BEARER_TOKEN_BEDROCK: 'tok', ANTHROPIC_BEDROCK_BASE_URL: 'https://gw.example.com', ANTHROPIC_DEFAULT_OPUS_MODEL: 'us.anthropic.claude-opus-5-5' } })
    expect(s.model).toBe('us.anthropic.claude-opus-5-5')
    expect(s.gateway).toMatchObject({ apiKey: 'claude-code-gateway', keyFrom: 'skip-auth' })
  })

  it('Anthropic side: a Walnut provider at ANTHROPIC_BASE_URL speaking Anthropic messages, adaptive thinking said for current Claude models', () => {
    const s = start({ model: 'claude-opus-5-5', env: { ANTHROPIC_BASE_URL: 'https://llm.example.com', ANTHROPIC_API_KEY: 'sk-test-value', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-3-5-haiku-latest' } })
    expect(s.provider).toBe(PI_GATEWAY_PROVIDER)
    expect(s.gateway).toMatchObject({ from: 'ANTHROPIC_BASE_URL', api: 'anthropic-messages', baseUrl: 'https://llm.example.com', apiKey: '$ANTHROPIC_API_KEY', authHeader: false })
    const models = piGatewayEntry(s.gateway!).models as Array<Record<string, unknown>>
    expect(models.map((m) => [m.id, m.compat])).toEqual([
      ['claude-opus-5-5', { forceAdaptiveThinking: true }],
      ['claude-3-5-haiku-latest', undefined],
    ])
    expect(JSON.stringify(piGatewayEntry(s.gateway!))).not.toContain('sk-test-value')
  })

  it('Anthropic side with an auth token sends it as a bearer header too, as Claude Code does', () => {
    const s = start({ env: { ANTHROPIC_BASE_URL: 'https://llm.example.com/', ANTHROPIC_AUTH_TOKEN: 'tok', ANTHROPIC_MODEL: 'claude-sonnet-5-5' } })
    expect(s.gateway).toMatchObject({ baseUrl: 'https://llm.example.com', apiKey: '$ANTHROPIC_AUTH_TOKEN', authHeader: true })
    expect(piGatewayEntry(s.gateway!).authHeader).toBe(true)
  })

  it('with no model named, pi starts on Claude Code\'s Sonnet id', () => {
    const s = start({ env: { CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_BEDROCK_BASE_URL: 'https://gw.example.com', ANTHROPIC_DEFAULT_OPUS_MODEL: 'a.opus', ANTHROPIC_DEFAULT_SONNET_MODEL: 'a.sonnet[1m]' } })
    expect(s.model).toBe('a.sonnet')
    expect(s.gateway!.models.map((m) => m.id)).toEqual(['a.opus', 'a.sonnet'])
  })

  it('a gateway with no model id, or one that is not a web address, leaves the provider alone and says why', () => {
    const none = start({ env: { CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_BEDROCK_BASE_URL: 'https://gw.example.com' } })
    expect(none.provider).toBeUndefined()
    expect(none.gateway).toBeUndefined()
    expect(none.notes[0]).toMatch(/names no model id/)
    const bad = start({ model: 'm', env: { ANTHROPIC_BASE_URL: 'gw.example.com' } })
    expect(bad.provider).toBeUndefined()
    expect(bad.notes[0]).toMatch(/not an http or https address/)
  })

  it('no base URL set: the built-in providers, exactly as before', () => {
    expect(start({ model: 'global.anthropic.claude-opus-5-5[1m]', env: { CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_DEFAULT_SONNET_MODEL: 'x' } }))
      .toEqual({ provider: 'amazon-bedrock', model: 'global.anthropic.claude-opus-5-5', notes: [] })
    expect(start({ model: 'claude-opus-5-5', env: { ANTHROPIC_API_KEY: 'k' } })).toEqual({ provider: 'anthropic', model: 'claude-opus-5-5', notes: [] })
    // ANTHROPIC_BASE_URL means nothing to Claude Code on Bedrock, so it means nothing to pi either.
    expect(start({ model: 'm', env: { CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_BASE_URL: 'https://llm.example.com' } }).provider).toBe('amazon-bedrock')
  })
})

describe('preview and apply with a gateway', () => {
  const userProviders = {
    $schema: 'https://pi.dev/schemas/models.schema.json',
    providers: {
      'my-proxy': { baseUrl: 'http://127.0.0.1:9000', api: 'anthropic-messages', apiKey: 'local', models: [{ id: 'claude-opus-5' }] },
      anthropic: { baseUrl: 'https://proxy.example.com' },
    },
  }
  const tree = () => ({
    [CC]: json(bedrockGateway),
    [MODELS]: JSON.stringify(userProviders, null, 2) + '\n',
    [SETTINGS]: json({ defaultProvider: 'amazon-bedrock', defaultModel: 'global.anthropic.claude-opus-5-5' }),
  })

  it('names the gateway change in plain words, with no secret value', async () => {
    const preview = await previewClaudeCodeImport('h', host(tree()), pi)
    expect(preview.gateway).toEqual({
      path: MODELS, provider: 'claude-code-gateway', from: 'ANTHROPIC_BEDROCK_BASE_URL', api: 'bedrock-converse-stream',
      baseUrl: 'http://127.0.0.1:9000', change: 'add',
      modelIds: ['global.anthropic.claude-opus-5-5', 'global.anthropic.claude-sonnet-5-5', 'global.anthropic.claude-haiku-5-5'],
    })
    expect(preview.settings.changes).toContainEqual({ key: 'defaultProvider', from: 'amazon-bedrock', to: 'claude-code-gateway' })
    expect(preview.credentials.note).toContain('through your gateway at http://127.0.0.1:9000')
    expect(preview.credentials.note).toContain('AWS_BEARER_TOKEN_BEDROCK')
    expect(preview.cannotCarry.map((c) => c.what)).not.toContain('AWS request signing to the gateway')
    expect(JSON.stringify(preview)).not.toContain('tok-secret-value')
    const line = gatewayChangeLine(preview as never, 'Pi')
    expect(line).toBe('Adds the provider claude-code-gateway to ~/.pi/agent/models.json: it sends Amazon Bedrock requests to your gateway at http://127.0.0.1:9000, as Claude Code does (ANTHROPIC_BEDROCK_BASE_URL), with 3 models (global.anthropic.claude-opus-5-5, global.anthropic.claude-sonnet-5-5, global.anthropic.claude-haiku-5-5). Pi starts on it, so no request goes to the cloud provider directly. Other providers in the file stay as they are.')
    expect(importSummaryLine(preview as never, 'Pi')).toMatch(/^Pi gets Amazon Bedrock credentials through your gateway at http:\/\/127\.0\.0\.1:9000, /)
  })

  it('writes Walnut\'s entry beside the user\'s providers (theirs kept byte for byte in meaning), then is idempotent', async () => {
    const t = host(tree())
    const result = await applyClaudeCodeImport('h', t, pi)
    expect(result.written).toEqual(['~/.pi/agent/extensions/walnut-claude-code.ts', MODELS, SETTINGS])
    const models = JSON.parse(t.tree[MODELS])
    expect(models.$schema).toBe(userProviders.$schema)
    expect(models.providers['my-proxy']).toEqual(userProviders.providers['my-proxy'])
    expect(models.providers.anthropic).toEqual(userProviders.providers.anthropic)
    expect(models.providers['claude-code-gateway']).toMatchObject({ baseUrl: 'http://127.0.0.1:9000', api: 'bedrock-converse-stream', apiKey: '$AWS_BEARER_TOKEN_BEDROCK' })
    expect(t.tree[MODELS]).toMatch(/^\{\n {2}"\$schema"/)
    expect(t.tree[MODELS].endsWith('\n')).toBe(true)
    expect(JSON.parse(t.tree[SETTINGS]).defaultProvider).toBe('claude-code-gateway')
    expect(result.preview.gateway?.change).toBe('none')
    expect(result.preview.upToDate).toBe(true)

    const again = await applyClaudeCodeImport('h', t, pi)
    expect(again.written).toEqual([])
    expect(t.writes.filter((w) => w === MODELS)).toHaveLength(1)
  })

  it('a re-import after Claude Code moved its gateway updates only Walnut\'s entry', async () => {
    const t = host(tree())
    await applyClaudeCodeImport('h', t, pi)
    const moved = { ...bedrockGateway, env: { ...bedrockGateway.env, ANTHROPIC_BEDROCK_BASE_URL: 'https://gw2.example.com' } }
    t.tree[CC] = json(moved)
    expect((await previewClaudeCodeImport('h', t, pi)).gateway?.change).toBe('update')
    const result = await applyClaudeCodeImport('h', t, pi)
    expect(result.written).toEqual([MODELS])
    const models = JSON.parse(t.tree[MODELS])
    expect(models.providers['claude-code-gateway'].baseUrl).toBe('https://gw2.example.com')
    expect(models.providers['my-proxy']).toEqual(userProviders.providers['my-proxy'])
  })

  it('creates models.json when pi has none', async () => {
    const t = host({ [CC]: json(bedrockGateway) })
    const result = await applyClaudeCodeImport('h', t, pi)
    expect(result.written).toContain(MODELS)
    expect(Object.keys(JSON.parse(t.tree[MODELS]).providers)).toEqual(['claude-code-gateway'])
  })

  it('refuses a models.json it cannot read, writing nothing', async () => {
    for (const bad of ['{ not json', json({ providers: [] })]) {
      const t = host({ ...tree(), [MODELS]: bad })
      const preview = await previewClaudeCodeImport('h', t, pi)
      expect(preview.gateway?.unreadable).toBeTruthy()
      expect(preview.upToDate).toBe(false)
      await expect(applyClaudeCodeImport('h', t, pi)).rejects.toMatchObject({ status: 409 })
      expect(t.writes).toEqual([])
      expect(t.tree[MODELS]).toBe(bad)
    }
  })

  it('no gateway: models.json is neither read for a change nor written', async () => {
    const t = host({ [CC]: json({ model: 'global.anthropic.claude-opus-5-5', env: { CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: 'us-west-2' } }), [MODELS]: json(userProviders) })
    const preview = await previewClaudeCodeImport('h', t, pi)
    expect(preview.gateway).toBeNull()
    expect(preview.settings.changes).toContainEqual({ key: 'defaultProvider', from: undefined, to: 'amazon-bedrock' })
    expect(gatewayChangeLine(preview as never, 'Pi')).toBe('')
    const result = await applyClaudeCodeImport('h', t, pi)
    expect(result.written).not.toContain(MODELS)
    expect(t.tree[MODELS]).toBe(json(userProviders))
  })
})
