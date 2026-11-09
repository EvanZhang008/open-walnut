// Legacy watcher migration (src/core/router/migration.ts): real areas file and record in a temp home; fake ledger, watcher host and cache. All names are invented.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-router-migration'))

import { activeRouter, normalizeRouterAreas, readRouterAreas, updateRouterAreas } from '../../src/core/router/areas.js'
import { cronJobRevision } from '../../src/core/cron/job-revision.js'
import {
  defaultLegacyMigrationDeps, legacyMigrationPath, migrateLegacyMonitor, sha,
  type LegacyMigrationDeps, type LegacyReceiptStore, type MigrationTask, type WatcherConfig,
} from '../../src/core/router/migration.js'
import { RouteLockBusyError, withAreaRouteLock } from '../../src/core/router/route-lock.js'
import { routerKey } from '../../src/core/router/store.js'
import type { RouterRoute, RouterSource } from '../../src/core/router/types.js'
import { pendingSources } from '../../src/core/router/wake.js'
import { seedTaskStore } from '../helpers/router-task-store.js'

const ACCOUNT = 'desk@marina.example.invalid'
const AREA = 'personal'
const ROUTER = 'router-task-1'
const OWNER = 'owner-dock'
const WATCHER = 'watch-dock-mail'
const OTHER_WATCHER = 'watch-unrelated'
const REVISION = 'a'.repeat(64)
const DUE = Date.UTC(2026, 10, 15, 17)
const mail = (message: string, version: string | undefined = 'delivery-1'): RouterSource =>
  ({ kind: 'mail', account: ACCOUNT, message, ...(version === undefined ? {} : { version }) })
const sameSource = (a: RouterSource, b: RouterSource) => a.kind === b.kind && a.account === b.account && a.message === b.message
  && (a.version ?? '') === (b.version ?? '')

let home: string

function spec(extra: Record<string, unknown> = {}) {
  return {
    id: 'dock-mail-1', areaId: AREA, routerTaskId: ROUTER, watcherId: WATCHER, dateItems: 'none',
    items: [
      { source: mail('INBOX:1'), taskId: OWNER, reason: 'The legacy watcher handed it to the dock task.', evidence: 'watch fire 4', at: 1000 },
      { source: mail('INBOX:2'), taskId: OWNER, reason: 'The legacy watcher handed it to the dock task.', evidence: 'watch fire 5', at: 2000 },
    ],
    ...extra,
  }
}

function routine(id: string, extra: WatcherConfig = {}): WatcherConfig {
  return {
    id, name: `Watch ${id}`, enabled: true, createdAtMs: 1, updatedAtMs: 1,
    schedule: { kind: 'every', everyMs: 300_000 },
    check: { run: `walnut trigger-check fixture:new-mail '{"from":"marina"}'`, host: '__local__' },
    executor: { type: 'session', config: { target: OWNER } },
    ...extra,
  }
}

function world() {
  const events: string[] = []
  const rows = new Map<string, RouterRoute>()
  const stale = new Set<string>()
  const fail: Record<string, Error | undefined> = {}
  const hooks: { beforePause?: () => void; afterPause?: () => void; beforeRouterPause?: () => void | Promise<void>; readAreas?: () => void; readWatcher?: () => void } = {}
  const clock = { now: 1_800_000_000_000, seenUntil: 1_800_000_000_000 + 86_400_000 }
  const rules = new Map<string, string>()
  const tasks = new Map<string, MigrationTask>([
    [ROUTER, { id: ROUTER, phase: 'IN_PROGRESS', source: 'local', org_role: 'router', router_area_id: AREA, router_paused: true } as MigrationTask],
    [OWNER, { id: OWNER, phase: 'TODO', source: 'local' } as MigrationTask],
  ])
  const watchers = new Map<string, { config: WatcherConfig; state: unknown }>([
    [WATCHER, { config: routine(WATCHER), state: { cursor: 'uid:42', seen: { 'msg-1': 1000, 'msg-2': 2000 }, pendingFires: [] } }],
    [OTHER_WATCHER, { config: routine(OTHER_WATCHER), state: { cursor: 'uid:7', seen: {}, pendingFires: [] } }],
  ])
  const once = (name: string) => {
    const error = fail[name]
    if (error) { fail[name] = undefined; throw error }
  }
  const changed = () => Object.assign(new Error('The routine changed elsewhere.'), { code: 'routine_changed' })
  const setRouterPaused = async (paused: boolean) => {
    await updateRouterAreas(home, (file) => ({ ...file, routers: file.routers.map((one) => one.taskId === ROUTER ? { ...one, paused } : one) }))
    tasks.set(ROUTER, { ...tasks.get(ROUTER)!, router_paused: paused })
  }
  const store: LegacyReceiptStore = {
    async recordLegacy(item, receipt) {
      events.push(`receipt:${item.source.message}`)
      const existing = rows.get(item.key)
      if (existing) return { fresh: false, route: structuredClone(existing) }
      const route: RouterRoute = {
        areaId: AREA, key: item.key, source: { ...item.source }, sender: item.sender, subject: item.subject, status: 'routed',
        taskId: receipt.taskId, reason: receipt.reason, at: receipt.at, evidence: receipt.evidence, origin: 'legacy',
      }
      rows.set(item.key, route)
      return { fresh: true, route: structuredClone(route) }
    },
    async getSources(sources) {
      const found = new Map<string, RouterRoute>()
      for (const source of sources) {
        const row = [...rows.values()].find((one) => sameSource(one.source, source))
        if (row) found.set(routerKey(source), structuredClone(row))
      }
      return found
    },
    async hasRouterDecisions() { return [...rows.values()].some((one) => one.origin !== 'legacy') },
  }
  const deps: LegacyMigrationDeps = {
    home,
    now: () => clock.now,
    deadlineMs: 1000,
    async readAreas() { hooks.readAreas?.(); return await readRouterAreas(home) },
    async updateAreas(change) {
      once('updateAreas')
      events.push('areas')
      return await updateRouterAreas(home, change)
    },
    store: async () => store,
    async resolve(source) {
      return { source: { ...source }, key: `rfc:${source.message}`, scopeKey: `<${source.message}@marina.example.invalid>`,
        sender: 'pat@marina.example.invalid', subject: 'Dock schedule' }
    },
    async current(sources) { return sources.filter((one) => !stale.has(one.message)) },
    async getTask(taskId) { return tasks.get(taskId) ?? null },
    async readWatcher(id) {
      if (id === WATCHER) hooks.readWatcher?.()
      const one = watchers.get(id)
      return one ? structuredClone(one.config) : null
    },
    async snapshotWatcher(id) {
      once('snapshotWatcher')
      events.push(`snapshot:${id}`)
      const one = watchers.get(id)
      if (!one) return { supported: false, reason: 'gone' }
      return { supported: true, complete: true, frozen: one.config.enabled === false, config: structuredClone(one.config),
        state: structuredClone(one.state), seenReliableUntil: clock.seenUntil }
    },
    async pauseWatcher(id, expectedRevision) {
      hooks.beforePause?.()
      events.push(`pause-watcher:${id}`)
      const one = watchers.get(id)!
      if (cronJobRevision(one.config) !== expectedRevision) throw changed()
      one.config.enabled = false
      one.config.updatedAtMs = clock.now
      hooks.afterPause?.()
      return structuredClone(one.config)
    },
    async restoreWatcher(id, expected, backup) {
      once('restoreWatcher')
      events.push(`restore-watcher:${id}`)
      const one = watchers.get(id)!
      if (cronJobRevision(one.config) !== expected.revision || sha(one.state) !== expected.stateSha) throw changed()
      one.config.enabled = backup.config.enabled
      one.config.updatedAtMs = clock.now
    },
    async resumeRouter(taskId) {
      once('resumeRouter')
      events.push(`resume-router:${taskId}`)
      await setRouterPaused(false)
    },
    async pauseRouter(taskId) {
      await hooks.beforeRouterPause?.()
      events.push(`pause-router:${taskId}`)
      await setRouterPaused(true)
    },
    async ruleRevision(ruleId) { return rules.get(ruleId) },
  }
  return {
    events, rows, stale, fail, hooks, clock, rules, tasks, watchers, store, deps, setRouterPaused,
    count: (event: string) => events.filter((one) => one === event).length,
  }
}

async function codeOf(work: Promise<unknown> | (() => unknown)): Promise<string | undefined> {
  try {
    await (typeof work === 'function' ? work() : work)
    return undefined
  } catch (error) {
    return (error as { code?: string }).code ?? (error instanceof Error ? error.message : String(error))
  }
}

async function pending(w: ReturnType<typeof world>): Promise<RouterSource[]> {
  const file = await readRouterAreas(home)
  return pendingSources(file, file.areas[0]!, { routesFor: (_area, sources) => w.store.getSources(sources), currentSources: async (sources) => [...sources] })
}

const routerActive = async () => activeRouter(await readRouterAreas(home), AREA)?.taskId

/** A row the router itself wrote for a new item, which the legacy watcher's seen set never heard of. */
function routerDecision(w: ReturnType<typeof world>, message: string, status: RouterRoute['status']): void {
  w.rows.set(`rfc:${message}`, {
    areaId: AREA, key: `rfc:${message}`, source: mail(message), sender: 'pat@marina.example.invalid', subject: 'Crew rota',
    status, ...(status === 'not_routed' ? {} : { taskId: OWNER, messageId: `qm-route-${message}` }), reason: 'Routed by the router.', at: 9000,
  })
}

/** Fails the first `n` calls, then lets them through. */
function failing(n: number, message: string): () => void {
  let left = n
  return () => { if (left > 0) { left--; throw new Error(message) } }
}

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'router-migration-'))
  seedTaskStore(home)
  await updateRouterAreas(home, () => normalizeRouterAreas({
    version: 1,
    areas: [{ id: AREA, name: 'Personal', host: '__local__', taskIds: [ROUTER], sources: [{ kind: 'mail', account: ACCOUNT }] }],
    routers: [{ taskId: ROUTER, areaId: AREA, paused: true }],
    items: [],
  }))
})

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true })
})

describe('prepare', () => {
  it('records every receipt before the items join the area, and reads no host state', async () => {
    const w = world()
    const result = await migrateLegacyMonitor(spec(), w.deps).prepare()
    expect(w.events).toEqual(['receipt:INBOX:1', 'receipt:INBOX:2', 'areas'])
    expect(result.record).toMatchObject({ phase: 'prepared', capture: 'pending', initial: { config: routine(WATCHER), enabled: true } })
    expect(result.record.final).toBeUndefined()
    const file = await readRouterAreas(home)
    expect(file.items).toEqual([
      { source: mail('INBOX:1'), areaId: AREA, canonicalKey: '<INBOX:1@marina.example.invalid>' },
      { source: mail('INBOX:2'), areaId: AREA, canonicalKey: '<INBOX:2@marina.example.invalid>' },
    ])
    expect(file.areas[0]!.taskIds).toEqual([ROUTER])
    expect(await routerActive()).toBeUndefined()
    expect(await pending(w)).toEqual([])
    expect(w.watchers.get(WATCHER)!.config.enabled).toBe(true)
    expect(fs.statSync(legacyMigrationPath(home, 'dock-mail-1')).mode & 0o777).toBe(0o600)
    expect((await migrateLegacyMonitor(spec(), w.deps).prepare()).changed).toBe(false)
    expect(w.events).toHaveLength(3)
  })

  it('an item in the area without a receipt is exactly what the router would replay', async () => {
    const w = world()
    await migrateLegacyMonitor(spec(), w.deps).prepare()
    w.rows.delete('rfc:INBOX:2')
    expect(await pending(w)).toEqual([mail('INBOX:2')])
  })

  it('a crash after the receipts and before the area write resumes with no second receipt', async () => {
    const w = world()
    w.fail.updateAreas = new Error('disk went away')
    const handle = migrateLegacyMonitor(spec(), w.deps)
    expect(await codeOf(handle.prepare())).toBe('disk went away')
    const half = await handle.read()
    expect(half).toMatchObject({ phase: 'preparing', lastError: { message: 'disk went away' } })
    expect(half?.receipts?.map((one) => one.fresh)).toEqual([true, true])
    expect((await readRouterAreas(home)).items).toEqual([])
    const done = await handle.prepare()
    expect(done.record.phase).toBe('prepared')
    expect(done.record.receipts?.map((one) => one.fresh)).toEqual([false, false])
    expect(w.rows.size).toBe(2)
    expect(await pending(w)).toEqual([])
  })

  it('refuses other input under the same id and changes nothing', async () => {
    const w = world()
    await migrateLegacyMonitor(spec(), w.deps).prepare()
    const other = spec({ items: [spec().items[0]] })
    expect(await codeOf(migrateLegacyMonitor(other, w.deps).prepare())).toBe('migration_conflict')
    expect(await codeOf(migrateLegacyMonitor(other, w.deps).activate())).toBe('migration_conflict')
    expect(w.events).toHaveLength(3)
  })

  it('refuses while the router runs, writing no record and no receipt', async () => {
    const w = world()
    await w.setRouterPaused(false)
    expect(await codeOf(migrateLegacyMonitor(spec(), w.deps).prepare())).toBe('router_active')
    expect(fs.existsSync(legacyMigrationPath(home, 'dock-mail-1'))).toBe(false)
    expect(w.rows.size).toBe(0)
  })

  it('refuses an unversioned mail item before reading anything', async () => {
    const items = [{ ...spec().items[0]!, source: { kind: 'mail', account: ACCOUNT, message: 'INBOX:1' } }]
    expect(await codeOf(() => migrateLegacyMonitor(spec({ items }), world().deps))).toBe('invalid')
  })

  it('refuses a missing legacy owner and an item the cache no longer holds as current', async () => {
    const w = world()
    w.tasks.delete(OWNER)
    expect(await codeOf(migrateLegacyMonitor(spec(), w.deps).prepare())).toBe('owner_missing')
    const v = world()
    v.stale.add('INBOX:2')
    expect(await codeOf(migrateLegacyMonitor(spec(), v.deps).prepare())).toBe('item_not_current')
    expect(w.rows.size + v.rows.size).toBe(0)
    expect((await readRouterAreas(home)).items).toEqual([])
  })

  it('a cache read that never answers stops at its deadline', async () => {
    const w = world()
    w.deps.deadlineMs = 100
    w.deps.resolve = () => new Promise(() => {})
    expect(await codeOf(migrateLegacyMonitor(spec(), w.deps).prepare())).toBe('deadline')
    expect(w.rows.size).toBe(0)
  })

  it('keeps an existing unknown ledger row exactly as it is', async () => {
    const w = world()
    const prior: RouterRoute = {
      areaId: AREA, key: 'rfc:INBOX:1', source: mail('INBOX:1'), sender: 'pat@marina.example.invalid', subject: 'Dock schedule',
      status: 'unknown', taskId: 'someone-else', reason: 'Delivery timed out.', at: 500, messageId: 'qm-route-fixture',
    }
    w.rows.set(prior.key, structuredClone(prior))
    const result = await migrateLegacyMonitor(spec(), w.deps).prepare()
    expect(w.rows.get(prior.key)).toEqual(prior)
    expect(result.record.receipts?.[0]).toEqual({ key: prior.key, fresh: false, status: 'unknown', taskId: 'someone-else', matches: false })
  })

  it('a router resumed between the check and the area write refuses the write', async () => {
    const w = world()
    const write = w.deps.updateAreas
    w.deps.updateAreas = async (change) => {
      await updateRouterAreas(home, (file) => ({ ...file, routers: file.routers.map((one) => ({ ...one, paused: false })) }))
      return await write(change)
    }
    expect(await codeOf(migrateLegacyMonitor(spec(), w.deps).prepare())).toBe('router_active')
    expect((await readRouterAreas(home)).items).toEqual([])
    expect((await migrateLegacyMonitor(spec(), w.deps).read())?.phase).toBe('preparing')
  })

  it('a default adapter for another data home cannot change this server\'s routines or router', async () => {
    const defaults = defaultLegacyMigrationDeps(home)
    expect(await defaults.snapshotWatcher(WATCHER)).toMatchObject({ supported: false, reason: expect.stringContaining('own data home') })
    expect(await codeOf(defaults.pauseWatcher(WATCHER, REVISION))).toBe('invalid')
    expect(await codeOf(defaults.restoreWatcher(WATCHER, { revision: REVISION, stateSha: REVISION }, { config: {}, state: null }))).toBe('watcher_state_unsupported')
    expect(await codeOf(defaults.resumeRouter(ROUTER))).toBe('invalid')
    expect(await codeOf(defaults.pauseRouter(ROUTER))).toBe('invalid')
  })
})

describe('activate', () => {
  it('pauses exactly the watcher by revision, captures its frozen state, then starts the router', async () => {
    const w = world()
    const handle = migrateLegacyMonitor(spec(), w.deps)
    await handle.prepare()
    const unrelated = structuredClone(w.watchers.get(OTHER_WATCHER))
    const result = await handle.activate()
    expect(w.events.slice(3)).toEqual([`pause-watcher:${WATCHER}`, `snapshot:${WATCHER}`, `resume-router:${ROUTER}`])
    expect(result.record).toMatchObject({ phase: 'active', capture: 'final' })
    expect(result.record.final?.stateSha).toBe(sha(w.watchers.get(WATCHER)!.state))
    expect(w.watchers.get(WATCHER)!.config.enabled).toBe(false)
    expect(w.watchers.get(OTHER_WATCHER)).toEqual(unrelated)
    expect(await routerActive()).toBe(ROUTER)
    expect(await pending(w)).toEqual([])
    expect((await handle.activate()).changed).toBe(false)
    expect(w.events).toHaveLength(6)
  })

  it('captures the state the watcher reached after prepare, so a rollback never runs it on an older one', async () => {
    const w = world()
    const handle = migrateLegacyMonitor(spec(), w.deps)
    await handle.prepare()
    // The watcher keeps polling until activation pauses it.
    w.watchers.get(WATCHER)!.state = { cursor: 'uid:57', seen: { 'msg-1': 1000, 'msg-2': 2000, 'msg-3': 3000 }, pendingFires: [] }
    const active = await handle.activate()
    expect(active.record.final?.state).toEqual({ cursor: 'uid:57', seen: { 'msg-1': 1000, 'msg-2': 2000, 'msg-3': 3000 }, pendingFires: [] })
    await handle.rollback()
    expect(w.watchers.get(WATCHER)).toEqual({ config: { ...routine(WATCHER), updatedAtMs: w.clock.now },
      state: { cursor: 'uid:57', seen: { 'msg-1': 1000, 'msg-2': 2000, 'msg-3': 3000 }, pendingFires: [] } })
  })

  it('a person edit racing the pause is refused by the compare-and-set and kept', async () => {
    const w = world()
    const handle = migrateLegacyMonitor(spec(), w.deps)
    await handle.prepare()
    w.hooks.beforePause = () => { w.watchers.get(WATCHER)!.config.schedule = { kind: 'every', everyMs: 60_000 } }
    expect(await codeOf(handle.activate())).toBe('routine_changed')
    expect(w.watchers.get(WATCHER)!.config).toMatchObject({ enabled: true, schedule: { everyMs: 60_000 } })
    expect(await routerActive()).toBeUndefined()
    w.hooks.beforePause = undefined
    expect(await codeOf(handle.activate())).toBe('watcher_changed')
    expect(w.watchers.get(WATCHER)!.config.enabled).toBe(true)
  })

  it('a failed capture keeps the watcher paused and the router stopped, and the retry finishes', async () => {
    const w = world()
    const handle = migrateLegacyMonitor(spec(), w.deps)
    await handle.prepare()
    w.fail.snapshotWatcher = new Error('host unreachable')
    expect(await codeOf(handle.activate())).toBe('host unreachable')
    expect(await handle.read()).toMatchObject({ phase: 'activating', capture: 'pending' })
    expect(w.watchers.get(WATCHER)!.config.enabled).toBe(false)
    expect(await routerActive()).toBeUndefined()
    // No frozen state yet: a rollback refuses to turn the watcher on, and leaves activation able to retry.
    expect(await codeOf(handle.rollback())).toBe('watcher_final_state_missing')
    expect(w.watchers.get(WATCHER)!.config.enabled).toBe(false)
    expect((await handle.read())?.phase).toBe('activating')

    expect((await handle.activate()).record.phase).toBe('active')
    expect(w.count(`pause-watcher:${WATCHER}`)).toBe(1)
  })

  it('an activation cut before the router started finishes without pausing or capturing again', async () => {
    const w = world()
    const handle = migrateLegacyMonitor(spec(), w.deps)
    await handle.prepare()
    w.fail.resumeRouter = new Error('router edit failed')
    expect(await codeOf(handle.activate())).toBe('router edit failed')
    expect(await handle.read()).toMatchObject({ phase: 'activating', capture: 'final' })
    expect(await routerActive()).toBeUndefined()
    expect((await handle.activate()).record.phase).toBe('active')
    expect(w.count(`pause-watcher:${WATCHER}`)).toBe(1)
    expect(w.count(`snapshot:${WATCHER}`)).toBe(1)
  })

  it('a pause that failed is never taken as ours once a person pauses the watcher', async () => {
    const w = world()
    const handle = migrateLegacyMonitor(spec(), w.deps)
    await handle.prepare()
    w.hooks.beforePause = () => { throw new Error('host unreachable') }
    expect(await codeOf(handle.activate())).toBe('host unreachable')
    w.hooks.beforePause = undefined
    w.watchers.get(WATCHER)!.config.enabled = false
    expect(await codeOf(handle.activate())).toBe('watcher_pause_unproven')
    expect(await codeOf(handle.rollback())).toBe('watcher_pause_unproven')
    expect(w.count(`snapshot:${WATCHER}`)).toBe(0)
    expect(w.count(`resume-router:${ROUTER}`)).toBe(0)
    expect(w.count(`restore-watcher:${WATCHER}`)).toBe(0)
    expect(await routerActive()).toBeUndefined()
    expect(w.watchers.get(WATCHER)!.config.enabled).toBe(false)
  })

  it('a crash after asking for the pause and before the call is refused the same way', async () => {
    const w = world()
    const handle = migrateLegacyMonitor(spec(), w.deps)
    await handle.prepare()
    const file = legacyMigrationPath(home, 'dock-mail-1')
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
    fs.writeFileSync(file, JSON.stringify({ ...saved, phase: 'activating', watcherPauseRequestedAt: w.clock.now }))
    w.watchers.get(WATCHER)!.config.enabled = false
    expect(await codeOf(handle.activate())).toBe('watcher_pause_unproven')
    expect(w.count(`pause-watcher:${WATCHER}`)).toBe(0)
    expect(w.count(`resume-router:${ROUTER}`)).toBe(0)
  })

  it('a resume that failed is never taken as ours once a person starts the router', async () => {
    const w = world()
    const handle = migrateLegacyMonitor(spec(), w.deps)
    await handle.prepare()
    w.fail.resumeRouter = new Error('router edit failed')
    expect(await codeOf(handle.activate())).toBe('router edit failed')
    await w.setRouterPaused(false)
    expect(await codeOf(handle.activate())).toBe('router_active_not_ours')
    expect(await codeOf(handle.rollback())).toBe('router_active_not_ours')
    expect(w.count(`pause-router:${ROUTER}`)).toBe(0)
    expect(w.count(`restore-watcher:${WATCHER}`)).toBe(0)
    expect(w.watchers.get(WATCHER)!.config.enabled).toBe(false)
    expect(await routerActive()).toBe(ROUTER)
  })

  it('a crash after the resume call and before its proof was saved is refused, not assumed', async () => {
    const w = world()
    const handle = migrateLegacyMonitor(spec(), w.deps)
    await handle.prepare()
    const resume = w.deps.resumeRouter
    w.deps.resumeRouter = async (taskId) => { await resume(taskId); throw new Error('server stopped') }
    expect(await codeOf(handle.activate())).toBe('server stopped')
    w.deps.resumeRouter = resume
    expect((await handle.read())?.routerResumedAt).toBeUndefined()
    expect(await codeOf(handle.activate())).toBe('router_active_not_ours')
    expect(await codeOf(handle.rollback())).toBe('router_active_not_ours')
    expect(w.count(`pause-router:${ROUTER}`)).toBe(0)
    expect(w.watchers.get(WATCHER)!.config.enabled).toBe(false)
  })

  it('a person edit before activation stops it and is left as it is', async () => {
    const w = world()
    const handle = migrateLegacyMonitor(spec(), w.deps)
    await handle.prepare()
    w.watchers.get(WATCHER)!.config.schedule = { kind: 'every', everyMs: 60_000 }
    expect(await codeOf(handle.activate())).toBe('watcher_changed')
    expect(w.watchers.get(WATCHER)!.config).toMatchObject({ enabled: true, schedule: { everyMs: 60_000 } })
    expect(w.count(`pause-watcher:${WATCHER}`)).toBe(0)
  })

  it('refuses a migration that does not say whether the watcher keeps dates', async () => {
    const w = world()
    const { dateItems: _drop, ...unstated } = spec()
    const handle = migrateLegacyMonitor(unstated, w.deps)
    await handle.prepare()
    expect(await codeOf(handle.activate())).toBe('date_items_unknown')
    expect(w.watchers.get(WATCHER)!.config.enabled).toBe(true)
  })

  it('pauses a watcher with a date item only for an enabled date-only reminder at that exact time', async () => {
    const w = world()
    const handle = migrateLegacyMonitor(spec({ dateItems: [{ id: 'deadline-nov-15', dueAt: DUE }] }), w.deps)
    await handle.prepare()
    const at = (ms: number) => ({ kind: 'at', at: new Date(ms).toISOString() })
    const { check: _check, ...dateOnly } = routine('x')
    const add = (id: string, config: WatcherConfig) => w.watchers.set(id, { config: { ...config, id }, state: null })
    add('with-mail-check', routine('with-mail-check', { schedule: at(DUE) }))
    add('recurring', { ...dateOnly, schedule: { kind: 'cron', expr: '0 17 15 11 *' } })
    add('wrong-time', { ...dateOnly, schedule: at(DUE + 3_600_000) })
    add('off', { ...dateOnly, enabled: false, schedule: at(DUE) })
    add('exact', { ...dateOnly, schedule: at(DUE) })

    expect(await codeOf(handle.activate())).toBe('date_reminder_required')
    // A copy step's say-so is no proof: only the routine itself counts.
    expect(await codeOf(handle.activate({ dateReplacement: { deadlinePreserved: true, dateOnly: true } } as never))).toBe('date_reminder_required')
    for (const id of ['with-mail-check', 'recurring', 'wrong-time', 'off', WATCHER, 'missing']) {
      expect(await codeOf(handle.activate({ dateReplacement: { reminderIds: [id] } }))).toBe('date_reminder_required')
    }
    expect(await codeOf(handle.activate({ dateReplacement: { reminderIds: ['exact', 'exact'] } }))).toBe('date_reminder_required')
    expect(w.count(`pause-watcher:${WATCHER}`)).toBe(0)
    expect((await handle.activate({ dateReplacement: { reminderIds: ['exact'] } })).record.phase).toBe('active')
  })

  it('needs every named rule binding saved for the area at the rule live revision', async () => {
    const w = world()
    const handle = migrateLegacyMonitor(spec({ ruleBindings: [{ ruleId: 'rr-dock', revision: REVISION }] }), w.deps)
    await handle.prepare()
    w.rules.set('rr-dock', REVISION)
    expect(await codeOf(handle.activate())).toBe('rule_binding_unverified')
    await updateRouterAreas(home, (file) => ({ ...file, ruleBindings: [{ ruleId: 'rr-dock', revision: REVISION, areaId: AREA, confirmedAt: 1 }] }))
    w.rules.set('rr-dock', 'b'.repeat(64))
    expect(await codeOf(handle.activate())).toBe('rule_binding_unverified')
    w.rules.set('rr-dock', REVISION)
    expect((await handle.activate()).record.phase).toBe('active')
  })
})

describe('rollback', () => {
  async function activated() {
    const w = world()
    const handle = migrateLegacyMonitor(spec(), w.deps)
    await handle.prepare()
    await handle.activate()
    return { w, handle }
  }

  it('pauses the router first, then turns the watcher back on as captured, keeping receipts and items', async () => {
    const { w, handle } = await activated()
    const result = await handle.rollback()
    expect(w.events.slice(6)).toEqual([`pause-router:${ROUTER}`, `restore-watcher:${WATCHER}`])
    expect(cronJobRevision(w.watchers.get(WATCHER)!.config)).toBe(cronJobRevision(routine(WATCHER)))
    expect(result.record).toMatchObject({ phase: 'rolled_back', watcherRestore: { outcome: 'restored' } })
    expect(w.rows.size).toBe(2)
    expect((await readRouterAreas(home)).items).toHaveLength(2)
    expect(await routerActive()).toBeUndefined()
    expect((await handle.rollback()).changed).toBe(false)
  })

  it('a failed restore leaves the router paused and finishes on retry', async () => {
    const { w, handle } = await activated()
    w.fail.restoreWatcher = new Error('host unreachable')
    expect(await codeOf(handle.rollback())).toBe('host unreachable')
    expect((await handle.read())?.phase).toBe('rolling_back')
    expect(await routerActive()).toBeUndefined()
    expect(w.watchers.get(WATCHER)!.config.enabled).toBe(false)
    expect((await handle.rollback()).record.phase).toBe('rolled_back')
    expect(w.count(`pause-router:${ROUTER}`)).toBe(1)
    expect(w.watchers.get(WATCHER)!.config.enabled).toBe(true)
  })

  it('never overwrites a person edit made since the pause', async () => {
    const { w, handle } = await activated()
    w.watchers.get(WATCHER)!.config.check = { run: 'walnut trigger-check fixture:new-mail \'{"from":"crew"}\'', host: '__local__' }
    expect(await codeOf(handle.rollback())).toBe('watcher_changed')
    expect(w.count(`restore-watcher:${WATCHER}`)).toBe(0)
    expect(w.watchers.get(WATCHER)!.config.check).toMatchObject({ run: expect.stringContaining('crew') })
    expect(await routerActive()).toBeUndefined()
  })

  it('the restore compare-and-set refuses a host state that moved while paused', async () => {
    const { w, handle } = await activated()
    w.watchers.get(WATCHER)!.state = { cursor: 'uid:1', seen: {}, pendingFires: [] }
    expect(await codeOf(handle.rollback())).toBe('routine_changed')
    expect(w.watchers.get(WATCHER)!.config.enabled).toBe(false)
  })

  it('keeps a watcher paused once its seen set aged past what the host keeps', async () => {
    const { w, handle } = await activated()
    w.clock.now = w.clock.seenUntil + 1
    expect(await codeOf(handle.rollback())).toBe('watcher_seen_expired')
    expect(w.watchers.get(WATCHER)!.config.enabled).toBe(false)
    expect(await routerActive()).toBeUndefined()
  })

  it('leaves a watcher a person turned back on running as they set it', async () => {
    const { w, handle } = await activated()
    w.watchers.get(WATCHER)!.config.enabled = true
    expect((await handle.rollback()).record.watcherRestore?.outcome).toBe('left_as_person_set')
    expect(w.count(`restore-watcher:${WATCHER}`)).toBe(0)
  })

  it('leaves alone a router a person started outside this migration', async () => {
    const w = world()
    const handle = migrateLegacyMonitor(spec(), w.deps)
    await handle.prepare()
    await w.setRouterPaused(false)
    expect(await codeOf(handle.rollback())).toBe('router_active_not_ours')
    expect(await routerActive()).toBe(ROUTER)
    expect(w.count(`pause-router:${ROUTER}`)).toBe(0)
    expect(w.watchers.get(WATCHER)!.config.enabled).toBe(true)
  })
})

describe('activate: the proof is the compare-and-set itself', () => {
  it('a watcher read failing after the pause and the resume costs neither proof, and the retry only reads', async () => {
    const w = world()
    const handle = migrateLegacyMonitor(spec(), w.deps)
    await handle.prepare()
    // Every watcher read after the pause fails once: the pause proof comes from the CAS answer, not a read.
    w.hooks.afterPause = () => { w.hooks.readWatcher = failing(1, 'routines engine restarting') }
    expect(await codeOf(handle.activate())).toBe('routines engine restarting')
    const half = await handle.read()
    expect(half).toMatchObject({ phase: 'activating', capture: 'final' })
    expect(half?.watcherPausedAt).toBeDefined()
    expect(half?.routerResumedAt).toBeDefined()
    expect((await handle.activate()).record.phase).toBe('active')
    expect(w.count(`pause-watcher:${WATCHER}`)).toBe(1)
    expect(w.count(`resume-router:${ROUTER}`)).toBe(1)
  })

  it('a resume whose CAS succeeded and whose read-back failed can be rolled back', async () => {
    const w = world()
    const handle = migrateLegacyMonitor(spec(), w.deps)
    await handle.prepare()
    const resume = w.deps.resumeRouter
    w.deps.resumeRouter = async (taskId) => { await resume(taskId); w.hooks.readAreas = failing(1, 'areas file busy') }
    expect(await codeOf(handle.activate())).toBe('areas file busy')
    expect((await handle.read())?.routerResumedAt).toBeDefined()
    expect(await routerActive()).toBe(ROUTER)
    const back = await handle.rollback()
    expect(back.record).toMatchObject({ phase: 'rolled_back', watcherRestore: { outcome: 'restored' } })
    expect(w.count(`pause-router:${ROUTER}`)).toBe(1)
    expect(await routerActive()).toBeUndefined()
    expect(w.watchers.get(WATCHER)!.config.enabled).toBe(true)
  })

  it('a proven resume is not finished active once the watcher was turned back on, and it is not started twice', async () => {
    const w = world()
    const handle = migrateLegacyMonitor(spec(), w.deps)
    await handle.prepare()
    const resume = w.deps.resumeRouter
    w.deps.resumeRouter = async (taskId) => { await resume(taskId); w.hooks.readAreas = failing(1, 'areas file busy') }
    expect(await codeOf(handle.activate())).toBe('areas file busy')
    w.watchers.get(WATCHER)!.config.enabled = true
    expect(await codeOf(handle.activate())).toBe('watcher_changed')
    expect(w.count(`resume-router:${ROUTER}`)).toBe(1)
    expect((await handle.read())?.phase).toBe('activating')
  })
})

describe('rollback never turns the watcher on over the router\'s own work', () => {
  async function activated() {
    const w = world()
    const handle = migrateLegacyMonitor(spec(), w.deps)
    await handle.prepare()
    await handle.activate()
    return { w, handle }
  }

  it.each(['routing', 'routed', 'not_routed', 'failed', 'unknown'] as const)('a router decision in status %s is refused before any change', async (status) => {
    const { w, handle } = await activated()
    routerDecision(w, 'INBOX:9', status)
    const error = await handle.rollback().then(() => undefined, (e: { code?: string; message?: string }) => e)
    expect(error?.code).toBe('router_work_not_replay_safe')
    expect(error?.message).toMatch(/dedup state/)
    expect(w.events.slice(6)).toEqual([])
    expect(await routerActive()).toBe(ROUTER)
    expect(w.watchers.get(WATCHER)!.config.enabled).toBe(false)
    expect((await handle.read())?.phase).toBe('active')
  })

  it('only legacy receipts in the ledger roll back as before', async () => {
    const { w, handle } = await activated()
    expect([...w.rows.values()].every((one) => one.origin === 'legacy')).toBe(true)
    expect((await handle.rollback()).record).toMatchObject({ phase: 'rolled_back', watcherRestore: { outcome: 'restored' } })
    expect(w.watchers.get(WATCHER)!.config.enabled).toBe(true)
  })

  it('a decision that lands while the router is being paused keeps both paused, on every retry', async () => {
    const { w, handle } = await activated()
    w.hooks.beforeRouterPause = () => routerDecision(w, 'INBOX:9', 'routing')
    expect(await codeOf(handle.rollback())).toBe('router_work_not_replay_safe')
    w.hooks.beforeRouterPause = undefined
    expect(await routerActive()).toBeUndefined()
    expect(w.watchers.get(WATCHER)!.config.enabled).toBe(false)
    expect(w.count(`restore-watcher:${WATCHER}`)).toBe(0)
    expect(await codeOf(handle.rollback())).toBe('router_work_not_replay_safe')
    expect(await codeOf(handle.activate())).toBe('wrong_phase')
    expect(w.count(`pause-router:${ROUTER}`)).toBe(1)
    expect(w.count(`restore-watcher:${WATCHER}`)).toBe(0)
    expect(w.watchers.get(WATCHER)!.config.enabled).toBe(false)
  })

  it('a resume asked for but never proven is treated as one that may have run', async () => {
    const w = world()
    const handle = migrateLegacyMonitor(spec(), w.deps)
    await handle.prepare()
    w.fail.resumeRouter = new Error('router edit failed')
    expect(await codeOf(handle.activate())).toBe('router edit failed')
    routerDecision(w, 'INBOX:9', 'routed')
    expect(await codeOf(handle.rollback())).toBe('router_work_not_replay_safe')
    expect(w.count(`restore-watcher:${WATCHER}`)).toBe(0)
    expect(w.watchers.get(WATCHER)!.config.enabled).toBe(false)
  })

  it('waits for a route already holding the area lock, and refuses the decision it lands', async () => {
    const { w, handle } = await activated()
    let release!: () => void
    let holding!: () => void
    const held = new Promise<void>((resolve) => { holding = resolve })
    const route = withAreaRouteLock(home, AREA, async () => {
      holding()
      await new Promise<void>((resolve) => { release = resolve })
      routerDecision(w, 'INBOX:9', 'routing')
    })
    await held
    const rolling = handle.rollback().then(() => 'done', (e: { code?: string }) => e.code)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(w.events.slice(6)).toEqual([])
    release()
    await route
    expect(await rolling).toBe('router_work_not_replay_safe')
    expect(w.count(`restore-watcher:${WATCHER}`)).toBe(0)
    expect(w.watchers.get(WATCHER)!.config.enabled).toBe(false)
  })

  it('holds the area lock from its first ledger check through the restore', async () => {
    const { w, handle } = await activated()
    const probes: string[] = []
    const probe = async (at: string) => {
      const got = await withAreaRouteLock(home, AREA, async () => 'free', { timeoutMs: 30 }).catch((e) => e instanceof RouteLockBusyError ? 'held' : String(e))
      probes.push(`${at}:${got}`)
    }
    w.hooks.beforeRouterPause = () => probe('pause-router')
    const restore = w.deps.restoreWatcher
    w.deps.restoreWatcher = async (...args) => { await probe('restore'); return await restore(...args) }
    expect((await handle.rollback()).record.phase).toBe('rolled_back')
    expect(probes).toEqual(['pause-router:held', 'restore:held'])
    await probe('after')
    expect(probes.at(-1)).toBe('after:free')
  })

  it('a lock it cannot get in time changes nothing', async () => {
    const { w, handle } = await activated()
    w.deps.routeLockWaitMs = 50
    let release!: () => void
    let holding!: () => void
    const held = new Promise<void>((resolve) => { holding = resolve })
    const route = withAreaRouteLock(home, AREA, async () => { holding(); await new Promise<void>((resolve) => { release = resolve }) })
    await held
    expect(await codeOf(handle.rollback())).toBe('area_route_busy')
    release()
    await route
    expect(w.events.slice(6)).toEqual([])
    expect((await handle.read())?.phase).toBe('active')
    expect(await routerActive()).toBe(ROUTER)
  })
})
