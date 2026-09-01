/**
 * GET /api/engines — the engine catalog the web UI renders its engine toggle,
 * model picker and local-only locks from.
 *
 * Real HTTP through the real router (supertest over a bare express app, the
 * dashboard-route pattern) but ZERO child processes: availability is either
 * seeded into the probe cache or forced by WALNUT_ENGINE_PROBE_ALL=1, so the
 * response never depends on which provider CLIs this machine has installed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

import { enginesRouter } from '../../../src/web/routes/engines.js'
import { errorHandler } from '../../../src/web/middleware/error-handler.js'
import { SESSION_ENGINE_IDS } from '../../../src/core/types.js'
import { _resetEngineProbeCache, _seedEngineProbeCache } from '../../../src/core/agents/engine-probe.js'
import { resetEngineModelCatalogCache, _seedEngineModelCatalogCache } from '../../../src/providers/engine-model-probe.js'

// The model-catalog probe reads engines.<id>.adapter_cmd from walnut config —
// pin getConfig to an EMPTY config so these tests never depend on (or spawn
// anything from) the developer machine's real ~/.open-walnut/config.yaml.
vi.mock('../../../src/core/config-manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/config-manager.js')>()
  return { ...actual, getConfig: async () => ({}) }
})

interface EngineEntry {
  id: string
  displayName: string
  runtimeKind: 'native' | 'acp'
  isDefault: boolean
  localOnly: boolean
  capabilities: {
    rewind: boolean
    fork: boolean
    modelCatalog: 'static' | 'provider-advertised'
    modeControl: 'claude-modes' | 'config-options'
    idProvisioning: 'preassigned' | 'provider-issued'
  }
  availability: { installed: boolean; version: string | null; reason: string | null }
}

function createApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/engines', enginesRouter)
  app.use(errorHandler)
  return app
}

/** Pin every engine so the route answers from cache and spawns nothing. */
function seedAll(overrides: Record<string, { installed: boolean; version: string | null; reason: string | null }> = {}) {
  for (const id of SESSION_ENGINE_IDS) {
    _seedEngineProbeCache(id, overrides[id] ?? { installed: true, version: '1.0.0', reason: null })
  }
}

beforeEach(() => {
  _resetEngineProbeCache()
  delete process.env.WALNUT_ENGINE_PROBE_ALL
})

afterEach(() => {
  _resetEngineProbeCache()
  delete process.env.WALNUT_ENGINE_PROBE_ALL
})

describe('GET /api/engines', () => {
  it('lists every registered engine in presentation order with capability answers', async () => {
    seedAll()
    const res = await request(createApp()).get('/api/engines')
    expect(res.status).toBe(200)
    const engines = res.body.engines as EngineEntry[]
    expect(engines.map((e) => e.id)).toEqual([...SESSION_ENGINE_IDS])

    const claude = engines.find((e) => e.id === 'claude')!
    expect(claude.isDefault).toBe(true)
    expect(claude.runtimeKind).toBe('native')
    expect(claude.localOnly).toBe(false)
    expect(claude.capabilities).toEqual({
      rewind: true,
      fork: true,
      modelCatalog: 'static',
      modeControl: 'claude-modes',
      idProvisioning: 'preassigned',
    })

    // Every ACP engine is local-only today and shares codex's capability axes.
    for (const engine of engines.filter((e) => e.runtimeKind === 'acp')) {
      expect(engine.isDefault, engine.id).toBe(false)
      expect(engine.localOnly, engine.id).toBe(true)
      expect(engine.capabilities, engine.id).toEqual({
        rewind: false,
        fork: false,
        modelCatalog: 'provider-advertised',
        modeControl: 'config-options',
        idProvisioning: 'provider-issued',
      })
    }

    expect(engines.map((e) => e.displayName)).toContain('Gemini')
    expect(engines.map((e) => e.displayName)).toContain('Custom (ACP)')
  })

  it('passes the probe reason through for an unavailable engine', async () => {
    seedAll({
      custom: { installed: false, version: null, reason: 'configure engines.custom.adapter_cmd (the ACP adapter argv) to use Custom (ACP)' },
      goose: { installed: true, version: '1.31.0', reason: null },
    })
    const res = await request(createApp()).get('/api/engines')
    expect(res.status).toBe(200)
    const engines = res.body.engines as EngineEntry[]
    const custom = engines.find((e) => e.id === 'custom')!
    expect(custom.availability.installed).toBe(false)
    expect(custom.availability.reason).toContain('engines.custom.adapter_cmd')
    expect(engines.find((e) => e.id === 'goose')!.availability).toEqual({
      installed: true,
      version: '1.31.0',
      reason: null,
    })
  })

  it('WALNUT_ENGINE_PROBE_ALL=1 reports every engine installed (fixture determinism)', async () => {
    process.env.WALNUT_ENGINE_PROBE_ALL = '1'
    const res = await request(createApp()).get('/api/engines')
    expect(res.status).toBe(200)
    const engines = res.body.engines as EngineEntry[]
    expect(engines).toHaveLength(SESSION_ENGINE_IDS.length)
    for (const engine of engines) {
      expect(engine.availability, engine.id).toEqual({ installed: true, version: null, reason: null })
    }
  })

  it('is mounted on the server under /api/engines', async () => {
    // The catalog is useless if the router is never wired; cheaper to pin the
    // mount statically than to boot the whole server for it.
    const fs = await import('node:fs')
    const url = await import('node:url')
    const p = await import('node:path')
    const root = p.resolve(p.dirname(url.fileURLToPath(import.meta.url)), '../../..')
    const server = fs.readFileSync(p.join(root, 'src/web/server.ts'), 'utf-8')
    expect(server).toContain("app.use('/api/engines'")
  })
})

describe('GET /api/engines/:id/models', () => {
  beforeEach(() => { resetEngineModelCatalogCache() })

  it('answers the draft-time catalog for an ACP engine (fixture mode, zero spawns)', async () => {
    process.env.WALNUT_ENGINE_PROBE_ALL = '1'
    const res = await request(createApp()).get('/api/engines/opencode/models')
    expect(res.status).toBe(200)
    expect(res.body.engine).toBe('opencode')
    expect(res.body.source).toBe('mock')
    expect((res.body.models as Array<{ modelId: string }>).map((m) => m.modelId))
      .toEqual([
        'mock-gpt-best',
        'mock-gpt-fast',
        'mock-provider/deep-thinker/medium',
        'mock-provider/deep-thinker/high',
        'mock-provider/quick-drafter',
      ])
    expect(res.body.currentModelId).toBe('mock-gpt-best')
  })

  it('404s for claude (its catalog rides the host model-catalog pipeline)', async () => {
    process.env.WALNUT_ENGINE_PROBE_ALL = '1'
    const res = await request(createApp()).get('/api/engines/claude/models')
    expect(res.status).toBe(404)
  })

  it('404s for an unknown engine id', async () => {
    process.env.WALNUT_ENGINE_PROBE_ALL = '1'
    const res = await request(createApp()).get('/api/engines/gemni/models')
    expect(res.status).toBe(404)
  })

  it('502s with the probe\'s own words when the adapter cannot answer', async () => {
    // A cached failure entry stands in for a dead adapter: the route must
    // degrade to an HONEST error body carrying the probe's message, never a
    // hang or an empty list pretending to be a catalog.
    _seedEngineModelCatalogCache('custom', undefined, { error: 'adapter spawn failed: ENOENT (seeded)' })
    const res = await request(createApp()).get('/api/engines/custom/models')
    expect(res.status).toBe(502)
    expect(res.body.engine).toBe('custom')
    expect(res.body.error).toContain('adapter spawn failed')
  })

  it('serves the cache on a plain read and ?refresh=1 busts it', async () => {
    // Seed a marker catalog: a plain read must answer it verbatim (no spawn),
    // and refresh=1 must SKIP it — the re-probe then fails (no adapter binary
    // exists in this test), proving the cached entry was bypassed.
    _seedEngineModelCatalogCache('custom', undefined, {
      result: {
        engine: 'custom',
        models: [{ modelId: 'stale-cached-model', name: 'Stale Cached' }],
        fetchedAt: Date.now(),
        source: 'probe',
      },
    })
    const cached = await request(createApp()).get('/api/engines/custom/models')
    expect(cached.status).toBe(200)
    expect((cached.body.models as Array<{ modelId: string }>).map((m) => m.modelId))
      .toEqual(['stale-cached-model'])
    const refreshed = await request(createApp()).get('/api/engines/custom/models?refresh=1')
    expect(refreshed.status).toBe(502)
  })
})
