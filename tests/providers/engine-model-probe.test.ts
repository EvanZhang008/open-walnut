/**
 * Draft-time engine model catalog probe — the one-shot ACP handshake behind
 * GET /api/engines/:id/models. A REAL adapter process is spawned in every
 * probe test (tests/providers/mock-acp-agent.mjs, the same mock the worker
 * suite uses) — only the provider binary is mocked, never the protocol.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  probeAdapterModels,
  getEngineModelCatalog,
  resetEngineModelCatalogCache,
} from '../../src/providers/engine-model-probe.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MOCK_AGENT = path.join(__dirname, 'mock-acp-agent.mjs')

beforeEach(() => { resetEngineModelCatalogCache() })

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
    expect(catalog.models.map((m) => m.modelId)).toEqual(['mock-gpt-best', 'mock-gpt-fast'])
  })

  it('refuses non-ACP engines — claude has its own catalog pipeline', async () => {
    await expect(getEngineModelCatalog('claude', {
      env: { WALNUT_ENGINE_PROBE_ALL: '1' } as NodeJS.ProcessEnv,
    })).rejects.toThrow(/does not advertise/)
  })
})
