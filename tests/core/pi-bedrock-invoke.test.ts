/**
 * pi through Claude Code's Bedrock gateway makes Claude Code's call (src/data/pi/walnut-claude-code.ts):
 * 2026-11-24, every pi turn on a host whose gateway served only invoke failed with "not
 * converse-stream". The Anthropic SDK (the client pi's Anthropic stream drives) runs over the
 * fetch against a faked Bedrock invoke, so the wire both ways is checked; the gateway rule covers
 * every pi provider the import points at the gateway with the Converse api; and Walnut's older
 * copy of the extension on a host is brought up to date before a pi start, never anyone else's.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createHash } from 'node:crypto'
import Anthropic from '@anthropic-ai/sdk'
import {
  asInvokeModel,
  bedrockInvokeFetch,
  bedrockInvokeRequest,
  claudeCodeEnv,
  gatewayHeaders,
  gatewayProviders,
  gatewayRoute,
  invokeClientConfig,
  refusesConverse,
  WALNUT_CLAUDE_CODE_EXTENSION_VERSION,
  type BedrockInvoke,
  type ClaudeCodeFiles,
} from '../../src/data/pi/walnut-claude-code.js'
import { piGatewayEntry, piGatewayFromClaudeCode, PI_GATEWAY_PROVIDER } from '../../src/core/agents/pi-gateway.js'
import { readExtensionSource, type ImportTransport } from '../../src/core/agents/claude-code-import.js'
import { refreshPiExtension, refreshPiExtensionBeforeStart, refreshPlan, __resetPiExtensionRefresh } from '../../src/core/agents/pi-extension-refresh.js'

const GATEWAY = 'http://127.0.0.1:18402'

function files(env: Record<string, string>): ClaudeCodeFiles {
  return { home: '/home/u', claudeDir: '/home/u/.claude', settings: { env }, globalConfig: undefined, installedPlugins: undefined }
}

async function* events(list: Array<Record<string, unknown>>, failAfter?: Error): AsyncIterable<Record<string, unknown>> {
  for (const e of list) yield e
  if (failAfter) throw failAfter
}

const STREAM = [
  { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'm', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'PO' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'NG 中' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } },
  { type: 'message_stop' },
]

function client(invoke: BedrockInvoke): Anthropic {
  return new Anthropic({ apiKey: 'bedrock', baseURL: 'https://bedrock-invoke.invalid', fetch: bedrockInvokeFetch(invoke), maxRetries: 0 })
}

describe('the Bedrock invoke request', () => {
  it('is the Anthropic body with Bedrock\'s version and betas, minus model and stream', () => {
    expect(bedrockInvokeRequest({ model: 'global.openai.gpt-6.2-sol', stream: true, max_tokens: 9, messages: [] }, 'a-1, b-2')).toEqual({
      modelId: 'global.openai.gpt-6.2-sol', stream: true,
      body: { anthropic_version: 'bedrock-2023-05-31', max_tokens: 9, messages: [], anthropic_beta: ['a-1', 'b-2'] },
    })
    expect(bedrockInvokeRequest({ model: 'x', max_tokens: 1 }, null).body).toEqual({ anthropic_version: 'bedrock-2023-05-31', max_tokens: 1 })
  })
})

describe('the Anthropic client over Bedrock invoke', () => {
  it('streams a turn: text in order, usage, stop reason', async () => {
    const calls: Array<{ modelId: string; body: Record<string, unknown>; stream: boolean }> = []
    const c = client(async (modelId, body, stream) => { calls.push({ modelId, body, stream }); return { events: events(STREAM) } })
    const s = c.messages.stream({ model: 'global.anthropic.claude-opus-5-5', max_tokens: 50, messages: [{ role: 'user', content: 'hi' }] })
    const text: string[] = []
    s.on('text', (t) => text.push(t))
    const final = await s.finalMessage()
    expect(text.join('')).toBe('PONG 中')
    expect(final.stop_reason).toBe('end_turn')
    expect(final.usage.output_tokens).toBe(3)
    expect(calls).toEqual([{ modelId: 'global.anthropic.claude-opus-5-5', stream: true, body: expect.objectContaining({ anthropic_version: 'bedrock-2023-05-31', max_tokens: 50 }) }])
    expect(calls[0].body).not.toHaveProperty('model')
    expect(calls[0].body).not.toHaveProperty('stream')
  })

  it('answers a request that does not stream', async () => {
    const c = client(async (_m, _b, stream) => {
      expect(stream).toBe(false)
      return { json: { id: 'msg_2', type: 'message', role: 'assistant', model: 'm', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } }
    })
    const out = await c.messages.create({ model: 'm', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] })
    expect(out.content).toEqual([{ type: 'text', text: 'ok' }])
  })

  it('a refused call reaches pi with Bedrock\'s status and words', async () => {
    const refused = Object.assign(new Error('the bedrock door serves invoke, not converse-stream'), { name: 'UnknownOperationException', $metadata: { httpStatusCode: 400 } })
    const c = client(async () => { throw refused })
    const err = await c.messages.create({ model: 'm', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }], stream: true }).then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(Anthropic.APIError)
    expect((err as InstanceType<typeof Anthropic.APIError>).status).toBe(400)
    expect(String((err as Error).message)).toContain('UnknownOperationException')
    expect(String((err as Error).message)).toContain('not converse-stream')
  })

  it('a failure inside the stream ends the turn with that error', async () => {
    const c = client(async () => ({ events: events(STREAM.slice(0, 3), Object.assign(new Error('model stream broke'), { name: 'ModelStreamErrorException' })) }))
    const s = c.messages.stream({ model: 'm', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] })
    await expect(s.finalMessage()).rejects.toThrow(/model stream broke/)
  })
})

describe('which requests go through invoke', () => {
  it('pi\'s Bedrock endpoint set to Claude Code\'s gateway, and only then', () => {
    const cc = { CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_BEDROCK_BASE_URL: `${GATEWAY}/` }
    expect(claudeCodeEnv(files(cc), {}).gateway).toBe(GATEWAY)
    // The process already points pi elsewhere: that endpoint keeps pi's own client.
    expect(claudeCodeEnv(files(cc), { AWS_ENDPOINT_URL_BEDROCK_RUNTIME: 'https://vpc.example.com' }).gateway).toBeUndefined()
    expect(claudeCodeEnv(files(cc), { AWS_ENDPOINT_URL_BEDROCK_RUNTIME: GATEWAY }).gateway).toBe(GATEWAY)
    // Bedrock straight from AWS (no gateway), or no Bedrock at all.
    expect(claudeCodeEnv(files({ CLAUDE_CODE_USE_BEDROCK: '1' }), {}).gateway).toBeUndefined()
    expect(claudeCodeEnv(files({ ANTHROPIC_BEDROCK_BASE_URL: GATEWAY }), {}).gateway).toBeUndefined()
  })

  it('sends Claude Code\'s gateway headers, pi\'s own environment last', () => {
    expect(gatewayHeaders(files({ ANTHROPIC_CUSTOM_HEADERS: 'X-Relay-Host: box\nx-walnut-session: old' }), { ANTHROPIC_CUSTOM_HEADERS: 'x-walnut-session: t1\r\nbroken line' }))
      .toEqual({ 'x-relay-host': 'box', 'x-walnut-session': 't1' })
  })

  // The class: every provider the import points at the gateway with pi's Converse api. A new one
  // (or a renamed entry) must be listed in gatewayProviders, or its turns go out as Converse again.
  it('covers every Converse provider the import writes for the gateway', () => {
    const env = (k: string): string | undefined => ({ ANTHROPIC_BEDROCK_BASE_URL: GATEWAY, ANTHROPIC_DEFAULT_OPUS_MODEL: 'global.anthropic.claude-opus-5-5[1m]', CLAUDE_CODE_SKIP_BEDROCK_AUTH: '1' } as Record<string, string>)[k]
    const { gateway } = piGatewayFromClaudeCode(env, true, undefined)
    const modelsJson = { providers: { [PI_GATEWAY_PROVIDER]: piGatewayEntry(gateway!), mine: { api: 'bedrock-converse-stream', baseUrl: GATEWAY } } }
    const converse = Object.entries(modelsJson.providers).filter(([name, p]) => p.api === 'bedrock-converse-stream' && name !== 'mine').map(([name]) => name)
    expect(converse.length).toBeGreaterThan(0)
    const covered = gatewayProviders(modelsJson, GATEWAY)
    for (const name of ['amazon-bedrock', ...converse]) expect(covered).toContain(name)
    // A provider the user wrote is theirs; an entry naming another address is not the gateway.
    expect(covered).not.toContain('mine')
    expect(gatewayProviders({ providers: { [PI_GATEWAY_PROVIDER]: { ...piGatewayEntry(gateway!), baseUrl: 'https://other.example.com' } } }, GATEWAY)).toEqual(['amazon-bedrock'])
    expect(gatewayProviders(undefined, GATEWAY)).toEqual(['amazon-bedrock'])
  })

  it('a Bedrock model as the Anthropic stream takes it: adaptive thinking where Bedrock had it', () => {
    expect(asInvokeModel({ id: 'global.anthropic.claude-opus-5-5', compat: { a: 1 } })).toMatchObject({ api: 'anthropic-messages', compat: { a: 1, forceAdaptiveThinking: true } })
    expect(asInvokeModel({ id: 'global.openai.gpt-6.2-sol' }).compat).toBeUndefined()
  })
})

describe('which wire a turn takes, and the client that sends it', () => {
  it('asks the gateway once whether it serves Converse; an unknown answer is asked again', async () => {
    let asked = 0
    const served = gatewayRoute(async () => { asked++; return false })
    expect(await served()).toBe('invoke')
    expect(await served()).toBe('invoke')
    expect(asked).toBe(1)
    const answers: Array<boolean | undefined> = [undefined, true]
    const unsure = gatewayRoute(async () => answers.shift())
    // No answer (the gateway was down): pi's own Converse client, and the next turn asks again.
    expect(await unsure()).toBe('converse')
    expect(await unsure()).toBe('converse')
    expect(answers).toEqual([])
  })

  it('a refusal of Converse itself, never a bad request, sends turns through invoke', () => {
    expect(refusesConverse({ name: 'UnknownOperationException', $metadata: { httpStatusCode: 400 } })).toBe(true)
    expect(refusesConverse({ name: 'X', $metadata: { httpStatusCode: 404 } })).toBe(true)
    expect(refusesConverse({ name: 'X', message: 'the bedrock door serves invoke, not converse-stream' })).toBe(false)
    expect(refusesConverse({ name: 'X', message: 'this gateway does not serve converse-stream' })).toBe(true)
    expect(refusesConverse({ name: 'ValidationException', message: 'messages: at least one message is required', $metadata: { httpStatusCode: 400 } })).toBe(false)
    expect(refusesConverse({ name: 'AccessDeniedException', $metadata: { httpStatusCode: 403 } })).toBe(false)
  })

  it('the client is configured as pi configures its own Bedrock client', () => {
    // A region from the model's ARN wins; else the environment; else us-east-1 unless a profile names one.
    expect(invokeClientConfig(GATEWAY, 'arn:aws:bedrock:eu-west-1:example:inference-profile/x', {}, { AWS_REGION: 'us-west-2' })).toMatchObject({ endpoint: GATEWAY, region: 'eu-west-1' })
    expect(invokeClientConfig(GATEWAY, 'm', {}, { AWS_DEFAULT_REGION: 'us-west-2' }).region).toBe('us-west-2')
    expect(invokeClientConfig(GATEWAY, 'm', {}, {}).region).toBe('us-east-1')
    expect(invokeClientConfig(GATEWAY, 'm', {}, { AWS_PROFILE: 'p' })).toEqual({ endpoint: GATEWAY, profile: 'p' })
    // A gateway that signs nothing gets dummy keys and no bearer token.
    expect(invokeClientConfig(GATEWAY, 'm', { apiKey: 'k' }, { AWS_BEDROCK_SKIP_AUTH: '1' })).toEqual({
      endpoint: GATEWAY, region: 'us-east-1', credentials: { accessKeyId: 'dummy-access-key', secretAccessKey: 'dummy-secret-key' },
    })
    // Keys from the environment, unless pi's own profile was asked for; an empty value is no value.
    const keys = { AWS_ACCESS_KEY_ID: 'a', AWS_SECRET_ACCESS_KEY: 's', AWS_SESSION_TOKEN: '' }
    expect(invokeClientConfig(GATEWAY, 'm', {}, keys).credentials).toEqual({ accessKeyId: 'a', secretAccessKey: 's' })
    expect(invokeClientConfig(GATEWAY, 'm', { profile: 'mine' }, keys)).not.toHaveProperty('credentials')
    // pi's own bearer token first, then its API key, then the environment's.
    expect(invokeClientConfig(GATEWAY, 'm', { bearerToken: 'b', apiKey: 'k' }, { AWS_BEARER_TOKEN_BEDROCK: 'e' })).toMatchObject({ token: { token: 'b' }, authSchemePreference: ['httpBearerAuth'] })
    expect(invokeClientConfig(GATEWAY, 'm', {}, { AWS_BEARER_TOKEN_BEDROCK: 'e' }).token).toEqual({ token: 'e' })
  })
})

describe('Walnut\'s copy of the extension on a host', () => {
  const FILE = '~/.pi/agent/extensions/walnut-claude-code.ts'
  const sha = (v: string) => createHash('sha256').update(Buffer.from(v, 'utf8')).digest('hex')
  function host(tree: Record<string, string>): ImportTransport & { tree: Record<string, string>; writes: number } {
    const t = {
      tree, writes: 0,
      readBytes: async (p: string) => (tree[p] === undefined ? null : Buffer.from(tree[p], 'utf8')),
      listDir: async () => [],
      writeAtomic: async (p: string, text: string, expected: string) => {
        if ((tree[p] === undefined ? 'absent' : sha(tree[p])) !== expected) throw new Error('EMODIFIED')
        tree[p] = text
        t.writes++
      },
    }
    return t
  }
  const v = (n: number) => `export const WALNUT_CLAUDE_CODE_EXTENSION_VERSION = ${n}\n`
  beforeEach(() => __resetPiExtensionRefresh())

  it('an older copy is replaced by the shipped one; nothing else is written', async () => {
    const older = host({ [FILE]: v(WALNUT_CLAUDE_CODE_EXTENSION_VERSION - 1) })
    expect(await refreshPiExtension(older)).toBe('updated')
    expect(older.tree[FILE]).toBe(readExtensionSource())
    for (const [tree, want] of [
      [{}, 'absent'],
      [{ [FILE]: '// my own extension\n' }, 'foreign'],
      [{ [FILE]: v(WALNUT_CLAUDE_CODE_EXTENSION_VERSION + 1) }, 'newer'],
      [{ [FILE]: v(WALNUT_CLAUDE_CODE_EXTENSION_VERSION) }, 'current'],
    ] as const) {
      const t = host({ ...tree })
      expect(await refreshPiExtension(t)).toBe(want)
      expect(t.writes).toBe(0)
    }
    expect(refreshPlan(null, 'x')).toEqual({ keep: 'absent' })
  })

  it('before a start: once per host, never throws, never waits past its deadline', async () => {
    const older = host({ [FILE]: v(1) })
    expect(await refreshPiExtensionBeforeStart('h1', older)).toBe('updated')
    expect(await refreshPiExtensionBeforeStart('h1', older)).toBe('skipped')
    const broken = { ...host({}), readBytes: async () => { throw new Error('socket closed') } }
    expect(await refreshPiExtensionBeforeStart('h2', broken)).toBe('failed')
    const hung = { ...host({}), readBytes: () => new Promise<null>(() => {}) }
    const t0 = Date.now()
    expect(await refreshPiExtensionBeforeStart('h3', hung)).toBe('timeout')
    expect(Date.now() - t0).toBeLessThan(5_000)
  }, 10_000)
})
