/**
 * Draft-time engine model catalog probe — the one-shot ACP handshake behind
 * GET /api/engines/:id/models. A REAL adapter process is spawned in every
 * probe test (tests/providers/mock-acp-agent.mjs, the same mock the worker
 * suite uses) — only the provider binary is mocked, never the protocol.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  probeAdapterModels,
  getEngineModelCatalog,
  resetEngineModelCatalogCache,
  _seedEngineModelCatalogCache,
} from '../../src/providers/engine-model-probe.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MOCK_AGENT = path.join(__dirname, 'mock-acp-agent.mjs')

// The cache tests drive the CUSTOM engine, whose adapter argv comes from
// walnut config — pin getConfig so the tests never read (or depend on) this
// machine's real ~/.open-walnut/config.yaml.
const configHolder: { config: Record<string, unknown> } = { config: {} }
vi.mock('../../src/core/config-manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/config-manager.js')>()
  return { ...actual, getConfig: async () => configHolder.config }
})

beforeEach(() => {
  resetEngineModelCatalogCache()
  configHolder.config = {}
})

describe('probeAdapterModels', () => {
  it('reads the advertised catalog out of session/new and exits', async () => {
    const result = await probeAdapterModels([process.execPath, MOCK_AGENT])
    expect(result.currentModelId).toBe('mock-gpt-best')
    expect(result.models).toEqual([
      { modelId: 'mock-gpt-best', name: 'Mock GPT Best', description: 'Best mock model' },
      { modelId: 'mock-gpt-fast', name: 'Mock GPT Fast', description: 'Fast mock model' },
    ])
  })

  it('falls back to the model config option when no models extension exists', async () => {
    // Inline adapter: initialize + session/new advertising ONLY configOptions.
    const script = `
      const rl = require('node:readline').createInterface({ input: process.stdin });
      rl.on('line', (line) => {
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } }) + '\\n');
        } else if (msg.method === 'session/new') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
            sessionId: 's1',
            configOptions: [{
              id: 'model', name: 'Model', type: 'select', currentValue: 'prov/model-a',
              options: [
                { value: 'prov/model-a', name: 'Provider/Model A' },
                { value: 'prov/model-b', name: 'Provider/Model B' },
              ],
            }],
          } }) + '\\n');
        }
      });
    `
    const result = await probeAdapterModels([process.execPath, '-e', script])
    expect(result.currentModelId).toBe('prov/model-a')
    expect(result.models).toEqual([
      { modelId: 'prov/model-a', name: 'Provider/Model A' },
      { modelId: 'prov/model-b', name: 'Provider/Model B' },
    ])
  })

  it('rejects with the adapter stderr when it exits before answering', async () => {
    const script = 'process.stderr.write("no credentials configured\\n"); process.exit(3);'
    await expect(probeAdapterModels([process.execPath, '-e', script]))
      .rejects.toThrow(/exited \(code 3\).*no credentials configured/s)
  })

  it('rejects on its own deadline when the adapter never answers', async () => {
    const script = 'setInterval(() => {}, 1000);' // alive, silent
    await expect(probeAdapterModels([process.execPath, '-e', script], { timeoutMs: 400 }))
      .rejects.toThrow(/did not answer/)
  })

  it('rejects when the adapter command cannot spawn', async () => {
    await expect(probeAdapterModels(['/nonexistent/adapter-binary-xyz']))
      .rejects.toThrow(/spawn failed/)
  })

  it('surfaces a session/new rpc error verbatim (auth-required adapters)', async () => {
    const script = `
      const rl = require('node:readline').createInterface({ input: process.stdin });
      rl.on('line', (line) => {
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } }) + '\\n');
        } else if (msg.method === 'session/new') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'authentication required' } }) + '\\n');
        }
      });
    `
    await expect(probeAdapterModels([process.execPath, '-e', script]))
      .rejects.toThrow(/session\/new failed: authentication required/)
  })
})

describe('getEngineModelCatalog', () => {
  it('answers the fixture mock under WALNUT_ENGINE_PROBE_ALL=1 without spawning', async () => {
    const catalog = await getEngineModelCatalog('opencode', {
      env: { WALNUT_ENGINE_PROBE_ALL: '1' } as NodeJS.ProcessEnv,
    })
    expect(catalog.source).toBe('mock')
    expect(catalog.engine).toBe('opencode')
    // The two flat models match the mock agent (launchable end-to-end); the
    // mock-provider/* rows exist to exercise the picker's grouped/effort UI.
    expect(catalog.models.map((m) => m.modelId)).toEqual([
      'mock-gpt-best',
      'mock-gpt-fast',
      'mock-provider/deep-thinker/medium',
      'mock-provider/deep-thinker/high',
      'mock-provider/quick-drafter',
    ])
    expect(catalog.currentModelId).toBe('mock-gpt-best')
  })

  it('refuses non-ACP engines — claude has its own catalog pipeline', async () => {
    await expect(getEngineModelCatalog('claude', {
      env: { WALNUT_ENGINE_PROBE_ALL: '1' } as NodeJS.ProcessEnv,
    })).rejects.toThrow(/does not advertise/)
  })

  it('serves a seeded cache entry, and refresh bypasses it to re-probe', async () => {
    configHolder.config = { engines: { custom: { adapter_cmd: [process.execPath, MOCK_AGENT] } } }
    _seedEngineModelCatalogCache('custom', undefined, {
      result: {
        engine: 'custom',
        models: [{ modelId: 'stale-cached-model', name: 'Stale Cached' }],
        fetchedAt: Date.now(),
        source: 'probe',
      },
    })
    // Cache read: the marker catalog answers, no adapter spawns.
    const cachedAnswer = await getEngineModelCatalog('custom', { env: {} as NodeJS.ProcessEnv })
    expect(cachedAnswer.models.map((m) => m.modelId)).toEqual(['stale-cached-model'])
    // refresh skips the cache and probes the real (mock) adapter…
    const fresh = await getEngineModelCatalog('custom', { refresh: true, env: {} as NodeJS.ProcessEnv })
    expect(fresh.models.map((m) => m.modelId)).toEqual(['mock-gpt-best', 'mock-gpt-fast'])
    // …and the fresh answer replaces the cached one.
    const after = await getEngineModelCatalog('custom', { env: {} as NodeJS.ProcessEnv })
    expect(after.models.map((m) => m.modelId)).toEqual(['mock-gpt-best', 'mock-gpt-fast'])
  })

  it('expires cache entries on their TTLs (success 10min, failure 45s)', async () => {
    configHolder.config = { engines: { custom: { adapter_cmd: [process.execPath, MOCK_AGENT] } } }
    // Backdated FAILURE past 45s: the next plain read must re-probe (and the
    // now-working adapter answers) instead of rethrowing the stale error.
    _seedEngineModelCatalogCache('custom', undefined, { error: 'ancient failure' }, Date.now() - 46_000)
    const recovered = await getEngineModelCatalog('custom', { env: {} as NodeJS.ProcessEnv })
    expect(recovered.models.map((m) => m.modelId)).toEqual(['mock-gpt-best', 'mock-gpt-fast'])
    // Backdated SUCCESS past 10min: also re-probed, not served stale.
    _seedEngineModelCatalogCache('custom', undefined, {
      result: { engine: 'custom', models: [{ modelId: 'ancient-model', name: 'Ancient' }], fetchedAt: 0, source: 'probe' },
    }, Date.now() - 10 * 60_000 - 1_000)
    const reprobed = await getEngineModelCatalog('custom', { env: {} as NodeJS.ProcessEnv })
    expect(reprobed.models.map((m) => m.modelId)).toEqual(['mock-gpt-best', 'mock-gpt-fast'])
  })

  it('caches failures, and refresh is the retry that recovers after a config fix', async () => {
    // Broken adapter → the failure lands in the cache.
    configHolder.config = { engines: { custom: { adapter_cmd: [process.execPath, '-e', 'process.exit(7)'] } } }
    await expect(getEngineModelCatalog('custom', { env: {} as NodeJS.ProcessEnv })).rejects.toThrow(/exited \(code 7\)/)
    // Operator fixes the config — a plain read still serves the CACHED
    // failure (45s TTL), which is exactly why the picker's Retry sends
    // refresh=1…
    configHolder.config = { engines: { custom: { adapter_cmd: [process.execPath, MOCK_AGENT] } } }
    await expect(getEngineModelCatalog('custom', { env: {} as NodeJS.ProcessEnv })).rejects.toThrow(/exited \(code 7\)/)
    // …and refresh re-probes and succeeds immediately.
    const recovered = await getEngineModelCatalog('custom', { refresh: true, env: {} as NodeJS.ProcessEnv })
    expect(recovered.models.map((m) => m.modelId)).toEqual(['mock-gpt-best', 'mock-gpt-fast'])
  })
})
