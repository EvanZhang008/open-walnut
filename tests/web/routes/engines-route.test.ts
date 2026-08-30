/**
 * GET /api/engines — the engine catalog the web UI renders its engine toggle,
 * model picker and local-only locks from.
 *
 * Real HTTP through the real router (supertest over a bare express app, the
 * dashboard-route pattern) but ZERO child processes: availability is either
 * seeded into the probe cache or forced by WALNUT_ENGINE_PROBE_ALL=1, so the
 * response never depends on which provider CLIs this machine has installed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'

import { enginesRouter } from '../../../src/web/routes/engines.js'
import { errorHandler } from '../../../src/web/middleware/error-handler.js'
import { SESSION_ENGINE_IDS } from '../../../src/core/types.js'
import { _resetEngineProbeCache, _seedEngineProbeCache } from '../../../src/core/agents/engine-probe.js'

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
