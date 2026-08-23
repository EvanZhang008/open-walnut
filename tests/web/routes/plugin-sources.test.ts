import express from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const sourceMocks = vi.hoisted(() => ({
  addSource: vi.fn(),
  addNpmSource: vi.fn(),
  updateSource: vi.fn(),
  checkSource: vi.fn(),
  removeSource: vi.fn(),
  listSources: vi.fn(),
}))

vi.mock('../../../src/core/plugin-sources.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/core/plugin-sources.js')>(),
  ...sourceMocks,
}))
vi.mock('../../../src/core/integration-registry.js', () => ({
  registry: { has: vi.fn(() => false), get: vi.fn(() => undefined) },
}))
vi.mock('../../../src/core/integration-loader.js', () => ({
  getUnconfiguredPlugins: vi.fn(() => []),
  getUnsupportedPlugins: vi.fn(() => []),
  getDuplicatePluginIds: vi.fn(() => []),
}))

import { createPluginSourcesRouter } from '../../../src/web/routes/plugin-sources.js'

function app() {
  const instance = express()
  instance.use(express.json({ strict: false }))
  instance.use('/api/plugin-sources', createPluginSourcesRouter(async () => undefined))
  return instance
}

function source(slug = 'demo') {
  return {
    slug,
    kind: 'git' as const,
    url: `https://example.test/${slug}.git`,
    enabled: true,
    cloned: true,
    plugins: [],
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  sourceMocks.listSources.mockResolvedValue([])
  sourceMocks.removeSource.mockResolvedValue(undefined)
  sourceMocks.checkSource.mockResolvedValue({ behind: 0, updateAvailable: false })
  sourceMocks.updateSource.mockResolvedValue({ updated: false })
})

describe('Plugin sources route boundaries', () => {
  it.each(['5', '"text"', 'null', '[]'])('returns JSON 400 for primitive body %s', async (body) => {
    const response = await request(app())
      .post('/api/plugin-sources')
      .set('Content-Type', 'application/json')
      .send(body)
      .expect(400)

    expect(response.type).toBe('application/json')
    expect(response.body.error).toMatch(/url or spec is required/)
    expect(sourceMocks.addSource).not.toHaveBeenCalled()
    expect(sourceMocks.addNpmSource).not.toHaveBeenCalled()
  })

  it('rejects ambiguous source forms', async () => {
    await request(app())
      .post('/api/plugin-sources')
      .send({ url: 'https://example.test/demo.git', spec: 'demo-plugin' })
      .expect(400, { error: 'provide exactly one source form: url/share snippet or spec' })

    expect(sourceMocks.addSource).not.toHaveBeenCalled()
    expect(sourceMocks.addNpmSource).not.toHaveBeenCalled()
  })

  it('rejects internal and traversal-shaped slugs before any mutation', async () => {
    for (const slug of ['.staging-demo', '.backup-demo', '..evil']) {
      await request(app()).delete(`/api/plugin-sources/${slug}`).expect(400, { error: 'invalid slug' })
    }
    expect(sourceMocks.listSources).not.toHaveBeenCalled()
    expect(sourceMocks.removeSource).not.toHaveBeenCalled()
  })

  it('does not delete an unconfigured directory', async () => {
    await request(app()).delete('/api/plugin-sources/orphan').expect(404, { error: 'source not found' })
    expect(sourceMocks.removeSource).not.toHaveBeenCalled()
  })

  it('removes only a configured source', async () => {
    sourceMocks.listSources.mockResolvedValue([source('demo')])
    await request(app()).delete('/api/plugin-sources/demo').expect(200, {
      removed: true,
      restartRequired: false,
    })
    expect(sourceMocks.removeSource).toHaveBeenCalledWith('demo')
  })

  it('returns JSON when list, update, or check fails', async () => {
    sourceMocks.listSources.mockRejectedValueOnce(new Error('state unreadable'))
    const update = await request(app()).post('/api/plugin-sources/demo/update').expect(500)
    expect(update.type).toBe('application/json')
    expect(update.body).toEqual({ error: 'state unreadable' })

    sourceMocks.listSources.mockRejectedValueOnce(new Error('state unreadable'))
    const check = await request(app()).post('/api/plugin-sources/demo/check').expect(500)
    expect(check.type).toBe('application/json')
    expect(check.body).toEqual({ error: 'state unreadable' })
  })
})
