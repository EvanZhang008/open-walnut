/**
 * A page watch target is judged by the page's visits (src/core/usage-watch/page-uses.ts).
 *
 * 2026-11-25: every `page:` target of every watch read 0 uses and passed (31 watches in two days):
 * real use counted only a page's errors as its uses, never the visits Settings › Page use counted
 * (page:home had 29 that day), and a page target was exempt from the least use a verdict needs.
 * Pinned:
 *   - a visit Page use counts is a use of its page, by the hour, kept apart from the hours an older
 *     version reads (it would take them for page errors);
 *   - an error thrown on a page fails it, by the page its line came from; a request that went wrong on
 *     its way does not;
 *   - no target of any kind passes with no use, whatever its min_uses: "No use, cannot judge";
 *   - a page target names a place whose visits are counted, or the watch is refused;
 *   - every part counted in web/src is in PAGE_PARTS and the other way round, and every page of the
 *     app's own routes and apps is in CORE_PAGE_KEYS (a new one fails here);
 *   - a watch that passed on a page target of no use is judged again, quietly, by Page use's days.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _resetUsageRecorderForTesting, flushUsage } from '../../../src/core/usage-watch/record.js'
import { closeUsageWatchStore, readHours, setUsageWatchFile } from '../../../src/core/usage-watch/store.js'
import { TARGET_RE, getWatch, judgeWatch, newWatch, putWatch, rejudgeEnded, type Watch } from '../../../src/core/usage-watch/watches.js'
import { pageTargetProblem } from '../../../src/core/usage-watch/page-uses.js'
import { recordPageLine } from '../../../src/core/usage-watch/page-record.js'
import { flushVisitsNow, recordVisits, setPageVisitsFileForTesting } from '../../../src/core/page-visits.js'
import { CORE_PAGE_KEYS, PAGE_ALIASES, PAGE_PARTS, pageKeyForPath, visitKeyOfTarget } from '../../../src/core/page-places.js'
import { isPlaceKey } from '../../../src/core/usage-watch/page-uses.js'
import { runUsageWatchAction } from '../../../src/core/usage-watch/actions.js'
import { rejudgeEndedWatches, routeDeps, stopRealUse } from '../../../src/core/usage-watch/runtime.js'

const T0 = Date.parse('2026-11-25T10:00:00Z')
const H = 3_600_000
const ROOT = path.resolve(__dirname, '../../..')
let dir = ''

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'page-uses-'))
  setUsageWatchFile(path.join(dir, 'usage-watch.sqlite'))
  setPageVisitsFileForTesting(path.join(dir, 'page-visits.json'))
  _resetUsageRecorderForTesting(true)
})

afterEach(() => {
  vi.useRealTimers()
  stopRealUse()
  closeUsageWatchStore()
  setUsageWatchFile(null)
  setPageVisitsFileForTesting(null)
  _resetUsageRecorderForTesting(false)
  fs.rmSync(dir, { recursive: true, force: true })
})

/** Five hours recorded, minute by minute. */
function live(): void {
  for (let m = 0; m < 5 * 60; m++) flushUsage(T0 + m * 60_000)
}

const watchOf = (targets: string[], checks = {}) => newWatch({ taskId: 't1', targets, checks, who: 'this task', checkAt: T0 + 5 * H, createdAt: T0 })

describe('a page\'s uses are its visits', () => {
  it('page:home opened through Page use passes on its visits; a page nobody opened never passes', async () => {
    for (let i = 0; i < 29; i++) await recordVisits(['page:home'], new Date(T0 + H + i * 60_000))
    await recordVisits(['part:session-panel'], new Date(T0 + 2 * H))
    live()
    const used = judgeWatch(watchOf(['page:home', 'page:session-panel']), T0 + 5 * H)
    expect(used.state).toBe('passed')
    expect(used.summary).toContain('page:home: 29 uses')
    expect(used.summary).toContain('page:session-panel: 1 use')
    const some = watchOf(['page:home', 'page:org'])
    const first = judgeWatch(some, T0 + 5 * H)
    expect(first.state).toBe('extended')
    expect(first.summary).toBe('No use, cannot judge so far, checked again: page:org: 0 uses (needs 1)')
    const final = judgeWatch({ ...some, extended: true }, T0 + 5 * H)
    expect(final).toMatchObject({ state: 'too_little_use', summary: 'No use, cannot judge: page:org: 0 uses (needs 1)' })
    // Kept apart from the hours: an older version reading them never takes a visit for a page error.
    expect(readHours(T0).filter((r) => r.kind === 'page')).toEqual([])
  })

  it('an error thrown on the page fails it, by the page its line came from; a request lost on its way does not', async () => {
    // A page's log line is recorded at its arrival.
    vi.useFakeTimers({ now: T0 + H, toFake: ['Date'] })
    for (let i = 0; i < 5; i++) await recordVisits(['page:home'], new Date(T0 + H + i))
    recordPageLine('[api] GET /api/sessions/abc/supervision FAILED after 5ms', 'TypeError: Load failed', 1, '/')
    recordPageLine('[uncaught] TypeError: x is undefined', 'at f (http://127.0.0.1/assets/Org-1a2b.js:1:2)', 1, '/org')
    live()
    expect(judgeWatch(watchOf(['page:home']), T0 + 5 * H).state).toBe('passed')
    recordPageLine('[uncaught] TypeError: y is undefined', 'at g (http://127.0.0.1/assets/index-9f8e.js:1:2)', 2, '/?task=abc')
    flushUsage(T0 + 2 * H)
    const v = judgeWatch(watchOf(['page:home']), T0 + 5 * H)
    expect(v.state).toBe('failed')
    expect(v.summary).toBe('Failed: page:home: 5 uses, 2 page errors')
  })
})

describe('no target passes with no use', () => {
  // One example per target kind the watch takes (TARGET_RE): a new kind fails here until it has one.
  const EXAMPLES: Record<string, string> = { op: 'op:task_get', route: 'route:GET /api/tasks/:id', page: 'page:home' }

  it('whatever its min_uses, of every kind', () => {
    const kinds = [...TARGET_RE.source.matchAll(/(?:\^\(|\|)([a-z]+):/g)].map((m) => m[1]!)
    expect(kinds.sort()).toEqual(Object.keys(EXAMPLES).sort())
    live()
    for (const [kind, target] of Object.entries(EXAMPLES)) {
      for (const min_uses of [undefined, 0, 1]) {
        const v = judgeWatch({ ...watchOf([target], min_uses === undefined ? {} : { min_uses }), extended: true }, T0 + 5 * H)
        expect(v.state, `${kind} min_uses ${min_uses}`).toBe('too_little_use')
        expect(v.summary, kind).toMatch(/^No use, cannot judge: /)
      }
    }
  })
})

describe('a page target names a place whose visits are counted', () => {
  it('refuses a name nobody counts, and takes the app\'s pages, its parts, a pane, an app and a page once opened', async () => {
    for (const t of ['page:home', 'page:session-panel', 'page:task-detail', 'page:settings:voice', 'page:app:walnut-notes~main', 'page:org']) {
      expect(pageTargetProblem(t, new Set()), t).toBeNull()
    }
    expect(visitKeyOfTarget('page:session-panel')).toBe('part:session-panel')
    expect(pageTargetProblem('page:sidebar', new Set())).toContain('is no page Walnut counts visits of')
    expect(pageTargetProblem('page:GET /api/x rejected in the page', new Set())).toContain('names no page')
    expect(pageTargetProblem('page:weather', new Set(['page:weather']))).toBeNull()
    const ctx = { callerTask: 't1', taskInfo: async (id: string) => ({ id, title: id, complete: false }), now: T0 }
    await expect(runUsageWatchAction({ action: 'set', targets: ['op:task_get', 'page:sidebar'] }, ctx)).rejects.toMatchObject({ code: 'bad_target' })
    // An app's or a plugin pane's key holds a ~ (2026-11-26 review: the target pattern refused them).
    await expect(runUsageWatchAction({ action: 'set', targets: ['page:app:walnut-notes~main', 'page:settings:mail~rules'] }, ctx)).resolves.toBeTruthy()
    // A page opened once (Page use's own record) is one a watch may name.
    await recordVisits(['page:weather'], new Date(T0))
    await expect(runUsageWatchAction({ action: 'set', targets: ['page:weather', 'page:home'] }, ctx)).resolves.toBeTruthy()
  })

  // 2026-11-26 review: a plugin's page, taken when set for the visits Page use counted, was judged as an
  // older target ("names no page Walnut counts visits of"), and its errors could count twice.
  it('a page a visit was counted for is judged, rung and reported as a place, the same as the app\'s own', async () => {
    vi.useFakeTimers({ now: T0 + H, toFake: ['Date'] })
    for (let i = 0; i < 3; i++) await recordVisits(['page:weather'], new Date(T0 + H + i))
    recordPageLine('[uncaught] TypeError: z is undefined', 'at w (http://127.0.0.1/assets/weather-1a2b.js:1:2)', 1, '/weather')
    live()
    const v = judgeWatch(watchOf(['page:weather']), T0 + 5 * H)
    expect(v.summary).toBe('Failed: page:weather: 3 uses, 1 page error')
    const ctx = { callerTask: 't1', taskInfo: async (id: string) => ({ id, title: id, complete: false }), now: T0 + 5 * H }
    const rep = await runUsageWatchAction({ action: 'report', target: 'page:weather', range: '24h' }, ctx) as { page?: unknown }
    expect(rep.page).toEqual({ visits: 3, errors: 1 })
  })

  it('every part counted in the app is listed, and every page of the app\'s own routes and apps', () => {
    const counted = new Set<string>()
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name)
        if (e.isDirectory()) walk(p)
        else if (/\.tsx?$/.test(e.name)) for (const m of fs.readFileSync(p, 'utf8').matchAll(/recordVisit\(\s*'(part:[^']+)'/g)) counted.add(m[1]!)
      }
    }
    walk(path.join(ROOT, 'web/src'))
    expect([...counted].sort()).toEqual(PAGE_PARTS.map((p) => p.key).sort())
    const app = fs.readFileSync(path.join(ROOT, 'web/src/App.tsx'), 'utf8')
    const list = fs.readFileSync(path.join(ROOT, 'web/src/apps/core-app-list.ts'), 'utf8')
    const paths = [
      ...[...app.matchAll(/<Route path="(\/[^"]*)" element=\{(?:null|<(\w+))/g)].filter((m) => !m[2] || !/^Navigate$|Redirect$/.test(m[2])).map((m) => m[1]!),
      ...[...list.matchAll(/path: '(\/[^']*)'/g)].map((m) => m[1]!),
    ].filter((p) => p !== '/open-ref')
    expect(paths.length).toBeGreaterThan(10)
    const missing = paths.map((p) => [p, pageKeyForPath(p)] as const).filter(([, k]) => k && !CORE_PAGE_KEYS.includes(k))
    expect(missing).toEqual([])
  })
})

describe('a watch that passed on a page target of no use', () => {
  const passed = (targets: string[]): Watch => ({
    ...watchOf(targets), state: 'passed', checkedAt: T0 + 5 * H + 60_000,
    result: targets.map((target) => ({ target, uses: 0, ok: true, notes: [] })),
  })

  it('is judged again by Page use\'s days, before visits were kept by the hour', () => {
    live()
    const days = { '2026-11-25': 12 }
    const again = rejudgeEnded(passed(['page:home']), { visitDays: (k) => (k === 'page:home' ? days : undefined) })
    expect(again?.state).toBe('passed')
    expect(again?.results[0]).toMatchObject({ uses: 12, byDay: 12 })
    expect(again?.summary).toContain('12 of its visits counted by the day (whole days, the day it was set included')
    expect(rejudgeEnded(passed(['page:draft-v6']), {})).toMatchObject({ state: 'too_little_use', summary: expect.stringMatching(/^No use, cannot judge: page:draft-v6: 0 uses/) })
    // One that passed with use is left.
    expect(rejudgeEnded({ ...passed(['page:home']), result: [{ target: 'page:home', uses: 3, ok: true, notes: [] }] })).toBeNull()
  })

  it('once a start, quietly: its owner heard Nothing to do, and no lead hears of every page watch', async () => {
    live()
    // Visited before real use kept visits by the hour: Page use's day alone holds it.
    _resetUsageRecorderForTesting(false)
    await recordVisits(['page:home'], new Date(T0 + H))
    await flushVisitsNow()
    const told: string[] = []
    const saved = { ...routeDeps }
    Object.assign(routeDeps, { enabled: async () => true, deliver: async (to: string) => { told.push(to); return { ok: true } } })
    try {
      const home = passed(['page:home'])
      const draft = passed(['page:draft-v6'])
      putWatch(home)
      putWatch(draft)
      await rejudgeEndedWatches(T0 + 6 * H)
      expect(getWatch(home.id)).toMatchObject({ state: 'passed', result: [expect.objectContaining({ uses: 1, byDay: 1 })] })
      expect(getWatch(draft.id)?.state).toBe('too_little_use')
      expect(told).toEqual([])
    } finally {
      Object.assign(routeDeps, saved)
    }
  })
})

// 2026-11-26, the lead: 27 watches re-judged to too_little_use named their pages the old way
// (page:task-panel, page:session, page:settings); each name that is part of one counted place reads as it.
describe('a page named the old way reads as the place it is part of', () => {
  it('every old name is one counted place, and Settings sums its panes', async () => {
    for (const [word, key] of Object.entries(PAGE_ALIASES)) {
      expect(visitKeyOfTarget(`page:${word}`), word).toBe(key)
      expect(isPlaceKey(key), word).toBe(true)
      expect(pageTargetProblem(`page:${word}`, new Set()), word).toBeNull()
    }
    expect(visitKeyOfTarget('page:settings-sessions')).toBe('settings:sessions')
    for (let i = 0; i < 4; i++) await recordVisits(['page:home'], new Date(T0 + H + i))
    await recordVisits(['settings:sessions', 'settings:usage', 'settings:sessions'], new Date(T0 + 2 * H))
    live()
    const v = judgeWatch(watchOf(['page:task-panel', 'page:settings']), T0 + 5 * H)
    expect(v.state).toBe('passed')
    expect(v.summary).toBe('Passed: page:task-panel: 4 uses, counted as page:home · page:settings: 3 uses')
  })

  it('a part judged before it was counted reads its page\'s days, and the watch that ended short on it is judged again quietly', async () => {
    live()
    const short: Watch = {
      ...watchOf(['page:session-panel', 'page:session']), state: 'too_little_use', checkedAt: T0 + 5 * H + 60_000,
      result: [{ target: 'page:session-panel', uses: 0, ok: true, notes: [] }, { target: 'page:session', uses: 0, ok: true, notes: [] }],
    }
    const again = rejudgeEnded(short, { visitDays: (k) => (k === 'page:home' ? { '2026-11-25': 7 } : undefined) })
    expect(again?.state).toBe('passed')
    expect(again?.results.map((r) => r.uses)).toEqual([7, 7])
    expect(again?.summary).toContain("counted by the day as its page's, page:home's")
    // The server's pass: Page use holds the page's day; nobody is told.
    _resetUsageRecorderForTesting(false)
    await recordVisits(['page:home'], new Date(T0 + H))
    await flushVisitsNow()
    const told: string[] = []
    const saved = { ...routeDeps }
    Object.assign(routeDeps, { enabled: async () => true, deliver: async (to: string) => { told.push(to); return { ok: true } } })
    try {
      putWatch(short)
      const nobody = { ...short, id: 'uw-nobody-0001', targets: ['page:sidebar'], result: [{ target: 'page:sidebar', uses: 0, ok: true, notes: [] }] }
      putWatch(nobody)
      await rejudgeEndedWatches(T0 + 6 * H)
      expect(getWatch(short.id)).toMatchObject({ state: 'passed', result: [expect.objectContaining({ uses: 1 }), expect.objectContaining({ uses: 1 })] })
      expect(getWatch(nobody.id)).toMatchObject({ state: 'too_little_use', result: [expect.objectContaining({ uses: 0, notes: [] })] })
      expect(told).toEqual([])
    } finally {
      Object.assign(routeDeps, saved)
    }
  })
})
