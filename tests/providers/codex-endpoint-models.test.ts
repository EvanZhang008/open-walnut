/**
 * A Codex model menu offers only the models its endpoint serves
 * (src/providers/codex-endpoint-models.ts). 2026-11-18: a Codex update listed
 * openai.gpt-6.2-sol, the picker offered it, and the endpoint answered every
 * turn 404. Any model Codex lists that the endpoint's own list lacks is dropped.
 */
import { afterEach, describe, expect, it } from 'vitest'
import http from 'node:http'
import {
  _resetEndpointModelCache, endpointServedModels, keepServedModels, parseModelList, providerFromCodexConfig,
} from '../../src/providers/codex-endpoint-models.js'
import { checkSwitchModelOffered, ModelNotOfferedError } from '../../src/core/sessions/engine-switch-model.js'

afterEach(() => _resetEndpointModelCache())

const menu = (...ids: string[]) => ids.flatMap((id) => ['low', 'medium'].map((e) => ({ modelId: `${id}[${e}]` })))

describe('keepServedModels', () => {
  it('drops every model Codex lists that the endpoint does not serve, whatever its name', () => {
    const served = new Set(['openai.gpt-6.1-sol', 'openai.gpt-6-luna'])
    const listed = menu('openai.gpt-6.2-sol', 'openai.gpt-6.1-sol', 'openai.gpt-7-future', 'openai.gpt-6-luna')
    const kept = keepServedModels(listed, served, (m) => m.modelId).map((m) => m.modelId)
    expect(kept).toEqual(['openai.gpt-6.1-sol[low]', 'openai.gpt-6.1-sol[medium]', 'openai.gpt-6-luna[low]', 'openai.gpt-6-luna[medium]'])
  })

  it('keeps the menu when the endpoint cannot say, or names its models some other way', () => {
    const listed = menu('openai.gpt-6.1-sol')
    expect(keepServedModels(listed, null, (m) => m.modelId)).toBe(listed)
    expect(keepServedModels(listed, new Set(['something-else']), (m) => m.modelId)).toBe(listed)
  })
})

describe('the endpoint list', () => {
  it('reads OpenAI and slug shapes, and the provider a Codex config routes to', () => {
    expect([...parseModelList({ data: [{ id: 'a' }, { id: 'b' }] })!]).toEqual(['a', 'b'])
    expect([...parseModelList({ models: [{ slug: 'c' }] })!]).toEqual(['c'])
    expect(parseModelList({ error: 'nope' })).toBeNull()
    expect(providerFromCodexConfig({ model_provider: 'lp', model_providers: { lp: { base_url: 'http://127.0.0.1:1/v1', env_key: 'K' } } }))
      .toEqual({ base_url: 'http://127.0.0.1:1/v1', env_key: 'K' })
    expect(providerFromCodexConfig({ model_provider: 'openai' })).toBeUndefined()
    expect(providerFromCodexConfig({ model_provider: 'lp', model_providers: { lp: { base_url: 'file:///x' } } })).toBeUndefined()
  })

  it('asks GET <base_url>/models with the provider key, and is null on an error or no answer', async () => {
    let auth: string | undefined
    const server = http.createServer((req, res) => {
      auth = req.headers.authorization
      if (req.url === '/v1/models') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'openai.gpt-6.1-sol' }] })); return }
      if (req.url === '/slow/models') return // never answers
      res.statusCode = 404; res.end('{}')
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    try {
      const ids = await endpointServedModels({ base_url: `${base}/v1/`, env_key: 'LP_KEY' }, { LP_KEY: 'sekret' })
      expect([...ids!]).toEqual(['openai.gpt-6.1-sol'])
      expect(auth).toBe('Bearer sekret')
      expect(await endpointServedModels({ base_url: `${base}/missing` }, {})).toBeNull()
      expect(await endpointServedModels({ base_url: `${base}/slow` }, {}, { timeoutMs: 200 })).toBeNull()
      expect(await endpointServedModels(undefined, {})).toBeNull()
    } finally {
      server.closeAllConnections()
      server.close()
    }
  })
})

describe('an engine switch with a model the menu does not offer', () => {
  const readMenu = async () => ({ models: menu('openai.gpt-6.1-sol', 'openai.gpt-6-luna') })

  it('is refused at the switch, naming what the menu offers', async () => {
    const err = await checkSwitchModelOffered('codex', 'openai.gpt-6.2-sol[medium]', { local: true, readMenu }).catch((e) => e)
    expect(err).toBeInstanceOf(ModelNotOfferedError)
    expect(err.message).toContain('openai.gpt-6.2-sol')
    expect(err.message).toContain('openai.gpt-6.1-sol, openai.gpt-6-luna')
  })

  it('passes an offered model (with or without its effort), a non-ACP engine, another host, and an unreadable menu', async () => {
    await expect(checkSwitchModelOffered('codex', 'openai.gpt-6.1-sol[medium]', { local: true, readMenu })).resolves.toBeUndefined()
    await expect(checkSwitchModelOffered('codex', 'openai.gpt-6.1-sol', { local: true, readMenu })).resolves.toBeUndefined()
    await expect(checkSwitchModelOffered('claude', 'whatever', { local: true, readMenu })).resolves.toBeUndefined()
    await expect(checkSwitchModelOffered('codex', 'openai.gpt-6.2-sol', { local: false, readMenu })).resolves.toBeUndefined()
    await expect(checkSwitchModelOffered('codex', 'openai.gpt-6.2-sol', { local: true, readMenu: async () => { throw new Error('down') } })).resolves.toBeUndefined()
    await expect(checkSwitchModelOffered('codex', 'openai.gpt-6.2-sol', { local: true, readMenu: async () => ({ models: [] }) })).resolves.toBeUndefined()
  })
})
