/**
 * Real use counts every request under the path its client called, on the real server.
 *
 * 2026-11-24: the page calls the calendar at `/api/calendar/events`, an alias that rewrites the
 * path for the plugin dispatcher (src/web/routes/calendar-alias.ts); the recorder named it
 * `GET /api/calendar/calendar/events`, a name no caller uses, so no watch could name it. And a
 * route whose path the recorder cannot keep as a template (a regular expression) is not counted
 * at all.
 *
 * Here the real startServer boots, its router stack is walked (tests/helpers/express-route-walk.ts),
 * and every route under /api must have a name the recorder keeps. Real requests (a plain route, a
 * route with an id, a plugin route, the calendar alias) are then counted under the path called.
 * Every file that rewrites a request's path is listed, and each has its case here.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'
import { installMountRecorder, walkRoutes, type WalkedRoute } from '../helpers/express-route-walk.js'

vi.mock('../../src/constants.js', () => createMockConstants('usage-route-names'))

installMountRecorder()

const ROOT = path.resolve(__dirname, '../..')
let stop: (() => Promise<void>) | null = null
let routes: WalkedRoute[] = []
let base = ''
let dir = ''

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-route-names-'))
  const store = await import('../../src/core/usage-watch/store.js')
  store.setUsageWatchFile(path.join(dir, 'usage-watch.sqlite'))
  const { CalendarService, _setCalendarServiceForTest } = await import('../../src/integrations/calendar/service.js')
  const { createMockCalendarSource } = await import('../helpers/mock-calendar-source.js')
  _setCalendarServiceForTest(new CalendarService(createMockCalendarSource().source))
  const server = await import('../../src/web/server.js')
  const http = await server.startServer({ port: 0, dev: true })
  stop = server.stopServer
  routes = walkRoutes(server._getAppForTesting() as unknown as Parameters<typeof walkRoutes>[0])
  const addr = http.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  const { _resetUsageRecorderForTesting } = await import('../../src/core/usage-watch/record.js')
  _resetUsageRecorderForTesting(true)
}, 120_000)

afterAll(async () => {
  const { _resetUsageRecorderForTesting } = await import('../../src/core/usage-watch/record.js')
  _resetUsageRecorderForTesting(false)
  try { await stop?.() } catch { /* already down */ }
  const store = await import('../../src/core/usage-watch/store.js')
  store.closeUsageWatchStore()
  store.setUsageWatchFile(null)
  fs.rmSync(dir, { recursive: true, force: true })
}, 60_000)

describe('real use names a request by the path its client called', () => {
  it('every route under /api has a name the recorder keeps', async () => {
    const { registeredTemplate } = await import('../../src/core/usage-watch/normalize.js')
    const api = routes.filter((r) => r.path.startsWith('/api/'))
    expect(api.length).toBeGreaterThan(300)
    expect(api.filter((r) => registeredTemplate('', r.path) === 'unmatched').map((r) => `${r.method} ${r.path}`)).toEqual([])
  })

  // A route registered with a list of paths gives `req.route.path` as that list (2026-11-24: the six
  // liveness addresses of routes/system.ts were never counted). Each is named by the path it matched.
  it('a route registered with a list of paths is counted under the path called', async () => {
    const several = routes.filter((r) => r.path.startsWith('/api/') && r.several)
    expect(several.length).toBeGreaterThan(0)
    // Only plain reads are called here: a new list route of another kind needs its own case.
    expect(several.filter((r) => r.method !== 'GET' || r.path.includes(':')).map((r) => `${r.method} ${r.path}`)).toEqual([])
    for (const r of several) await fetch(`${base}${r.path}`).then((x) => x.arrayBuffer())
    const { flushUsage } = await import('../../src/core/usage-watch/record.js')
    const { readHours } = await import('../../src/core/usage-watch/store.js')
    await vi.waitFor(() => {
      flushUsage(Date.now())
      const names = new Set(readHours(0, { kind: 'http' }).map((x) => x.name))
      for (const r of several) expect(names, r.path).toContain(`GET ${r.path}`)
    }, { timeout: 10_000 })
  })

  it('a plain route, one with an id, a plugin route and the calendar alias are counted under the path called', async () => {
    const calls: Array<[string, string]> = [
      ['/api/v1/tasks', 'GET /api/v1/tasks'],
      ['/api/v1/tasks/mtaskaaa-0001', 'GET /api/v1/tasks/:id'],
      ['/api/calendar/events?from=2026-08-03&to=2026-08-09', 'GET /api/calendar/events'],
      ['/api/plugins/calendar/events?from=2026-08-03&to=2026-08-09', 'GET /api/plugins/calendar/events'],
    ]
    for (const [url] of calls) await fetch(`${base}${url}`).then((r) => r.arrayBuffer())
    const { flushUsage } = await import('../../src/core/usage-watch/record.js')
    const { readHours } = await import('../../src/core/usage-watch/store.js')
    // `finish` can come just after the client has its answer: wait for the four, not a clock.
    await vi.waitFor(() => {
      flushUsage(Date.now())
      const names = new Set(readHours(0, { kind: 'http' }).map((r) => r.name))
      for (const [, name] of calls) expect(names, name).toContain(name)
    }, { timeout: 10_000 })
    const names = readHours(0, { kind: 'http' }).map((r) => r.name)
    expect(names.filter((n) => n.includes('/calendar/calendar'))).toEqual([])
  })

  it('every file that rewrites a request\'s path has its case above', () => {
    // A rewrite makes the routers' path differ from the called one (normalize.ts publicTemplate).
    const out: string[] = []
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name)
        if (e.isDirectory()) walk(p)
        // `req.url =`, `(req as X).url =`, `req['url'] =`.
        else if (/\.ts$/.test(e.name) && /\b(?:req|request)\b[^;\n=]{0,40}?(?:\.url|\[\s*['"]url['"]\s*\])\s*=(?!=)/.test(fs.readFileSync(p, 'utf8'))) out.push(path.relative(ROOT, p))
      }
    }
    walk(path.join(ROOT, 'src'))
    expect(out.sort()).toEqual(['src/web/routes/calendar-alias.ts'])
  })
})
