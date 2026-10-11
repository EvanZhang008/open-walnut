/**
 * Draft-time engine model catalog probe — the one-shot ACP handshake behind
 * GET /api/engines/:id/models. A REAL adapter process is spawned in every
 * probe test (tests/providers/mock-acp-agent.mjs, the same mock the worker
 * suite uses) — only the provider binary is mocked, never the protocol.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import path from 'node:path'
import { guardedPath } from '../setup/exec-guard.js'
import { fileURLToPath } from 'node:url'

import {
  probeAdapterModels,
  getEngineModelCatalog,
  resetEngineModelCatalogCache,
  _seedEngineModelCatalogCache,
} from '../../src/providers/engine-model-probe.js'

/** A provider's own bin dir, as the user's engine config names it (mock data; the guard rides in front). */
const PROVIDER_PATH = guardedPath(['/opt/provider/bin'], '')

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

const daemonProbe = vi.hoisted(() => ({
  ensureRunning: vi.fn(async () => {}),
  resolveCodex: vi.fn(() => '/usr/local/bin/codex'),
  send: vi.fn(),
  hasCapability: vi.fn(() => true),
}))
vi.mock('../../src/providers/local-daemon.js', () => ({
  localDaemon: { ensureRunning: daemonProbe.ensureRunning, wsUrl: 'ws://127.0.0.1:19001' },
}))
vi.mock('../../src/providers/daemon-connection.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/providers/daemon-connection.js')>(),
  getDirectDaemonConnection: async () => ({ send: daemonProbe.send, hasCapability: daemonProbe.hasCapability }),
}))
vi.mock('../../src/providers/acp-session.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/providers/acp-session.js')>()
  return {
    ...actual,
    resolveSystemCodexPath: daemonProbe.resolveCodex,
    resolveAcpArtifacts: (engine: Parameters<typeof actual.resolveAcpArtifacts>[0], options: Parameters<typeof actual.resolveAcpArtifacts>[1]) => engine === 'codex'
      ? { workerCmd: [], adapterCmd: [process.execPath, new URL('./mock-acp-agent.mjs', import.meta.url).pathname] }
      : actual.resolveAcpArtifacts(engine, options),
  }
})

beforeEach(() => {
  resetEngineModelCatalogCache()
  configHolder.config = {}
  daemonProbe.ensureRunning.mockClear()
  daemonProbe.resolveCodex.mockReset().mockReturnValue('/usr/local/bin/codex')
  daemonProbe.send.mockReset()
  daemonProbe.hasCapability.mockReset().mockReturnValue(true)
})

afterEach(() => { vi.useRealTimers() })

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
  it('resolves the configured Codex executable before querying its catalog', async () => {
    configHolder.config = { engines: { codex: { env: { WALNUT_CODEX_PATH: '/opt/provider/bin/codex', PATH: PROVIDER_PATH } } } }
    daemonProbe.resolveCodex.mockReturnValue('/opt/provider/bin/codex')
    daemonProbe.send.mockResolvedValue({ ok: true, models: [{ modelId: 'native-model[low]', name: 'Native Model (low)' }] })
    await getEngineModelCatalog('codex', { env: {} })
    expect(daemonProbe.resolveCodex).toHaveBeenCalledWith({ env: expect.objectContaining({ WALNUT_CODEX_PATH: '/opt/provider/bin/codex', PATH: PROVIDER_PATH }), cwd: undefined })
    expect(daemonProbe.send).toHaveBeenCalledWith('acpModelCatalog', expect.objectContaining({ binary: '/opt/provider/bin/codex', env: expect.objectContaining({ CODEX_PATH: '/opt/provider/bin/codex' }) }))
  })

  it('does not start a catalog query when the executable override is rejected', async () => {
    configHolder.config = { engines: { codex: { env: { WALNUT_CODEX_PATH: '/missing-provider-bin/codex' } } } }
    daemonProbe.resolveCodex.mockImplementation(() => { throw new Error('WALNUT_CODEX_PATH is not executable') })
    await expect(getEngineModelCatalog('codex', { env: {} })).rejects.toThrow(/WALNUT_CODEX_PATH/)
    expect(daemonProbe.send).not.toHaveBeenCalled()
  })

  it('reads Codex models through the daemon without establishing a session', async () => {
    configHolder.config = { engines: { codex: { env: { MODEL_PROVIDER: 'local-gateway', CODEX_CONFIG: '{"model_provider":"local-gateway"}' } } } }
    daemonProbe.send.mockResolvedValue({ ok: true, models: [{ modelId: 'native-model[low]', name: 'Native Model (low)' }], currentModelId: 'native-model[low]' })
    const [first, second] = await Promise.all([
      getEngineModelCatalog('codex', { env: {} as NodeJS.ProcessEnv, cwd: process.cwd() }),
      getEngineModelCatalog('codex', { env: {} as NodeJS.ProcessEnv, cwd: process.cwd() }),
    ])
    expect(first).toEqual(second)
    expect(first.models).toEqual([{ modelId: 'native-model[low]', name: 'Native Model (low)' }])
    expect(daemonProbe.send).toHaveBeenCalledTimes(1)
    expect(daemonProbe.send).toHaveBeenCalledWith('acpModelCatalog', expect.objectContaining({
      binary: '/usr/local/bin/codex', cwd: process.cwd(),
      env: expect.objectContaining({ MODEL_PROVIDER: 'local-gateway', CODEX_CONFIG: '{"model_provider":"local-gateway"}' }),
    }))
    await getEngineModelCatalog('codex', { env: {} as NodeJS.ProcessEnv, cwd: process.cwd() })
    expect(daemonProbe.send).toHaveBeenCalledTimes(1)
  })

  it('keeps an unfinished daemon probe deduped after the response deadline', async () => {
    vi.useFakeTimers()
    let complete!: (result: unknown) => void
    daemonProbe.send.mockImplementation(() => new Promise((resolve) => { complete = resolve }))
    const first = getEngineModelCatalog('codex', { env: {} as NodeJS.ProcessEnv })
    const rejected = expect(first).rejects.toThrow('engine model catalog timed out')
    await vi.advanceTimersByTimeAsync(20_001)
    await rejected
    const retried = getEngineModelCatalog('codex', { env: {} as NodeJS.ProcessEnv, refresh: true })
    await expect(retried).rejects.toThrow('engine model catalog timed out')
    expect(daemonProbe.send).toHaveBeenCalledTimes(1)
    complete({ ok: true, models: [{ modelId: 'late[low]', name: 'Late' }] })
    await vi.advanceTimersByTimeAsync(0)
    daemonProbe.send.mockResolvedValue({ ok: true, models: [{ modelId: 'fresh[low]', name: 'Fresh' }] })
    expect((await getEngineModelCatalog('codex', { env: {} as NodeJS.ProcessEnv, refresh: true })).models[0].modelId).toBe('fresh[low]')
    vi.useRealTimers()
  })

  it('uses the ACP handshake when an older daemon has no read-only catalog capability', async () => {
    daemonProbe.hasCapability.mockReturnValue(false)
    const catalog = await getEngineModelCatalog('codex', { env: {} as NodeJS.ProcessEnv })
    expect(catalog.models.map((model) => model.modelId)).toEqual(['mock-gpt-best', 'mock-gpt-fast'])
    expect(daemonProbe.send).not.toHaveBeenCalled()
  })

  it('reports a daemon model failure and retries after the operator fixes it', async () => {
    daemonProbe.send.mockResolvedValue({ ok: false, error: 'provider unavailable' })
    await expect(getEngineModelCatalog('codex', { env: {} as NodeJS.ProcessEnv })).rejects.toThrow('provider unavailable')
    daemonProbe.send.mockResolvedValue({ ok: true, models: [{ modelId: 'recovered[low]', name: 'Recovered' }] })
    await expect(getEngineModelCatalog('codex', { env: {} as NodeJS.ProcessEnv })).rejects.toThrow('provider unavailable')
    expect((await getEngineModelCatalog('codex', { env: {} as NodeJS.ProcessEnv, refresh: true })).models[0].modelId).toBe('recovered[low]')
  })

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
