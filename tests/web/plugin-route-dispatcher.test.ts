import express, { Router } from 'express'
import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'
import { IntegrationRegistry } from '../../src/core/integration-registry.js'
import { createPluginBodyParser, createPluginRouteDispatcher } from '../../src/web/plugin-route-dispatcher.js'
import { createMockPlugin } from '../core/plugin-test-utils.js'

function route(value: string) {
  const router = Router()
  router.get('/', (_req, res) => res.json({ value }))
  return { method: 'get' as const, path: '/status', handler: router }
}

describe('createPluginRouteDispatcher', () => {
  it('reads the live registry for every request', async () => {
    const registry = new IntegrationRegistry()
    registry.register('sample', createMockPlugin({ id: 'sample', httpRoutes: [route('first')] }))
    const app = express()
    app.use('/api/plugins', createPluginRouteDispatcher(registry))

    await request(app).get('/api/plugins/sample/status').expect(200, { value: 'first' })

    registry.unregister('sample')
    await request(app).get('/api/plugins/sample/status').expect(404)

    registry.register('sample', createMockPlugin({ id: 'sample', httpRoutes: [route('second')] }))
    await request(app).get('/api/plugins/sample/status').expect(200, { value: 'second' })
  })

  it('isolates routes by plugin id', async () => {
    const registry = new IntegrationRegistry()
    registry.register('one', createMockPlugin({ id: 'one', httpRoutes: [route('one')] }))
    registry.register('two', createMockPlugin({ id: 'two', httpRoutes: [route('two')] }))
    const app = express()
    app.use('/api/plugins', createPluginRouteDispatcher(registry))

    expect((await request(app).get('/api/plugins/one/status')).body.value).toBe('one')
    expect((await request(app).get('/api/plugins/two/status')).body.value).toBe('two')
  })

  it('keeps legacy JSON bodies parsed while unified Plugin routes receive raw bytes', async () => {
    const registry = new IntegrationRegistry()
    const legacyRouter = Router()
    legacyRouter.post('/', (req, res) => res.json({ parsed: req.body }))
    const unifiedRouter = Router()
    unifiedRouter.post('/', (req, res) => res.json({ raw: Buffer.isBuffer(req.body) }))
    registry.register('legacy', createMockPlugin({
      id: 'legacy',
      httpRoutes: [{ method: 'post', path: '/echo', handler: legacyRouter }],
    }))
    registry.register('unified', createMockPlugin({
      id: 'unified',
      apiVersion: 1,
      httpRoutes: [{ method: 'post', path: '/echo', handler: unifiedRouter }],
    }))
    const app = express()
    app.use('/api/plugins/:pluginId', createPluginBodyParser(registry, false))
    app.use(express.json())
    app.use('/api/plugins', createPluginRouteDispatcher(registry))

    await request(app)
      .post('/api/plugins/legacy/echo')
      .send({ value: 42 })
      .expect(200, { parsed: { value: 42 } })
    await request(app)
      .post('/api/plugins/unified/echo')
      .send({ value: 42 })
      .expect(200, { raw: true })
  })

  it('relays missing local Plugin routes with raw bytes and preserves the response', async () => {
    const registry = new IntegrationRegistry()
    const relay = vi.fn(async () => ({
      status: 202,
      headers: { 'content-type': 'application/octet-stream', 'x-plugin': 'remote' },
      body: Buffer.from([255, 0, 1]),
    }))
    const app = express()
    app.use('/api/plugins', express.raw({ type: '*/*' }))
    app.use('/api/plugins', createPluginRouteDispatcher(registry, { relay }))

    const response = await request(app)
      .post('/api/plugins/sample/webhook?source=test')
      .set('Content-Type', 'application/octet-stream')
      .set('X-Signature', 'abc')
      .send(Buffer.from([0, 1, 2]))
      .expect(202)

    expect(Buffer.from(response.body)).toEqual(Buffer.from([255, 0, 1]))
    expect(response.headers['x-plugin']).toBe('remote')
    expect(relay).toHaveBeenCalledWith(expect.objectContaining({
      pluginId: 'sample',
      method: 'POST',
      path: '/webhook?source=test',
      headers: expect.objectContaining({ 'x-signature': 'abc' }),
      body: Buffer.from([0, 1, 2]),
    }))
  })
})
