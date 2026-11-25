/**
 * A chat kind with a router of its own (account-intake.ts OWN_ROUTER_AREAS, WeChat): its arrivals
 * make and use their own router area and never join the mail router, and every other kind's binding
 * never lands in that area. Each kind is behind its own experiment (plugin-intake.ts
 * CHAT_SOURCE_SWITCH), so turning WeChat on leaves Slack exactly as it was. The real binding and
 * areas file run under this test's own temp home; the router creation, source cache and wake are
 * fakes that record their calls. All names are invented.
 */
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('router-own-chat-router'))
const config = vi.hoisted(() => ({ experimental: undefined as Record<string, boolean> | undefined }))
vi.mock('../../src/core/config-manager.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/config-manager.js')>()),
  getConfig: vi.fn(async () => ({ version: 1, user: { name: 'test' }, defaults: { priority: 'none' }, provider: { type: 'bedrock' }, plugins: {}, ...(config.experimental ? { experimental: config.experimental } : {}) })),
}))

import { readRouterAreas, sourceTakes, updateRouterAreas, type RouterAreasFile } from '../../src/core/router/areas.js'
import { accountRouterSetup, areaKeptFor, ensureAccountRouter, OWN_ROUTER_AREAS } from '../../src/core/router/account-intake.js'
import { CHAT_SOURCE_SWITCH, chatSourcesEnabled, routerIntake, type RouterIntakeDeps } from '../../src/core/router/plugin-intake.js'
import { EXPERIMENTAL_FEATURES } from '../../src/core/experimental.js'
import { ROUTER_SOURCE_KINDS, type RouterItem, type RouterSourceKind } from '../../src/core/router/types.js'
import { seedTaskStore } from '../helpers/router-task-store.js'

const MAILBOX = 'desk@acme.example.invalid'
const WECHAT = 'account-0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f'
const TEAM = 'T0TEAM'
const roots: string[] = []
const prior = process.env.WALNUT_MAIL_AUTO_ROUTER

beforeEach(() => { process.env.WALNUT_MAIL_AUTO_ROUTER = '1'; config.experimental = undefined })
afterEach(async () => {
  if (prior === undefined) delete process.env.WALNUT_MAIL_AUTO_ROUTER; else process.env.WALNUT_MAIL_AUTO_ROUTER = prior
  for (const root of roots.splice(0)) await fsp.rm(root, { recursive: true, force: true }).catch(() => undefined)
})

type Sources = RouterAreasFile['areas'][number]['sources']
interface AreaSpec { id: string; router: string; sources: Sources }

async function homeWith(specs: AreaSpec[]) {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'router-own-chat-'))
  roots.push(home)
  seedTaskStore(home)
  if (specs.length) {
    await updateRouterAreas(home, () => ({
      version: 1, items: [],
      areas: specs.map((one) => ({ id: one.id, name: one.id, host: '__local__', taskIds: [one.router], sources: one.sources })),
      routers: specs.map((one) => ({ taskId: one.router, areaId: one.id, paused: false })),
    }) as RouterAreasFile)
  }
  return home
}

const PERSONAL: AreaSpec = { id: 'personal', router: 'r-personal', sources: [{ kind: 'mail', account: MAILBOX }] }

/** A creation fake that writes what the Org setup would: the kind's own area from accountRouterSetup, its router open. */
function fakes(home: string, closed: string[] = []) {
  const created: Array<[RouterSourceKind, string]> = []
  const kicks: string[] = []
  const createRouter = async (kind: RouterSourceKind, account: string) => {
    created.push([kind, account])
    const setup = accountRouterSetup(kind, account, 1_000)
    const taskId = `r-${setup.areaId}`
    await updateRouterAreas(home, (current) => ({
      ...current,
      areas: [...current.areas, { id: setup.areaId, name: setup.areaName, host: setup.host, taskIds: [taskId], sources: setup.sources }],
      routers: [...current.routers, { taskId, areaId: setup.areaId, paused: false }],
    }))
    return taskId
  }
  const deps: RouterIntakeDeps = {
    home,
    enabled: async () => true,
    routerOpen: async (id) => !closed.includes(id),
    resolve: async (source): Promise<RouterItem> => ({ source: { ...source }, key: `${source.kind}:${source.account}:${source.message}`, sender: 'fixture', subject: '' }),
    current: async (sources) => [...sources],
    kick: async (areaId) => { kicks.push(areaId) },
    ensure: (kind, account, inner) => ensureAccountRouter(kind, account, {
      ...inner, routerOpen: async (id) => !closed.includes(id),
      // The intake's own guard stays for a kind that may not make a router; the fake stands in for the Org setup otherwise.
      createRouter: inner.createRouter ?? createRouter,
    }),
  }
  return { deps, created, kicks }
}

const msg = (n: number, labels: string[]) => ({ message: `wxid_friend/message_0.db:${n}`, labels })

describe('each chat kind has its own switch', () => {
  it('every chat kind names an experiment in the registry, and no two kinds share one', () => {
    const chatKinds = ROUTER_SOURCE_KINDS.filter((kind) => kind !== 'mail')
    expect(Object.keys(CHAT_SOURCE_SWITCH).sort()).toEqual([...chatKinds].sort())
    const ids = Object.values(CHAT_SOURCE_SWITCH)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(EXPERIMENTAL_FEATURES.some((one) => one.id === id)).toBe(true)
  })

  it('WeChat on leaves Slack off, and Slack on leaves WeChat off', async () => {
    config.experimental = { router_wechat_source: true }
    expect(await chatSourcesEnabled('wechat')).toBe(true)
    expect(await chatSourcesEnabled('slack')).toBe(false)
    config.experimental = { router_chat_sources: true }
    expect(await chatSourcesEnabled('wechat')).toBe(false)
    expect(await chatSourcesEnabled('slack')).toBe(true)
  })

  it('"Every experiment on" with Slack\'s switch set off: WeChat is on, Slack stays off', async () => {
    config.experimental = { every_experiment: true, router_chat_sources: false }
    expect(await chatSourcesEnabled('wechat')).toBe(true)
    expect(await chatSourcesEnabled('slack')).toBe(false)
  })

  it('the intake reads the kind\'s own switch: WeChat off is not taken while Slack\'s is on', async () => {
    const home = await homeWith([PERSONAL])
    const f = fakes(home)
    delete f.deps.enabled
    config.experimental = { router_chat_sources: true }
    expect(await routerIntake('wechat', WECHAT, [msg(1, ['dm'])], f.deps)).toEqual({ taken: false, reason: 'off' })
    expect(f.created).toEqual([])
  })
})

describe('a WeChat account gets a router of its own', () => {
  it('beside the Personal mail router: makes the WeChat router, binds there, never to Personal', async () => {
    const home = await homeWith([PERSONAL])
    const f = fakes(home)
    expect(await routerIntake('wechat', WECHAT, [msg(1, ['dm'])], f.deps)).toMatchObject({ taken: true, areaId: 'wechat', entered: 1 })
    expect(f.created).toEqual([['wechat', WECHAT]])
    expect(f.kicks).toEqual(['wechat'])
    const file = await readRouterAreas(home)
    expect(file.accountBindings).toEqual([expect.objectContaining({ kind: 'wechat', account: WECHAT, areaId: 'wechat' })])
    expect(file.areas.find((one) => one.id === 'personal')!.sources).toEqual([{ kind: 'mail', account: MAILBOX }])
  })

  it('with no router at all: still makes its own (a chat account of another kind would not)', async () => {
    const home = await homeWith([])
    const f = fakes(home)
    expect(await routerIntake('wechat', WECHAT, [], f.deps)).toMatchObject({ taken: true, areaId: 'wechat', entered: 0 })
    expect(await routerIntake('slack', TEAM, [{ message: 'D1/1', labels: ['dm'] }], f.deps)).toEqual({ taken: false, reason: 'none' })
    expect(f.created).toEqual([['wechat', WECHAT]])
  })

  it('the new area starts with direct messages and unmuted groups: muted chats and official accounts are filtered', async () => {
    const home = await homeWith([])
    const f = fakes(home)
    const answer = await routerIntake('wechat', WECHAT, [msg(1, ['dm']), msg(2, ['group']), msg(3, ['muted']), msg(4, ['official'])], f.deps)
    expect(answer).toMatchObject({ taken: true, entered: 2, filtered: 2, skipped: [msg(3, []).message, msg(4, []).message] })
    const entry = (await readRouterAreas(home)).areas.find((one) => one.id === 'wechat')!.sources[0]!
    expect(entry.include).toEqual([...OWN_ROUTER_AREAS.wechat!.include!])
    expect(sourceTakes(entry, ['muted'])).toBe(false)
  })

  it('a second arrival uses the router it made, and makes nothing more', async () => {
    const home = await homeWith([PERSONAL])
    const f = fakes(home)
    await routerIntake('wechat', WECHAT, [msg(1, ['dm'])], f.deps)
    expect(await routerIntake('wechat', WECHAT, [msg(2, ['dm'])], f.deps)).toMatchObject({ taken: true, areaId: 'wechat', entered: 1 })
    expect(f.created).toHaveLength(1)
  })

  it('its own area whose router is closed: the person\'s choice, nothing made beside it, nothing bound', async () => {
    const home = await homeWith([PERSONAL, { id: 'wechat', router: 'r-wechat', sources: [] }])
    const f = fakes(home, ['r-wechat'])
    expect(await routerIntake('wechat', WECHAT, [msg(1, ['dm'])], f.deps)).toEqual({ taken: false, reason: 'choose' })
    expect(f.created).toEqual([])
    expect((await readRouterAreas(home)).accountBindings ?? []).toEqual([])
  })
})

describe('other kinds never land in a kind\'s own area', () => {
  it('a new mailbox beside Personal and the WeChat router goes to Personal', async () => {
    const home = await homeWith([PERSONAL, { id: 'wechat', router: 'r-wechat', sources: [{ kind: 'wechat', account: WECHAT }] }])
    const outcome = await ensureAccountRouter('mail', 'other@acme.example.invalid', { home, routerOpen: async () => true, createRouter: async () => { throw new Error('no router') } })
    expect(outcome).toMatchObject({ bound: true, areaId: 'personal' })
  })

  it('Slack beside Personal and the WeChat router still joins the one shared router', async () => {
    const home = await homeWith([PERSONAL, { id: 'wechat', router: 'r-wechat', sources: [{ kind: 'wechat', account: WECHAT }] }])
    const f = fakes(home)
    expect(await routerIntake('slack', TEAM, [{ message: 'D1/1', labels: ['dm'] }], f.deps)).toMatchObject({ taken: true, areaId: 'personal' })
  })

  it('an area is kept for a kind by its own id or by holding only that kind\'s accounts', () => {
    expect(areaKeptFor({ id: 'wechat', sources: [] })).toBe('wechat')
    expect(areaKeptFor({ id: 'chats', sources: [{ kind: 'wechat', account: WECHAT }] })).toBe('wechat')
    expect(areaKeptFor({ id: 'personal', sources: [{ kind: 'mail', account: MAILBOX }, { kind: 'wechat', account: WECHAT }] })).toBeUndefined()
    expect(areaKeptFor({ id: 'personal', sources: [] })).toBeUndefined()
  })
})
