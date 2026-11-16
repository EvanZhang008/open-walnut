/**
 * A failed request is logged, never carded by itself. 2026-11-16: a draft save that waited
 * on a busy file showed the user a red `PUT /api/drafts → 500` card with the raw answer
 * (its lock path and stack); the user: "only error useful to customer". A request nobody
 * clicked is retried by the browser (web/src/api/background-retry.ts); an action the person
 * took says what it lost where they took it.
 *
 * The class: every writer of a request's failure. The app's errorHandler and requestLogger
 * (driven here through express with the real notification bridge), and every router's own
 * error funnel (read from the source, so a new router that logs its own error card fails).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-route-log-only-'))
process.env.OPEN_WALNUT_HOME = testHome

const express = (await import('express')).default
const request = (await import('supertest')).default
const { requestLogger } = await import('../../src/web/middleware/request-logger.js')
const { errorHandler } = await import('../../src/web/middleware/error-handler.js')
const { logRouteError } = await import('../../src/web/routes/route-error-log.js')
const { installLogErrorNotifications, uninstallLogErrorNotifications } = await import('../../src/core/notifications/log-error-bridge.js')
const { listNotifications } = await import('../../src/core/notifications/store.js')
const { createSubsystemLogger } = await import('../../src/logging/index.js')

beforeAll(() => { installLogErrorNotifications() })
afterAll(() => { uninstallLogErrorNotifications(); fs.rmSync(testHome, { recursive: true, force: true }) })

function app() {
  const a = express()
  a.use(express.json())
  a.use(requestLogger)
  a.put('/api/drafts', () => { throw new Error('File lock timeout after 10000ms: /x/drafts.json.lock') })
  a.get('/api/status/:code', (req, res) => { res.status(Number(req.params.code)).json({ error: 'down' }) })
  const router = express.Router()
  router.get('/boom', () => { throw new Error('boom inside a router') })
  router.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logRouteError(err, 'api-v1 test route error', res)
    res.status(500).json({ error: { code: 'internal' } })
  })
  a.use('/api/v1/test', router)
  a.use(errorHandler)
  return a
}

describe('a failed request is logged, never carded', () => {
  it('a thrown 500, every 5xx a route answers, and a router funnel raise no card; another error still does', async () => {
    const server = app()
    expect((await request(server).put('/api/drafts').send({ drafts: {} })).status).toBe(500)
    for (const code of [500, 502, 503, 504, 507, 599]) expect((await request(server).get(`/api/status/${code}`)).status).toBe(code)
    expect((await request(server).get('/api/v1/test/boom')).status).toBe(500)
    createSubsystemLogger('route-log-only').error('Sentinel failure')
    let feed: Awaited<ReturnType<typeof listNotifications>>['feed'] = []
    for (let i = 0; i < 200 && !feed.some((n) => n.title === 'Sentinel failure'); i++) {
      await new Promise((r) => setTimeout(r, 25))
      feed = (await listNotifications()).feed
    }
    expect(feed.map((n) => n.title)).toEqual(['Sentinel failure'])
  })
})

describe('every router error funnel logs through logRouteError', () => {
  const ROUTES = path.resolve(__dirname, '../../src/web/routes')
  const funnels = fs.readdirSync(ROUTES).filter((f) => f.endsWith('.ts')).flatMap((file) => {
    const text = fs.readFileSync(path.join(ROUTES, file), 'utf8')
    return [...text.matchAll(/\.use\(\(err: unknown[^\n]*\n/g)].map((m) => {
      const end = text.indexOf('\n})', m.index! + m[0].length)
      return { file, body: text.slice(m.index!, end) }
    })
  })

  it('finds the funnels (so the scan itself still works)', () => {
    expect(funnels.length).toBeGreaterThanOrEqual(18)
  })

  it.each(funnels.map((f) => [f.file, f] as const))('%s: no error line of its own', (_file, funnel) => {
    expect(funnel.body).not.toMatch(/log\.\w+\.(error|fatal)\(/)
  })
})
