/**
 * A chat source's direct message reaches its owner through the person's one router, on a real
 * server: a chat plugin registers its cache as the `slack` router source and hands its arrivals to
 * `walnut.router.intake` through the real plugin API; the real binding joins the person's mail
 * router (one router for every channel), the router's filter is set through the real PATCH route,
 * and the real routeItem hands the owner the original text with the source's own permalink as the
 * reference. Only the session send is a stand-in; nothing starts a model, and every file lives in
 * this test's own mocked WALNUT_HOME. All names are invented.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-router-chat-source'))

import yaml from 'js-yaml'
import { CONFIG_FILE, WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { addTask, updateTaskRaw } from '../../src/core/task-manager.js'
import { readRouterAreas, updateRouterAreas } from '../../src/core/router/areas.js'
import { __resetRouterKicks } from '../../src/core/router/plugin-intake.js'
import { disposeRouterStores, routerStore } from '../../src/core/router/runtime.js'
import { routeItem } from '../../src/core/router/service.js'
import type { RouterRoute } from '../../src/core/router/types.js'
import { PluginContext, type PluginLogger } from '../../src/core/plugins/plugin-context.js'
import { createServerPluginApi } from '../../src/core/plugins/server-api.js'
import { IntegrationRegistry } from '../../src/core/integration-registry.js'
import { removePluginOps } from '../../src/ops/registry.js'
import type { PluginRouterItem, PluginRouterItemContent, PluginRouterSource } from '../../packages/plugin-api/src/server.js'
import { createTestPluginApi } from '../core/plugin-test-utils.js'

const TEAM = 'T0TEAM'
const MAILBOX = 'desk@acme.example.invalid'
const PLUGIN = 'chat-fixture'
const permalink = (message: string) => `https://acme.example.invalid/archives/${message.replace('/', '/p').replace('.', '')}`

/** The chat plugin's own cache: what it fetched, with each message's text and channel. */
const CACHE = new Map<string, { channel: string; sender: string; text: string }>([
  ['D1/1700000000.000100', { channel: 'D1', sender: 'U0PAT (Pat)', text: 'DM_BODY_CANARY: can you look at the dock invoice before noon?' }],
  ['D1/1700000000.000200', { channel: 'D1', sender: 'U0PAT (Pat)', text: 'SECOND_DM_CANARY: thanks!' }],
  ['C9/1700000000.000300', { channel: 'C9', sender: 'U0SAM (Sam)', text: 'CHANNEL_CANARY: lunch anyone?' }],
])
const slack = (message: string): PluginRouterSource => ({ kind: 'slack', account: TEAM, message })

const logger: PluginLogger = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(), child: vi.fn(() => logger) }
let context: PluginContext
let api: ReturnType<typeof createServerPluginApi>
let base = ''
const ids = { router: '', owner: '' }
const sent: Array<{ route: RouterRoute; text: string }> = []
const prior = process.env.WALNUT_MAIL_AUTO_ROUTER

function itemOf(one: PluginRouterSource): PluginRouterItem {
  const row = CACHE.get(one.message)
  if (!row || one.account !== TEAM) throw Object.assign(new Error('The exact message is not in the cache.'), { code: 'source_missing' })
  return {
    source: { kind: one.kind, account: one.account, message: one.message }, key: `slack:${TEAM}:${one.message}`, threadKey: row.channel,
    sender: row.sender, subject: '', preview: row.text.slice(0, 40), reference: permalink(one.message),
  }
}

beforeAll(async () => {
  process.env.WALNUT_MAIL_AUTO_ROUTER = '1'
  __resetRouterKicks()
  // The person turned the router_chat_sources experiment on (off, the plugin keeps its own letters).
  await fs.mkdir(path.dirname(CONFIG_FILE), { recursive: true })
  await fs.writeFile(CONFIG_FILE, yaml.dump({ version: 1, user: { name: 'test' }, defaults: { priority: 'none' }, experimental: { router_chat_sources: true } }), 'utf-8')
  const server = await startServer({ port: 0, dev: true })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  ids.router = (await addTask({ title: 'Personal router' })).task.id
  ids.owner = (await addTask({ title: 'Dock invoices', project: 'Dock' })).task.id
  // The person's one router reads a mailbox; no area takes chat yet. It starts paused: its settings
  // save then needs no wake routine (a resume makes one through the daemon, which this test has none
  // of), and a paused router still takes its arrivals for the resume.
  await updateRouterAreas(WALNUT_HOME, () => ({
    version: 1,
    areas: [{ id: 'personal', name: 'Personal', host: '__local__', taskIds: [ids.router], sources: [{ kind: 'mail', account: MAILBOX }] }],
    routers: [{ taskId: ids.router, areaId: 'personal', paused: true }],
    items: [],
    accountBindings: [{ kind: 'mail', account: MAILBOX, areaId: 'personal', boundAt: 1 }],
  }))
  await updateTaskRaw(ids.router, { org_role: 'router', router_area_id: 'personal', router_paused: true }, { source: 'router-areas', emitEvent: false })

  context = new PluginContext({ id: PLUGIN, dataDir: path.join(WALNUT_HOME, 'plugin-data', PLUGIN), logger })
  const { api: legacyApi, collected } = createTestPluginApi({ id: PLUGIN, name: PLUGIN })
  api = createServerPluginApi({ context, pluginName: PLUGIN, legacyApi, contributions: collected, integrationRegistry: new IntegrationRegistry() })
  api.registry.routerSource!('slack', {
    resolve: async (one) => itemOf(one),
    read: async (one): Promise<PluginRouterItemContent> => ({
      item: itemOf(one), body: { text: CACHE.get(one.message)!.text }, bodyAvailable: true, attachments: [], attachmentsAvailable: false,
    }),
    currentSources: async (sources) => sources.filter((one) => CACHE.has(one.message)),
  })
})

afterAll(async () => {
  try {
    await context?.dispose().catch(() => undefined)
    removePluginOps(PLUGIN)
    await disposeRouterStores()
    await stopServer()
  } finally {
    if (prior === undefined) delete process.env.WALNUT_MAIL_AUTO_ROUTER; else process.env.WALNUT_MAIL_AUTO_ROUTER = prior
    await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  }
})

const openMessages = async () => ((await readRouterAreas(WALNUT_HOME)).openItems ?? []).map((one) => one.source.message)

describe('a chat direct message through the one router', () => {
  it('the first arrival binds the chat account to the person\'s mail router and enters as an open item', async () => {
    const result = await api.router!.intake('slack', TEAM, [{ message: 'D1/1700000000.000100', labels: ['dm'] }])
    expect(result).toEqual({ taken: true, areaId: 'personal', entered: 1, filtered: 0, skipped: [] })
    const file = await readRouterAreas(WALNUT_HOME)
    expect(file.areas.map((one) => one.id)).toEqual(['personal'])
    expect(file.areas[0]!.sources).toEqual([{ kind: 'mail', account: MAILBOX }, { kind: 'slack', account: TEAM }])
    expect(file.accountBindings?.map((one) => [one.kind, one.account, one.areaId])).toEqual([['mail', MAILBOX, 'personal'], ['slack', TEAM, 'personal']])
    expect(await openMessages()).toEqual(['D1/1700000000.000100'])
  })

  it('another plugin cannot enter this kind\'s arrivals: only the plugin that serves slack may', async () => {
    const otherContext = new PluginContext({ id: 'other-fixture', dataDir: path.join(WALNUT_HOME, 'plugin-data', 'other-fixture'), logger })
    const legacy = createTestPluginApi({ id: 'other-fixture', name: 'other-fixture' })
    const other = createServerPluginApi({ context: otherContext, pluginName: 'other-fixture', legacyApi: legacy.api, contributions: legacy.collected, integrationRegistry: new IntegrationRegistry() })
    try {
      await expect(other.router!.intake('slack', 'T0FORGED', [{ message: 'D1/1700000000.000200', labels: ['dm'] }])).rejects.toBeInstanceOf(TypeError)
      expect((await readRouterAreas(WALNUT_HOME)).accountBindings?.map((one) => one.account)).toEqual([MAILBOX, TEAM])
      expect(await openMessages()).toEqual(['D1/1700000000.000100'])
    } finally {
      await otherContext.dispose().catch(() => undefined)
      removePluginOps('other-fixture')
    }
  })

  it('the router\'s filter, set through its settings route, keeps channel chatter out', async () => {
    const response = await fetch(`${base}/api/v1/org/routers/${encodeURIComponent(ids.router)}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filters: [{ kind: 'slack', account: TEAM, include: ['dm', 'mention'] }] }),
    })
    expect(response.status, await response.text()).toBe(200)
    const result = await api.router!.intake('slack', TEAM, [
      { message: 'C9/1700000000.000300', labels: ['channel:random'] },
      { message: 'D1/1700000000.000200', labels: ['DM'] },
    ])
    // The one the filter left out is named, so the plugin handles it its own way.
    expect(result).toEqual({ taken: true, areaId: 'personal', entered: 1, filtered: 1, skipped: ['C9/1700000000.000300'] })
    expect(await openMessages()).toEqual(['D1/1700000000.000100', 'D1/1700000000.000200'])
    // The filter is saved on the account's own source row.
    expect((await readRouterAreas(WALNUT_HOME)).areas[0]!.sources[1]).toEqual({ kind: 'slack', account: TEAM, include: ['dm', 'mention'], includeAt: expect.any(Number) })
  })

  it('the person resumes the router (written as a resume leaves it, without the wake routine)', async () => {
    await updateRouterAreas(WALNUT_HOME, (file) => ({ ...file, routers: file.routers.map((one) => ({ ...one, paused: false })) }))
    await updateTaskRaw(ids.router, { router_paused: false }, { source: 'router-edit', emitEvent: false })
    expect((await readRouterAreas(WALNUT_HOME)).routers).toEqual([{ taskId: ids.router, areaId: 'personal', paused: false }])
  })

  it('hands the owner the original text and the source\'s permalink as the reference', async () => {
    const result = await routeItem(
      { source: slack('D1/1700000000.000100'), taskId: ids.owner, reason: 'Dock invoices go to this task.', byTaskId: ids.router, text: 'Pat asks about the dock invoice.' },
      { send: async (route, text) => { sent.push({ route, text }) } },
    )
    expect(result).toMatchObject({ fresh: true, route: { status: 'routed', taskId: ids.owner } })
    expect(sent).toHaveLength(1)
    const text = sent[0]!.text
    expect(text.split('\n')[0]).toBe('The router hands you this incoming Slack message: it is yours to handle from here (do the work, hand it on, or ask your VP).')
    expect(text).toContain(`Reference: ${permalink('D1/1700000000.000100')}`)
    expect(text).toContain('From: "U0PAT (Pat)"')
    expect(text).toContain('Pat asks about the dock invoice.')
    expect(text).toContain('DM_BODY_CANARY: can you look at the dock invoice before noon?')
    expect(text).not.toContain('SECOND_DM_CANARY')
    expect(text).not.toContain('mail_read')
    expect((await routerStore('personal').getSource(slack('D1/1700000000.000100')))?.status).toBe('routed')
  })

  it('a message the filter kept out is no item of the router: routing it is refused and nothing is sent', async () => {
    await expect(routeItem(
      { source: slack('C9/1700000000.000300'), taskId: ids.owner, reason: 'r', byTaskId: ids.router, text: 'brief' },
      { send: async (route, text) => { sent.push({ route, text }) } },
    )).rejects.toMatchObject({ code: 'area_unassigned' })
    expect(sent).toHaveLength(1)
  })
})
