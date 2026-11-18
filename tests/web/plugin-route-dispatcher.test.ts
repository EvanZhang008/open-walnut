import express, { Router } from 'express'
import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'
import { IntegrationRegistry } from '../../src/core/integration-registry.js'
import { createPluginBodyParser, createPluginRouteDispatcher } from '../../src/web/plugin-route-dispatcher.js'
import { createMockPlugin } from '../core/plugin-test-utils.js'
import { forwardJobRoute } from '../../src/core/plugin-jobs/serve.js'
import type { JobsHost } from '../../src/core/plugin-jobs/manager.js'
import type { PluginHttpRelayRequest } from '../../src/web/routes/plugin-runtime-bridge.js'

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

  it('answers 503 plugin_starting with Retry-After for a plugin on its way up, and 404 for one that is not', async () => {
    const registry = new IntegrationRegistry()
    const app = express()
    app.use('/api/plugins', createPluginRouteDispatcher(registry, {
      starting: (id) => (id === 'sample' ? { name: 'Sample' } : undefined),
    }))

    const starting = await request(app).post('/api/plugins/sample/reaction').send({ emoji: 'eyes' }).expect(503)
    expect(starting.body).toEqual({ error: 'plugin_starting', message: 'Sample is starting. Try again in a moment.' })
    expect(starting.headers['retry-after']).toBe('2')
    await request(app).get('/api/plugins/other/status').expect(404)

    // Once its routes are in, they answer: `starting` is asked only when there are none.
    registry.register('sample', createMockPlugin({ id: 'sample', httpRoutes: [route('up')] }))
    await request(app).get('/api/plugins/sample/status').expect(200, { value: 'up' })
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

describe('a plugin whose job serves routes (the leader)', () => {
  /** The real forwarder (core/plugin-jobs/serve.ts) over a fake daemon: what it was sent is the assertion. */
  function jobRoutes(reply: (params: Record<string, unknown>) => Promise<Record<string, unknown>> | Record<string, unknown>, opts: { serves?: (id: string) => boolean; target?: { error: string } } = {}) {
    const asked: Array<Record<string, unknown>> = []
    const handle: JobsHost = {
      hostKey: 'devbox', connected: true, hasCapability: () => true,
      send: async (_cmd, params = {}) => { asked.push(params); return reply(params) },
      uploadFile: async () => ({}),
    }
    const jobs = {
      serves: opts.serves ?? ((id: string) => id === 'door'),
      forward: (r: PluginHttpRelayRequest) => forwardJobRoute({
        home: '/home/tester/.open-walnut', timeoutMs: 200,
        serveTarget: async () => opts.target ?? { handle, where: 'Dev box' },
      }, r),
    }
    return { asked, jobs }
  }
  const answer = (status: number, body: string, headers: Record<string, string> = {}) => ({ ok: true, status, headers, size: Buffer.byteLength(body), data: Buffer.from(body).toString('base64') })

  function app(registry: IntegrationRegistry, jobs: ReturnType<typeof jobRoutes>['jobs'], extra: Parameters<typeof createPluginRouteDispatcher>[1] = {}) {
    const a = express()
    a.use('/api/plugins/:pluginId', createPluginBodyParser(registry, false, jobs.serves))
    a.use('/api/plugins', createPluginRouteDispatcher(registry, { jobs, ...extra }))
    return a
  }

  it('a plugin with no route here: the request goes to the job, raw, without Authorization and Cookie, and its answer comes back', async () => {
    const registry = new IntegrationRegistry()
    const t = jobRoutes(() => answer(201, '{"length":1}', { 'content-type': 'application/json; charset=utf-8', 'x-acme': 'job' }))
    const res = await request(app(registry, t.jobs))
      .post('/api/plugins/door/queue?x=1')
      .set('Authorization', 'Bearer s3cret')
      .set('Cookie', 'walnut_session=abc')
      .set('X-Walnut-Origin', 'spoofed-by-client')
      .set('Content-Type', 'application/json')
      .send('{"item":"a"}')
      .expect(201)
    expect(res.body).toEqual({ length: 1 })
    expect(res.headers['x-acme']).toBe('job')
    expect(t.asked).toHaveLength(1)
    const sent = t.asked[0]!
    expect(sent).toMatchObject({ plugin: 'door', method: 'POST', path: '/queue?x=1', size: 12 })
    expect(Buffer.from(String(sent.data), 'base64').toString()).toBe('{"item":"a"}')
    const headers = sent.headers as Record<string, string>
    expect(headers.authorization).toBeUndefined()
    expect(headers.cookie).toBeUndefined()
    // The caller's origin as the dispatcher reads it (request-origin.ts: a caller on this machine may only lower it).
    expect(headers['x-walnut-origin']).toBe('spoofed-by-client')
    expect(headers['content-type']).toBe('application/json')
  })

  it('the server half\'s routes win; a path none of them answers goes to the job', async () => {
    const registry = new IntegrationRegistry()
    registry.register('door', createMockPlugin({ id: 'door', apiVersion: 1, httpRoutes: [route('server half')] }))
    const t = jobRoutes(() => answer(200, 'from the job', { 'content-type': 'text/plain' }))
    const a = app(registry, t.jobs)
    await request(a).get('/api/plugins/door/status').expect(200, { value: 'server half' })
    expect(t.asked).toHaveLength(0)
    const res = await request(a).get('/api/plugins/door/queue').expect(200)
    expect(res.text).toBe('from the job')
    expect(t.asked.map((x) => x.path)).toEqual(['/queue'])
  })

  it('a plugin on its way up answers plugin_starting, and its job is not asked: the route may be its server half\'s', async () => {
    const registry = new IntegrationRegistry()
    const t = jobRoutes(() => answer(200, 'job'))
    const res = await request(app(registry, t.jobs, { starting: (id) => (id === 'door' ? { name: 'Door' } : undefined) }))
      .get('/api/plugins/door/status').expect(503)
    expect(res.body).toEqual({ error: 'plugin_starting', message: 'Door is starting. Try again in a moment.' })
    expect(res.headers['retry-after']).toBe('2')
    expect(t.asked).toHaveLength(0)
  })

  it('a HEAD goes to the job as HEAD and comes back with the length and no body', async () => {
    const registry = new IntegrationRegistry()
    const t = jobRoutes(() => answer(200, 'twelve bytes', { 'content-type': 'text/plain' }))
    const res = await request(app(registry, t.jobs)).head('/api/plugins/door/queue').expect(200)
    expect(res.headers['content-length']).toBe('12')
    expect(res.text ?? '').toBe('')
    expect(t.asked.map((x) => x.method)).toEqual(['HEAD'])
  })

  it('a plugin without a serving job is not forwarded; a replica relays to the primary instead', async () => {
    const registry = new IntegrationRegistry()
    const t = jobRoutes(() => answer(200, 'job'))
    await request(app(registry, t.jobs)).get('/api/plugins/other/queue').expect(404)
    const relay = vi.fn(async () => ({ status: 200, headers: { 'content-type': 'text/plain' }, body: Buffer.from('primary') }))
    const res = await request(app(registry, t.jobs, { relay })).get('/api/plugins/door/queue').expect(200)
    expect(res.text).toBe('primary')
    expect(t.asked).toHaveLength(0)
  })

  it('no machine to ask, or a job not running, answers 503 with the reason at once; a silent daemon is cut at the deadline', async () => {
    const registry = new IntegrationRegistry()
    const offline = jobRoutes(() => answer(200, ''), { target: { error: 'Dev box is not connected, so the job\'s routes cannot be reached' } })
    let started = Date.now()
    const off = await request(app(registry, offline.jobs)).get('/api/plugins/door/queue').expect(503)
    expect(off.body).toEqual({ error: 'Dev box is not connected, so the job\'s routes cannot be reached' })
    expect(Date.now() - started).toBeLessThan(1_000)
    const down = jobRoutes(() => ({ ok: false, error: 'the job "worker" is not running: it stopped and starts again in 4 s', errorKind: 'not_running', retryAfterS: 4 }))
    const res = await request(app(registry, down.jobs)).get('/api/plugins/door/queue').expect(503)
    expect(res.body.error).toMatch(/is not running/)
    expect(res.headers['retry-after']).toBe('4')
    const silent = jobRoutes(() => new Promise(() => {}))
    started = Date.now()
    await request(app(registry, silent.jobs)).get('/api/plugins/door/queue').expect(504)
    expect(Date.now() - started).toBeLessThan(2_000)
  })
})
