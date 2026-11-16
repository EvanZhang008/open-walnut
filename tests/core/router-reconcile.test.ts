/**
 * The router's hourly missed-arrival check (src/core/router/reconcile.ts): per bound account whose
 * source can say what it saw (`recent`), what its filter takes is compared with the area's items and
 * its ledger rows; a missing one is entered now and the router woken. The counts are written to the
 * area's report file in this test's own temp home and read back. The areas, the source, the ledger,
 * the intake and the wake are fakes that record their calls. All names are invented.
 */
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const config = vi.hoisted(() => ({ experimental: undefined as Record<string, boolean> | undefined }))
vi.mock('../../src/core/config-manager.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/config-manager.js')>()),
  getConfig: vi.fn(async () => ({ version: 1, user: { name: 'test' }, defaults: { priority: 'none' }, provider: { type: 'bedrock' }, plugins: {}, ...(config.experimental ? { experimental: config.experimental } : {}) })),
}))
import { normalizeRouterAreas, routerAreasPath, type RouterAreasFile } from '../../src/core/router/areas.js'
import {
  readReconcileReport, reconcileArea, reconcileIfDue, ROUTER_RECONCILE_BIND_MARGIN_MS, ROUTER_RECONCILE_EVERY_MS, ROUTER_RECONCILE_GRACE_MS, ROUTER_RECONCILE_WINDOW_MS,
  type RouterReconcileDeps,
} from '../../src/core/router/reconcile.js'
import { routerKey } from '../../src/core/router/store.js'
import type { RouterSource, RouterSourceKind } from '../../src/core/router/types.js'
import type { RouterRecentArrival } from '../../src/core/router/source-registry.js'

const TEAM = 'T0TEAM'
const MAILBOX = 'desk@acme.example.invalid'
const NOW = Date.UTC(2026, 10, 16, 12, 0, 0)
const slack = (message: string): RouterSource => ({ kind: 'slack', account: TEAM, message })
const seen = (message: string, labels: string[]): RouterRecentArrival => ({ source: slack(message), labels })

let home = ''
beforeEach(async () => { home = await fsp.mkdtemp(path.join(os.tmpdir(), 'router-reconcile-')); config.experimental = undefined })
afterEach(async () => { await fsp.rm(home, { recursive: true, force: true }) })

function areas(opts: { include?: string[]; open?: RouterSource[]; boundAt?: number; includeAt?: number } = {}): RouterAreasFile {
  return normalizeRouterAreas({
    version: 1,
    areas: [
      { id: 'personal', name: 'Personal', host: '__local__', taskIds: ['r-1'], sources: [{ kind: 'mail', account: MAILBOX }, { kind: 'slack', account: TEAM, ...(opts.include ? { include: opts.include } : {}), ...(opts.includeAt !== undefined ? { includeAt: opts.includeAt } : {}) }] },
      { id: 'family', name: 'Family', host: '__local__', taskIds: ['r-2'], sources: [{ kind: 'slack', account: 'T0OTHER' }] },
    ],
    routers: [{ taskId: 'r-1', areaId: 'personal', paused: false }, { taskId: 'r-2', areaId: 'family', paused: false }],
    items: [],
    openItems: (opts.open ?? []).map((source) => ({ source, areaId: 'personal', canonicalKey: routerKey(source) })),
    accountBindings: [
      { kind: 'mail', account: MAILBOX, areaId: 'personal', boundAt: 1 },
      { kind: 'slack', account: TEAM, areaId: 'personal', boundAt: opts.boundAt ?? 1 },
      { kind: 'slack', account: 'T0OTHER', areaId: 'family', boundAt: 1 },
    ],
  })
}

function fakes(file: RouterAreasFile, answer: RouterRecentArrival[] | Error, ledger: RouterSource[] = [], enterTakes = (s: readonly RouterSource[]) => [...s]) {
  const calls = { recent: [] as Array<[RouterSourceKind, string, number, number]>, lookups: [] as number[], entered: [] as RouterSource[][], kicks: [] as string[] }
  const rows = new Map(ledger.map((one) => [routerKey(one), { source: one }]))
  const deps: RouterReconcileDeps = {
    home,
    enabled: async () => true,
    now: () => NOW,
    readAreas: async () => file,
    hasRecent: (kind) => kind === 'slack',
    recent: async (kind, account, sinceMs, untilMs) => {
      calls.recent.push([kind, account, sinceMs, untilMs])
      if (answer instanceof Error) throw answer
      return answer
    },
    routesFor: async (areaId, sources) => {
      expect(areaId).toBe('personal')
      calls.lookups.push(sources.length)
      return new Map(sources.flatMap((one) => rows.has(routerKey(one)) ? [[routerKey(one), rows.get(routerKey(one))!] as const] : []))
    },
    enter: async (sources, at) => {
      expect(at).toBe(home)
      calls.entered.push([...sources])
      return enterTakes(sources)
    },
    kick: async (areaId) => { calls.kicks.push(areaId) },
  }
  return { deps, calls }
}

const reportFile = (areaId: string) => path.join(path.dirname(routerAreasPath(home)), `reconcile-${areaId}.json`)

describe('reconcileArea', () => {
  it('counts saw, filtered, had and missed; a ledger row or an area item counts as had; the missed are entered and the router woken', async () => {
    const file = areas({ include: ['dm', 'mention'], open: [slack('D1/1')] })
    const answer = [
      seen('D1/1', ['dm']), // an open item of the area
      seen('D1/2', ['mention']), // a ledger row (already routed)
      seen('D1/3', ['dm']), // missed, and the intake takes it
      seen('D1/4', ['DM']), // missed, the intake refuses it (gone from the cache)
      seen('C9/1', ['channel:random']), // left out by the filter
    ]
    const { deps, calls } = fakes(file, answer, [slack('D1/2')], (sources) => sources.filter((one) => one.message === 'D1/3'))
    const report = await reconcileArea('personal', deps)
    expect(report).toEqual({
      areaId: 'personal', at: NOW, sinceMs: NOW - ROUTER_RECONCILE_WINDOW_MS, untilMs: NOW - ROUTER_RECONCILE_GRACE_MS,
      accounts: [{ kind: 'slack', account: TEAM, saw: 4, filtered: 1, had: 2, missed: 2, entered: 1 }],
    })
    // Only this area's chat account was asked, for the window less the grace; mail has no recent.
    expect(calls.recent).toEqual([['slack', TEAM, NOW - ROUTER_RECONCILE_WINDOW_MS, NOW - ROUTER_RECONCILE_GRACE_MS]])
    expect(calls.entered).toEqual([[slack('D1/3'), slack('D1/4')]])
    expect(calls.kicks).toEqual(['personal'])
    // Kept for the router page, counts and ids only.
    expect(await readReconcileReport('personal', home)).toEqual(report)
    expect(JSON.parse(await fsp.readFile(reportFile('personal'), 'utf8'))).toEqual(report)
  })

  it('looks back no further than the binding (less its margin) or the filter\'s last change', async () => {
    const boundAt = NOW - 60 * 60_000
    const bound = fakes(areas({ boundAt }), [])
    await reconcileArea('personal', bound.deps)
    expect(bound.calls.recent[0]![2]).toBe(boundAt - ROUTER_RECONCILE_BIND_MARGIN_MS)
    // A filter changed after the binding: widening it takes the next arrivals, it never reaches back.
    const includeAt = NOW - 30 * 60_000
    const widened = fakes(areas({ boundAt, include: ['dm', 'mention'], includeAt }), [])
    await reconcileArea('personal', widened.deps)
    expect(widened.calls.recent[0]![2]).toBe(includeAt)
    // An old change or an old binding: the day's window.
    const old = fakes(areas({ boundAt: 1, includeAt: 1 }), [])
    await reconcileArea('personal', old.deps)
    expect(old.calls.recent[0]![2]).toBe(NOW - ROUTER_RECONCILE_WINDOW_MS)
  })

  it('by default enters the missed through the real intake (enterArrivals): with no router file here it enters nothing and reports no error', async () => {
    const { deps } = fakes(areas(), [seen('D1/9', ['dm'])])
    delete deps.enter
    const report = await reconcileArea('personal', deps)
    expect(report.accounts[0]).toMatchObject({ saw: 1, missed: 1, entered: 0 })
    expect(report.accounts[0]!.error).toBeUndefined()
  })

  it('nothing missed: enters nothing and wakes nothing; with no filter every arrival is counted', async () => {
    const file = areas({ open: [slack('D1/1'), slack('C9/1')] })
    const { deps, calls } = fakes(file, [seen('D1/1', ['dm']), seen('C9/1', [])])
    const report = await reconcileArea('personal', deps)
    expect(report.accounts).toEqual([{ kind: 'slack', account: TEAM, saw: 2, filtered: 0, had: 2, missed: 0, entered: 0 }])
    expect(calls.entered).toEqual([])
    expect(calls.kicks).toEqual([])
  })

  it('a missed arrival the intake refuses is counted, and the router is not woken for it', async () => {
    const { deps, calls } = fakes(areas(), [seen('D1/9', ['dm'])], [], () => [])
    expect((await reconcileArea('personal', deps)).accounts[0]).toMatchObject({ saw: 1, missed: 1, entered: 0 })
    expect(calls.kicks).toEqual([])
  })

  it('a source that cannot answer is reported as such, never as nothing missed, and the report is still written', async () => {
    const { deps, calls } = fakes(areas(), new Error(`The slack integration cannot say what arrived.${' x'.repeat(200)}`))
    const report = await reconcileArea('personal', deps)
    expect(report.accounts).toEqual([{ kind: 'slack', account: TEAM, saw: 0, filtered: 0, had: 0, missed: 0, entered: 0, error: expect.stringMatching(/^The slack integration cannot say what arrived\./) }])
    expect(report.accounts[0]!.error!.length).toBe(200)
    expect(calls.entered).toEqual([])
    expect(calls.kicks).toEqual([])
    expect(await readReconcileReport('personal', home)).toEqual(report)
  })

  it('looks up the ledger in batches of 200', async () => {
    const answer = Array.from({ length: 450 }, (_, i) => seen(`D1/${i}`, ['dm']))
    const { deps, calls } = fakes(areas(), answer, answer.map((one) => one.source))
    const report = await reconcileArea('personal', deps)
    expect(calls.lookups).toEqual([200, 200, 50])
    expect(report.accounts[0]).toMatchObject({ saw: 450, had: 450, missed: 0 })
  })

  it('an area with no account a source can count writes no report', async () => {
    const { deps, calls } = fakes(areas(), [])
    deps.hasRecent = () => false
    expect((await reconcileArea('personal', deps)).accounts).toEqual([])
    expect(calls.recent).toEqual([])
    expect(await readReconcileReport('personal', home)).toBeNull()
  })

  it('a report file of another area or of a bad shape reads as none', async () => {
    await fsp.mkdir(path.dirname(reportFile('personal')), { recursive: true })
    await fsp.writeFile(reportFile('personal'), JSON.stringify({ areaId: 'family', at: 1, sinceMs: 0, accounts: [] }))
    expect(await readReconcileReport('personal', home)).toBeNull()
    await fsp.writeFile(reportFile('personal'), JSON.stringify({ areaId: 'personal', at: 1, sinceMs: 0, accounts: 'none' }))
    expect(await readReconcileReport('personal', home)).toBeNull()
    await fsp.writeFile(reportFile('personal'), '{ not json')
    expect(await readReconcileReport('personal', home)).toBeNull()
  })
})

describe('reconcileIfDue', () => {
  async function lastAt(at: number) {
    await fsp.mkdir(path.dirname(reportFile('personal')), { recursive: true })
    await fsp.writeFile(reportFile('personal'), JSON.stringify({ areaId: 'personal', at, sinceMs: at - ROUTER_RECONCILE_WINDOW_MS, untilMs: at, accounts: [] }))
  }

  it('runs with no report yet, then skips until the last one is an hour old', async () => {
    const { deps, calls } = fakes(areas(), [])
    await reconcileIfDue('personal', deps)
    expect(calls.recent).toHaveLength(1)
    await reconcileIfDue('personal', deps)
    expect(calls.recent).toHaveLength(1)
    await lastAt(NOW - ROUTER_RECONCILE_EVERY_MS + 1)
    await reconcileIfDue('personal', deps)
    expect(calls.recent).toHaveLength(1)
    await lastAt(NOW - ROUTER_RECONCILE_EVERY_MS)
    await reconcileIfDue('personal', deps)
    expect(calls.recent).toHaveLength(2)
  })

  it('a report from the future (a clock that moved back) does not stop the check', async () => {
    const { deps, calls } = fakes(areas(), [])
    await lastAt(NOW + 10 * 60_000)
    await reconcileIfDue('personal', deps)
    expect(calls.recent).toHaveLength(1)
  })

  it('runs only when chat sources may enter: the switch given, else the intake\'s own switches', async () => {
    const off = fakes(areas(), [])
    off.deps.enabled = async () => false
    await reconcileIfDue('personal', off.deps)
    expect(off.calls.recent).toEqual([])
    expect(await readReconcileReport('personal', home)).toBeNull()

    const prior = process.env.WALNUT_MAIL_AUTO_ROUTER
    try {
      const byDefault = fakes(areas(), [])
      delete byDefault.deps.enabled
      // The automatic router switched off: no check, whatever the experiment says.
      process.env.WALNUT_MAIL_AUTO_ROUTER = '0'
      config.experimental = { router_chat_sources: true }
      await reconcileIfDue('personal', byDefault.deps)
      expect(byDefault.calls.recent).toEqual([])
      // The automatic router on, the experiment off (its default): no check.
      process.env.WALNUT_MAIL_AUTO_ROUTER = '1'
      config.experimental = undefined
      await reconcileIfDue('personal', byDefault.deps)
      expect(byDefault.calls.recent).toEqual([])
      // Both on: the check runs.
      config.experimental = { router_chat_sources: true }
      await reconcileIfDue('personal', byDefault.deps)
      expect(byDefault.calls.recent).toHaveLength(1)
    } finally {
      if (prior === undefined) delete process.env.WALNUT_MAIL_AUTO_ROUTER; else process.env.WALNUT_MAIL_AUTO_ROUTER = prior
    }
  })

  it('does nothing for an area with no countable account', async () => {
    const { deps, calls } = fakes(areas(), [])
    deps.hasRecent = () => false
    await reconcileIfDue('personal', deps)
    expect(calls.recent).toEqual([])
  })

  it('never throws, and runs one check at a time per area', async () => {
    const { deps, calls } = fakes(areas(), [])
    let release = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    deps.recent = async (kind, account, sinceMs, untilMs) => { calls.recent.push([kind, account, sinceMs, untilMs]); await gate; return [] }
    const both = Promise.all([reconcileIfDue('personal', deps), reconcileIfDue('personal', deps)])
    await new Promise((resolve) => setTimeout(resolve, 50))
    release()
    await both
    expect(calls.recent).toHaveLength(1)

    const broken = fakes(areas(), []).deps
    broken.readAreas = async () => { throw new Error('areas unreadable') }
    await expect(reconcileIfDue('family', broken)).resolves.toBeUndefined()
  })
})
