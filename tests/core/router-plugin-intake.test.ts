/**
 * A chat plugin's door into the router (src/core/router/plugin-intake.ts `routerIntake`): a chat
 * account's new arrivals enter the person's one router the way new mail does, through the real
 * binding (account-intake.ts ensureAccountRouter, whose pickArea now lets a kind no area takes join
 * the single open router), the account's `include` filter (areas.ts sourceTakes) and the real
 * confirmAccountArrivals under a real areas file in this test's own temp home. The source cache and
 * the wake are fakes that record their calls. A chat account never makes a router of its own.
 * All names are invented.
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('router-plugin-intake'))
const routines = vi.hoisted(() => ({ runs: [] as string[] }))
const config = vi.hoisted(() => ({ experimental: undefined as Record<string, boolean> | undefined }))
vi.mock('../../src/core/config-manager.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/config-manager.js')>()),
  getConfig: vi.fn(async () => ({ version: 1, user: { name: 'test' }, defaults: { priority: 'none' }, provider: { type: 'bedrock' }, plugins: {}, ...(config.experimental ? { experimental: config.experimental } : {}) })),
}))
vi.mock('../../src/core/routines/routines-core.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/routines/routines-core.js')>()),
  runRoutineNow: vi.fn(async (id: string) => { routines.runs.push(id); return { result: null } }),
}))

import { WALNUT_HOME } from '../../src/constants.js'
import { normalizeRouterAreas, readRouterAreas, ROUTER_ACCOUNT_MAX, ROUTER_MESSAGE_MAX, routerAreasPath, sourceTakes, updateRouterAreas, type RouterAreasFile } from '../../src/core/router/areas.js'
import { ensureAccountRouter, type AccountRouterDeps } from '../../src/core/router/account-intake.js'
import { __resetRouterKicks, chatSourcesEnabled, enterArrivals, kickRouterWake, routerIntake, ROUTER_INTAKE_MAX, type RouterIntakeDeps } from '../../src/core/router/plugin-intake.js'
import { routerWakeJobId } from '../../src/core/router/wake.js'
import type { RouterItem, RouterSource, RouterSourceKind } from '../../src/core/router/types.js'
import { seedTaskStore } from '../helpers/router-task-store.js'

const TEAM = 'T0TEAM'
const MAILBOX = 'desk@acme.example.invalid'
const roots: string[] = []
const prior = process.env.WALNUT_MAIL_AUTO_ROUTER

beforeEach(() => { process.env.WALNUT_MAIL_AUTO_ROUTER = '1'; __resetRouterKicks(); routines.runs.length = 0; config.experimental = undefined })
afterEach(async () => {
  if (prior === undefined) delete process.env.WALNUT_MAIL_AUTO_ROUTER; else process.env.WALNUT_MAIL_AUTO_ROUTER = prior
  for (const root of roots.splice(0)) await fsp.rm(root, { recursive: true, force: true }).catch(() => undefined)
})

interface AreaSpec { id: string; router: string; sources?: RouterAreasFile['areas'][number]['sources'] }

/** A real areas file under a fresh temp home; every router listed is open unless `closed` names it. */
async function homeWith(specs: AreaSpec[], extra: Partial<RouterAreasFile> = {}) {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'router-plugin-intake-'))
  roots.push(home)
  seedTaskStore(home)
  if (specs.length || Object.keys(extra).length) {
    await updateRouterAreas(home, () => ({
      version: 1, items: [],
      areas: specs.map((one) => ({ id: one.id, name: one.id, host: '__local__', taskIds: [one.router], sources: one.sources ?? [{ kind: 'mail', account: MAILBOX }] })),
      routers: specs.map((one) => ({ taskId: one.router, areaId: one.id, paused: false })),
      ...extra,
    }) as RouterAreasFile)
  }
  return home
}

/** The fakes: a chat cache that holds every message it is asked about, and a wake that records. */
function fakes(home: string, closed: string[] = []) {
  const kicks: string[] = []
  const resolved: RouterSource[] = []
  const ensureCalls: Array<[RouterSourceKind, string]> = []
  const created: string[] = []
  const deps: RouterIntakeDeps = {
    home,
    // The router_chat_sources experiment, on (its off is a test of its own).
    enabled: async () => true,
    routerOpen: async (id) => !closed.includes(id),
    resolve: async (source): Promise<RouterItem> => {
      resolved.push(source)
      return { source: { ...source }, key: `slack:${source.account}:${source.message}`, sender: 'U-fixture', subject: '' }
    },
    current: async (sources) => [...sources],
    kick: async (areaId) => { kicks.push(areaId) },
    // The real binding, with the task store's open check answered here; createRouter is the
    // intake's own (a guard that throws), so a call that would make a router fails closed.
    ensure: (kind, account, inner: AccountRouterDeps) => {
      ensureCalls.push([kind, account])
      const createRouter = inner.createRouter
      return ensureAccountRouter(kind, account, {
        ...inner, routerOpen: async (id) => !closed.includes(id),
        createRouter: async (k, a) => { created.push(a); return createRouter!(k, a) },
      })
    },
  }
  return { deps, kicks, resolved, ensureCalls, created }
}

const dm = (n: number, labels: string[] = ['dm']) => ({ message: `D1/1700000000.00${n}`, labels })

describe('the router_chat_sources experiment', () => {
  it('off: nothing is taken, nothing bound or entered, the router is not woken', async () => {
    const home = await homeWith([{ id: 'personal', router: 'r-1' }])
    const before = await readRouterAreas(home)
    const f = fakes(home)
    f.deps.enabled = async () => false
    expect(await routerIntake('slack', TEAM, [dm(1)], f.deps)).toEqual({ taken: false, reason: 'off' })
    expect(f.ensureCalls).toEqual([])
    expect(f.resolved).toEqual([])
    expect(f.kicks).toEqual([])
    expect(await readRouterAreas(home)).toEqual(before)
    // A malformed call is still refused, switch or not.
    await expect(routerIntake('slack', TEAM, 'D1/1', f.deps)).rejects.toBeInstanceOf(TypeError)
  })

  it('reads the experiment from config by default (off unless the person turns it on)', async () => {
    const home = await homeWith([{ id: 'personal', router: 'r-1' }])
    const f = fakes(home)
    delete f.deps.enabled
    expect(await chatSourcesEnabled()).toBe(false)
    expect(await routerIntake('slack', TEAM, [dm(1)], f.deps)).toEqual({ taken: false, reason: 'off' })
    config.experimental = { router_chat_sources: true }
    expect(await chatSourcesEnabled()).toBe(true)
    expect(await routerIntake('slack', TEAM, [dm(1)], f.deps)).toMatchObject({ taken: true, entered: 1 })
  })
})

describe('a chat account with no router to join', () => {
  it('is not taken (none) with no areas file at all, and nothing is bound or written', async () => {
    const home = await homeWith([])
    const f = fakes(home)
    expect(await routerIntake('slack', TEAM, [dm(1)], f.deps)).toEqual({ taken: false, reason: 'none' })
    expect(f.ensureCalls).toEqual([])
    expect(f.kicks).toEqual([])
    expect(fs.existsSync(routerAreasPath(home))).toBe(false)
  })

  it('several open routers and no Mail router: never makes one, binds nothing', async () => {
    const home = await homeWith([{ id: 'personal', router: 'r-1' }, { id: 'family', router: 'r-2' }])
    const before = await readRouterAreas(home)
    const f = fakes(home)
    expect(await routerIntake('slack', TEAM, [dm(1)], f.deps)).toEqual({ taken: false, reason: 'none' })
    // The intake's guard was the one asked, and it made nothing.
    expect(f.created).toEqual([TEAM])
    expect(await readRouterAreas(home)).toEqual(before)
    expect(f.resolved).toEqual([])
  })

  it('bound to a router whose task is closed: closed, and nothing entered, bound again or woken', async () => {
    const home = await homeWith([{ id: 'personal', router: 'r-1', sources: [{ kind: 'slack', account: TEAM }] }, { id: 'family', router: 'r-2' }],
      { accountBindings: [{ kind: 'slack', account: TEAM, areaId: 'personal', boundAt: 1 }] })
    const before = await readRouterAreas(home)
    const f = fakes(home, ['r-1'])
    expect(await routerIntake('slack', TEAM, [dm(1)], f.deps)).toEqual({ taken: false, reason: 'closed' })
    expect(f.ensureCalls).toEqual([])
    expect(f.resolved).toEqual([])
    expect(f.kicks).toEqual([])
    expect(await readRouterAreas(home)).toEqual(before)
  })

  it('the open check the caller gives is the one the binding uses too', async () => {
    const home = await homeWith([{ id: 'personal', router: 'r-1' }])
    const f = fakes(home)
    // No ensure stand-in: the real one, with no task store holding r-1.
    delete f.deps.ensure
    expect(await routerIntake('slack', TEAM, [dm(1)], f.deps)).toMatchObject({ taken: true, areaId: 'personal', entered: 1 })
  })

  it('every router closed and no Mail area: none, and still nothing made', async () => {
    const home = await homeWith([{ id: 'personal', router: 'r-1' }])
    const before = await readRouterAreas(home)
    const f = fakes(home, ['r-1'])
    expect(await routerIntake('slack', TEAM, [dm(1)], f.deps)).toEqual({ taken: false, reason: 'none' })
    expect(await readRouterAreas(home)).toEqual(before)
  })

  it('a Mail area whose router is closed is the person\'s pick: choose, nothing bound', async () => {
    const home = await homeWith([{ id: 'personal', router: 'r-1' }, { id: 'family', router: 'r-2' }, { id: 'mail', router: 'r-mail' }])
    const f = fakes(home, ['r-mail'])
    expect(await routerIntake('slack', TEAM, [dm(1)], f.deps)).toEqual({ taken: false, reason: 'choose' })
    expect((await readRouterAreas(home)).accountBindings).toBeUndefined()
    expect(f.created).toEqual([])
  })

  it('the automatic router switched off: off, nothing bound', async () => {
    process.env.WALNUT_MAIL_AUTO_ROUTER = '0'
    const home = await homeWith([{ id: 'personal', router: 'r-1' }])
    const f = fakes(home)
    expect(await routerIntake('slack', TEAM, [dm(1)], f.deps)).toEqual({ taken: false, reason: 'off' })
    expect((await readRouterAreas(home)).accountBindings).toBeUndefined()
  })
})

describe('a chat account beside the person\'s one mail router (pickArea fallback)', () => {
  it('joins the single open mail-only area, enters the arrival and wakes that router once', async () => {
    const home = await homeWith([{ id: 'personal', router: 'r-1' }])
    const f = fakes(home)
    const result = await routerIntake('slack', TEAM, [dm(1)], f.deps)
    expect(result).toEqual({ taken: true, areaId: 'personal', entered: 1, filtered: 0, skipped: [] })
    const file = await readRouterAreas(home)
    expect(file.areas[0]!.sources).toEqual([{ kind: 'mail', account: MAILBOX }, { kind: 'slack', account: TEAM }])
    expect(file.accountBindings).toEqual([{ kind: 'slack', account: TEAM, areaId: 'personal', boundAt: expect.any(Number) }])
    expect(file.openItems).toEqual([{ source: { kind: 'slack', account: TEAM, message: dm(1).message }, areaId: 'personal', canonicalKey: `slack:${TEAM}:${dm(1).message}` }])
    expect(f.kicks).toEqual(['personal'])
    // No router was made, and the area stayed the only one.
    expect(f.created).toEqual([])
    expect(file.areas.map((one) => one.id)).toEqual(['personal'])
  })

  it('a repeat of the same arrival enters nothing and does not wake the router again', async () => {
    const home = await homeWith([{ id: 'personal', router: 'r-1' }])
    const f = fakes(home)
    await routerIntake('slack', TEAM, [dm(1)], f.deps)
    expect(await routerIntake('slack', TEAM, [dm(1)], f.deps)).toEqual({ taken: true, areaId: 'personal', entered: 0, filtered: 0, skipped: [] })
    expect(f.kicks).toEqual(['personal'])
    expect((await readRouterAreas(home)).openItems).toHaveLength(1)
  })

  it('an empty list binds the account and enters nothing', async () => {
    const home = await homeWith([{ id: 'personal', router: 'r-1' }])
    const f = fakes(home)
    expect(await routerIntake('slack', TEAM, [], f.deps)).toEqual({ taken: true, areaId: 'personal', entered: 0, filtered: 0, skipped: [] })
    expect((await readRouterAreas(home)).accountBindings?.map((one) => [one.kind, one.account])).toEqual([['slack', TEAM]])
    expect(f.kicks).toEqual([])
  })

  it('two open routers with a Mail router: the chat account goes to the Mail router', async () => {
    const home = await homeWith([{ id: 'personal', router: 'r-1' }, { id: 'mail', router: 'r-mail' }])
    const f = fakes(home)
    expect(await routerIntake('slack', TEAM, [dm(1)], f.deps)).toMatchObject({ taken: true, areaId: 'mail', entered: 1 })
  })

  it('pickArea for any chat kind: a kind no area takes joins the single open area; two open areas do not use that fallback', async () => {
    const one = await homeWith([{ id: 'personal', router: 'r-1' }])
    const open = async () => true
    const refuse = async () => { throw new Error('no router may be made here') }
    expect(await ensureAccountRouter('wechat', 'wx-fixture', { home: one, routerOpen: open, createRouter: refuse }))
      .toEqual({ bound: true, areaId: 'personal', created: false, already: false })
    // A remote area is never the fallback.
    const remote = await homeWith([])
    await updateRouterAreas(remote, () => ({
      version: 1, items: [], routers: [{ taskId: 'r-1', areaId: 'far', paused: false }],
      areas: [{ id: 'far', name: 'far', host: 'devbox', taskIds: ['r-1'], sources: [{ kind: 'mail', account: MAILBOX }] }],
    }) as RouterAreasFile)
    await expect(ensureAccountRouter('slack', TEAM, { home: remote, routerOpen: open, createRouter: refuse })).rejects.toThrow('no router may be made here')
    const two = await homeWith([{ id: 'personal', router: 'r-1' }, { id: 'family', router: 'r-2' }])
    await expect(ensureAccountRouter('slack', TEAM, { home: two, routerOpen: open, createRouter: refuse })).rejects.toThrow('no router may be made here')
  })

  it('an account already bound goes to its own area, whatever else is open', async () => {
    const home = await homeWith([{ id: 'personal', router: 'r-1' }, { id: 'family', router: 'r-2', sources: [{ kind: 'slack', account: TEAM }] }],
      { accountBindings: [{ kind: 'slack', account: TEAM, areaId: 'family', boundAt: 1 }] })
    const f = fakes(home)
    expect(await routerIntake('slack', TEAM, [dm(1)], f.deps)).toMatchObject({ taken: true, areaId: 'family', entered: 1 })
  })
})

describe('the account\'s filter (include)', () => {
  async function filtered(include?: string[]) {
    const home = await homeWith([{ id: 'personal', router: 'r-1', sources: [{ kind: 'mail', account: MAILBOX }, { kind: 'slack', account: TEAM, ...(include ? { include } : {}) }] }],
      { accountBindings: [{ kind: 'slack', account: TEAM, areaId: 'personal', boundAt: 1 }] })
    return { home, f: fakes(home) }
  }

  it('takes only arrivals carrying a label it names, case-insensitively, and counts the rest as filtered', async () => {
    const { home, f } = await filtered(['DM', 'channel:Releases'])
    const arrivals = [dm(1, ['dm']), dm(2, ['mention']), dm(3, ['channel:releases']), dm(4, []), { message: 'D1/1700000000.005' }, dm(6, ['Mention', 'DM'])]
    expect(await routerIntake('slack', TEAM, arrivals, f.deps)).toEqual({ taken: true, areaId: 'personal', entered: 3, filtered: 3, skipped: [dm(2).message, dm(4).message, 'D1/1700000000.005'] })
    expect(((await readRouterAreas(home)).openItems ?? []).map((one) => one.source.message)).toEqual([dm(1).message, dm(3).message, dm(6).message])
    // A filtered arrival is never even resolved.
    expect(f.resolved.map((one) => one.message)).toEqual([dm(1).message, dm(3).message, dm(6).message])
  })

  it('with no list, takes every arrival, labelled or not', async () => {
    const { f } = await filtered()
    expect(await routerIntake('slack', TEAM, [dm(1, ['dm']), dm(2, ['channel:random']), { message: 'D1/x' }], f.deps)).toEqual({ taken: true, areaId: 'personal', entered: 3, filtered: 0, skipped: [] })
  })

  it('all filtered: enters nothing and wakes nothing', async () => {
    const { f } = await filtered(['dm'])
    expect(await routerIntake('slack', TEAM, [dm(1, ['mention'])], f.deps)).toEqual({ taken: true, areaId: 'personal', entered: 0, filtered: 1, skipped: [dm(1).message] })
    expect(f.kicks).toEqual([])
    expect(f.resolved).toEqual([])
  })

  it('sourceTakes is the one rule, and normalize keeps a clean include list', () => {
    expect(sourceTakes(undefined, [])).toBe(true)
    expect(sourceTakes({ include: [] }, [])).toBe(true)
    expect(sourceTakes({ include: ['dm'] }, [])).toBe(false)
    expect(sourceTakes({ include: ['dm'] }, ['DM'])).toBe(true)
    const file = (include: unknown) => ({ version: 1, items: [], routers: [], areas: [{ id: 'personal', name: 'p', host: '__local__', taskIds: [], sources: [{ kind: 'slack', account: TEAM, include }] }] })
    expect(normalizeRouterAreas(file([' dm ', 'mention', 'dm'])).areas[0]!.sources[0]).toEqual({ kind: 'slack', account: TEAM, include: ['dm', 'mention'] })
    expect(normalizeRouterAreas(file([])).areas[0]!.sources[0]).toEqual({ kind: 'slack', account: TEAM })
    expect(normalizeRouterAreas(file(undefined)).areas[0]!.sources[0]).toEqual({ kind: 'slack', account: TEAM })
    for (const bad of ['dm', [7], [''], ['  '], ['line\nbreak'], ['x'.repeat(201)], Array.from({ length: 51 }, (_, i) => `l${i}`)]) {
      expect(() => normalizeRouterAreas(file(bad)), JSON.stringify(bad).slice(0, 40)).toThrow()
    }
  })
})

describe('what the door refuses', () => {
  it('refuses mail (it has its own intake) and an unknown kind', async () => {
    const home = await homeWith([{ id: 'personal', router: 'r-1' }])
    const f = fakes(home)
    await expect(routerIntake('mail', MAILBOX, [], f.deps)).rejects.toThrow(/own intake/)
    await expect(routerIntake('teams' as RouterSourceKind, TEAM, [], f.deps)).rejects.toThrow(/Unknown routing source kind/)
    expect(f.ensureCalls).toEqual([])
  })

  it('refuses a bad account and bad arrivals before reading or writing anything', async () => {
    const home = await homeWith([{ id: 'personal', router: 'r-1' }])
    const before = await readRouterAreas(home)
    const f = fakes(home)
    for (const account of ['', 'a\nb', 'x'.repeat(ROUTER_ACCOUNT_MAX + 1), 7]) {
      await expect(routerIntake('slack', account as string, [], f.deps)).rejects.toThrow(/exact account id/)
    }
    const bad: unknown[] = [
      'D1/1', null, { message: 'D1/1' },
      Array.from({ length: ROUTER_INTAKE_MAX + 1 }, (_, i) => ({ message: `D1/${i}` })),
      [{}], [{ message: '' }], [{ message: 'a\u0000b' }], [{ message: 'x'.repeat(ROUTER_MESSAGE_MAX + 1) }],
      [{ message: 'D1/1', version: '' }], [{ message: 'D1/1', version: 7 }],
      [{ message: 'D1/1', labels: 'dm' }], [{ message: 'D1/1', labels: [''] }], [{ message: 'D1/1', labels: ['a\nb'] }],
      [{ message: 'D1/1', labels: ['x'.repeat(201)] }], [{ message: 'D1/1', labels: Array.from({ length: 21 }, (_, i) => `l${i}`) }],
    ]
    for (const arrivals of bad) {
      await expect(routerIntake('slack', TEAM, arrivals, f.deps), JSON.stringify(arrivals)?.slice(0, 60)).rejects.toBeInstanceOf(TypeError)
    }
    expect(f.ensureCalls).toEqual([])
    expect(await readRouterAreas(home)).toEqual(before)
    // The most one call may carry is accepted.
    expect(await routerIntake('slack', TEAM, Array.from({ length: ROUTER_INTAKE_MAX }, (_, i) => ({ message: `D1/${i}`, labels: ['dm'] })), f.deps))
      .toMatchObject({ taken: true, entered: ROUTER_INTAKE_MAX })
    // The longest account and message id are accepted.
    const longest = 'T'.repeat(ROUTER_ACCOUNT_MAX)
    expect(await routerIntake('slack', longest, [{ message: 'D'.repeat(ROUTER_MESSAGE_MAX) }], f.deps)).toMatchObject({ taken: true, entered: 1 })
  })

  it('a wake that fails to start never fails the intake', async () => {
    const home = await homeWith([{ id: 'personal', router: 'r-1' }])
    const f = fakes(home)
    f.deps.kick = async () => { throw new Error('routines engine down') }
    expect(await routerIntake('slack', TEAM, [dm(1)], f.deps)).toMatchObject({ taken: true, entered: 1 })
  })
})

describe('the router wake kick (kickRouterWake)', () => {
  async function areasAtHome(paused = false) {
    seedTaskStore(WALNUT_HOME)
    await updateRouterAreas(WALNUT_HOME, () => ({
      version: 1, items: [],
      areas: [
        { id: 'personal', name: 'p', host: '__local__', taskIds: ['r-1'], sources: [] },
        { id: 'family', name: 'f', host: '__local__', taskIds: ['r-2'], sources: [] },
      ],
      routers: [{ taskId: 'r-1', areaId: 'personal', paused }, { taskId: 'r-2', areaId: 'family', paused: false }],
    }) as RouterAreasFile)
  }

  it('runs the area router\'s wake job at once; a burst inside the 30 s gap runs it once more when the gap ends', async () => {
    await areasAtHome()
    const job = await routerWakeJobId('r-1')
    // The first kick is dated so that the gap ends about 300 ms from now.
    await kickRouterWake('personal', Date.now() - 29_700)
    expect(routines.runs).toEqual([job])
    await kickRouterWake('personal')
    await kickRouterWake('personal')
    await kickRouterWake('personal')
    expect(routines.runs).toEqual([job])
    // One trailing run for the whole burst, when the gap ends.
    await expect.poll(() => routines.runs.length, { timeout: 5_000, interval: 50 }).toBe(2)
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(routines.runs).toEqual([job, job])
  })

  it('another area has its own gap; the test reset forgets every gap and cancels a pending trailing run', async () => {
    await areasAtHome()
    const job = await routerWakeJobId('r-1')
    await kickRouterWake('personal', Date.now() - 29_700)
    await kickRouterWake('family')
    expect(routines.runs).toEqual([job, await routerWakeJobId('r-2')])
    // personal now has a trailing run armed; the reset cancels it.
    await kickRouterWake('personal')
    __resetRouterKicks()
    await new Promise((resolve) => setTimeout(resolve, 800))
    expect(routines.runs.filter((id) => id === job)).toHaveLength(1)
    await kickRouterWake('personal')
    expect(routines.runs.filter((id) => id === job)).toHaveLength(2)
  })

  it('wakes nothing for a paused router or an area with none', async () => {
    await areasAtHome(true)
    await kickRouterWake('personal', 2_000_000)
    await kickRouterWake('nowhere', 2_000_000)
    expect(routines.runs).toEqual([])
  })
})

describe('enterArrivals: one bad item never holds the rest', () => {
  const src = (n: number): RouterSource => ({ kind: 'slack', account: TEAM, message: `D1/${n}` })
  const failing = (bad: Set<string>) => {
    const calls: string[][] = []
    const enter = async (sources: readonly RouterSource[]) => {
      calls.push(sources.map((one) => one.message))
      if (sources.some((one) => bad.has(one.message))) throw new Error(`cannot enter ${[...bad].join(',')}`)
      return [...sources]
    }
    return { calls, enter: enter as never }
  }

  it('enters the whole batch in one call when it goes through', async () => {
    const f = failing(new Set())
    expect(await enterArrivals([src(1), src(2)], '/h', {}, f.enter)).toEqual([src(1), src(2)])
    expect(f.calls).toEqual([['D1/1', 'D1/2']])
  })

  it('a batch that throws is entered one by one, and the ones that go through are returned', async () => {
    const f = failing(new Set(['D1/2']))
    expect(await enterArrivals([src(1), src(2), src(3)], '/h', {}, f.enter)).toEqual([src(1), src(3)])
    expect(f.calls).toEqual([['D1/1', 'D1/2', 'D1/3'], ['D1/1'], ['D1/2'], ['D1/3']])
  })

  it('throws the batch error when every one failed, or when a single one fails', async () => {
    await expect(enterArrivals([src(1), src(2)], '/h', {}, failing(new Set(['D1/1', 'D1/2'])).enter)).rejects.toThrow('cannot enter')
    const one = failing(new Set(['D1/1']))
    await expect(enterArrivals([src(1)], '/h', {}, one.enter)).rejects.toThrow('cannot enter')
    expect(one.calls).toEqual([['D1/1']])
  })
})

describe('a source row keeps when its filter last changed (includeAt)', () => {
  const file = (source: Record<string, unknown>) => ({ version: 1, items: [], routers: [], areas: [{ id: 'personal', name: 'p', host: '__local__', taskIds: [], sources: [{ kind: 'slack', account: TEAM, ...source }] }] })
  it('keeps a time in milliseconds, with or without a list, and refuses anything else', () => {
    expect(normalizeRouterAreas(file({ include: ['dm'], includeAt: 1_700_000_000_000 })).areas[0]!.sources[0]).toEqual({ kind: 'slack', account: TEAM, include: ['dm'], includeAt: 1_700_000_000_000 })
    expect(normalizeRouterAreas(file({ includeAt: 5 })).areas[0]!.sources[0]).toEqual({ kind: 'slack', account: TEAM, includeAt: 5 })
    expect(normalizeRouterAreas(file({ include: [], includeAt: 0 })).areas[0]!.sources[0]).toEqual({ kind: 'slack', account: TEAM, includeAt: 0 })
    for (const bad of [-1, '5', Number.POSITIVE_INFINITY, Number.NaN, null]) {
      expect(() => normalizeRouterAreas(file({ includeAt: bad })), String(bad)).toThrow(/includeAt/)
    }
  })
})

