/**
 * A route watch target is the route its server records the requests under
 * (src/core/usage-watch/route-target.ts).
 *
 * 2026-11-27: watches ended "No use" on routes in daily use: `route:GET /api/sessions/:id/history` read 0
 * uses while `GET /api/sessions/:sessionId/history` served 5,687 requests in four days, and
 * `route:GET /api/v1/org/avatars/:id.png` 0 while `.../:file` served 192. Real use counted them; the
 * verdict matched names letter for letter. Pinned:
 *   - a target is judged, reported and rung as the route the router serves its path with, whatever its
 *     parameters are named, with no router too (parameter names left out);
 *   - a literal part only a parameter route takes names no route; one a later route serves names it;
 *   - set refuses a target no route serves, naming the routes recorded lately, and keeps the name the
 *     server records;
 *   - a watch that ended short on such a target is judged again, quietly.
 * The same against the real app's router: tests/e2e/usage-watch-route-targets.test.ts.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { _resetUsageRecorderForTesting, answeredTemplates, flushUsage, recordHttp } from '../../../src/core/usage-watch/record.js'
import { closeUsageWatchStore, setUsageWatchFile } from '../../../src/core/usage-watch/store.js'
import { getWatch, judgeWatch, newWatch, putWatch, rejudgeEnded, targetCovers, type Watch } from '../../../src/core/usage-watch/watches.js'
import { _resetRouteTargetsForTesting, routeShape, servedRouteName } from '../../../src/core/usage-watch/route-target.js'
import { runUsageWatchAction } from '../../../src/core/usage-watch/actions.js'
import { rejudgeEndedWatches, routeDeps, stopRealUse } from '../../../src/core/usage-watch/runtime.js'

const T0 = Date.parse('2026-11-25T10:00:00Z')
const H = 3_600_000
let dir = ''

/** A router of these routes, in this order, as Express matches them (web/route-template-of.ts). */
const ROUTES = [
  'GET /api/sessions/:sessionId/history',
  'GET /api/sessions/:sessionId',
  'GET /api/v1/org/avatars/:file',
  'DELETE /api/v1/notes/*path',
  // A parameter route that hands `enriched` on to the route of its own (task-v1.ts).
  'GET /api/v1/tasks/:id',
  'GET /api/v1/tasks/enriched',
]
function routes(method: string, url: string): string[] {
  const p = url.split('?')[0]!
  return ROUTES.filter((r) => {
    const [m, t] = r.split(' ') as [string, string]
    return m === method && new RegExp(`^${t.split('/').map((s) => (s.startsWith(':') ? '[^/]+' : s.startsWith('*') ? '.+' : s)).join('/')}$`).test(p)
  })
}
const router = (method: string, url: string): string | null => routes(method, url)[0] ?? null

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'route-target-'))
  setUsageWatchFile(path.join(dir, 'usage-watch.sqlite'))
  _resetUsageRecorderForTesting(true)
  _resetRouteTargetsForTesting()
  answeredTemplates.resolveWith(router, routes)
})

afterEach(() => {
  answeredTemplates.resolveWith(null)
  _resetRouteTargetsForTesting()
  stopRealUse()
  closeUsageWatchStore()
  setUsageWatchFile(null)
  _resetUsageRecorderForTesting(false)
  fs.rmSync(dir, { recursive: true, force: true })
})

/** Five hours recorded, minute by minute, the history route read `n` times in the second. */
function live(n = 30): void {
  for (let m = 0; m < 5 * 60; m++) {
    const at = T0 + m * 60_000
    if (m >= 60 && m < 60 + n) recordHttp({ method: 'GET', template: '/api/sessions/:sessionId/history', status: 200, ms: 40, waits: false, now: at })
    if (m === 70) recordHttp({ method: 'GET', template: '/api/v1/org/avatars/:file', status: 200, ms: 5, waits: false, now: at })
    flushUsage(at)
  }
}

const watchOf = (targets: string[], checks = {}) => newWatch({ taskId: 't1', targets, checks, who: 'this task', checkAt: T0 + 5 * H, createdAt: T0 })

describe('a route target is the route its server records', () => {
  it('reads the route the router serves its path with, whatever its parameters are named', () => {
    expect(servedRouteName('GET /api/sessions/:id/history')).toBe('GET /api/sessions/:sessionId/history')
    expect(servedRouteName('GET /api/v1/org/avatars/:id.png')).toBe('GET /api/v1/org/avatars/:file')
    expect(servedRouteName('DELETE /api/v1/notes/*rest')).toBe('DELETE /api/v1/notes/*path')
    expect(servedRouteName('GET /api/sessions/:sessionId/history')).toBe('GET /api/sessions/:sessionId/history')
    // A literal part a parameter route catches is no route of its own.
    expect(servedRouteName('GET /api/sessions/working-dirs')).toBeNull()
    expect(servedRouteName('GET /api/nothing/here')).toBeNull()
    expect(servedRouteName('POST /api/sessions/:id/history')).toBeNull()
    // A literal part a parameter route hands on is the later route's own.
    expect(servedRouteName('GET /api/v1/tasks/enriched')).toBe('GET /api/v1/tasks/enriched')
    expect(servedRouteName('GET /api/v1/tasks/:taskId')).toBe('GET /api/v1/tasks/:id')
    // A splat takes the rest of the path, as Express serves it.
    expect(servedRouteName('DELETE /api/v1/notes/attachment/*path')).toBe('DELETE /api/v1/notes/*path')
    // With no method: a route when any method serves its path, named by its path.
    expect(servedRouteName('/api/sessions/:id/history')).toBe('/api/sessions/:id/history')
    expect(servedRouteName('/api/nothing/here')).toBeNull()
  })

  it('judges, reports and rings it under that name; with no router, parameter names are left out', () => {
    live()
    const v = judgeWatch(watchOf(['route:GET /api/sessions/:id/history']), T0 + 5 * H)
    expect(v.state).toBe('passed')
    expect(v.results[0]).toMatchObject({ target: 'route:GET /api/sessions/:id/history', uses: 30 })
    expect(targetCovers('route:GET /api/v1/org/avatars/:id.png', 'http', 'GET /api/v1/org/avatars/:file')).toBe(true)
    expect(targetCovers('route:GET /api/sessions/working-dirs', 'http', 'GET /api/sessions/:sessionId')).toBe(false)
    answeredTemplates.resolveWith(null)
    _resetRouteTargetsForTesting()
    expect(targetCovers('route:GET /api/sessions/:id/history', 'http', 'GET /api/sessions/:sessionId/history')).toBe(true)
    expect(targetCovers('route:GET /api/sessions/working-dirs', 'http', 'GET /api/sessions/:sessionId')).toBe(false)
    expect(routeShape('/api/sessions/:sessionId/history')).toBe(routeShape('/api/sessions/:id/history'))
  })

  it('set refuses a target no route serves, naming the routes recorded lately, and keeps the recorded name', async () => {
    live()
    const ctx = { callerTask: 't1', taskInfo: async (id: string) => ({ id, title: id, complete: false }), now: T0 + 5 * H }
    const bad = runUsageWatchAction({ action: 'set', targets: ['route:GET /api/sessions/:id/historyy'] }, ctx)
    await expect(bad).rejects.toMatchObject({ code: 'bad_target' })
    await expect(bad).rejects.toThrow(/no route this server serves.*recorded lately: route:GET \/api\/sessions\/:sessionId\/history/)
    const ok = await runUsageWatchAction({ action: 'set', targets: ['route:GET /api/sessions/:id/history', 'route:GET /api/v1/org/avatars/:id.png', 'op:task_get'] }, ctx) as { watch: { id: string; targets: string[] }; outcome: string }
    expect(ok.watch.targets).toEqual(['route:GET /api/sessions/:sessionId/history', 'route:GET /api/v1/org/avatars/:file', 'op:task_get'])
    expect(ok.outcome).toContain('route:GET /api/sessions/:id/history is recorded as route:GET /api/sessions/:sessionId/history')
    // A target with no method is kept as written when a method serves it, refused when none does.
    const any = await runUsageWatchAction({ action: 'set', targets: ['route:/api/sessions/:id/history'] }, ctx) as { watch: { targets: string[] } }
    expect(any.watch.targets).toEqual(['route:/api/sessions/:id/history'])
    await expect(runUsageWatchAction({ action: 'set', targets: ['route:/api/nothing/here'] }, ctx)).rejects.toMatchObject({ code: 'bad_target' })
    // No router to ask (a replica, a test): taken as written, judged with its parameter names left out.
    answeredTemplates.resolveWith(null)
    _resetRouteTargetsForTesting()
    const kept = await runUsageWatchAction({ action: 'set', targets: ['route:GET /api/x/:id'] }, ctx) as { watch: { targets: string[] } }
    expect(kept.watch.targets).toEqual(['route:GET /api/x/:id'])
  })
})

describe('a watch that ended short on a route target of no use', () => {
  const short = (targets: string[]): Watch => ({
    ...watchOf(targets), state: 'too_little_use', checkedAt: T0 + 5 * H + 60_000,
    result: targets.map((target) => ({ target, uses: 0, ok: true, notes: [] })),
  })

  it('is judged again by the route its server records, quietly', async () => {
    live()
    const again = rejudgeEnded(short(['route:GET /api/sessions/:id/history']))
    expect(again).toMatchObject({ state: 'passed', results: [expect.objectContaining({ uses: 30 })] })
    // Still short where it was: none is kept.
    expect(rejudgeEnded(short(['route:GET /api/nothing/here']))).toMatchObject({ state: 'too_little_use' })
    // A route no client called may be one only Walnut's tools call: the verdict says where those count.
    expect(rejudgeEnded(short(['route:GET /api/nothing/here']))?.summary).toContain('calls a Walnut tool makes count under its op:<tool>')
    const told: string[] = []
    const saved = { ...routeDeps }
    Object.assign(routeDeps, { enabled: async () => true, deliver: async (to: string) => { told.push(to); return { ok: true } } })
    try {
      const w = short(['route:GET /api/sessions/:id/history'])
      putWatch(w)
      await rejudgeEndedWatches(T0 + 6 * H)
      expect(getWatch(w.id)).toMatchObject({ state: 'passed', result: [expect.objectContaining({ uses: 30 })] })
      expect(told).toEqual([])
    } finally {
      Object.assign(routeDeps, saved)
    }
  })
})
