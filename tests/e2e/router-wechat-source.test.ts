/**
 * A WeChat message reaches its owner through a WeChat router of its own, on a real server: a chat
 * plugin registers its cache as the `wechat` router source and hands its arrivals to
 * `walnut.router.intake` through the real plugin API. With only WeChat's switch on, the first
 * arrival makes the WeChat router through the real Org setup (beside the person's mail router, never
 * joining it), the Org's routers route lists it, Slack's arrivals stay off, and the real routeItem
 * hands the owner the original text with the plugin's read as the reference. Only the session send
 * and the wake routine are stand-ins; nothing starts a model, and every file lives in this test's own
 * mocked WALNUT_HOME. All names are invented.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-router-wechat-source'))
// The router's wake routine needs a session daemon this test has none of; its arming is recorded instead.
const wakes = vi.hoisted(() => ({ armed: [] as string[] }))
vi.mock('../../src/core/router/wake.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/router/wake.js')>()),
  configureRouterWake: vi.fn(async (task: { id: string; router_paused?: boolean }) => { if (task.router_paused === false) wakes.armed.push(task.id) }),
}))

import yaml from 'js-yaml'
import { CONFIG_FILE, WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { addTask, getTask, updateTaskRaw } from '../../src/core/task-manager.js'
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

const ACCOUNT = 'account-0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f'
const MAILBOX = 'desk@acme.example.invalid'
const PLUGIN = 'wechat-fixture'
const DM = 'wxid_pat/message_0.db:101'
const MUTED = '42@chatroom/message_0.db:102'

const CACHE = new Map<string, { conversationId: string; sender: string; text: string }>([
  [DM, { conversationId: 'wxid_pat', sender: 'Pat', text: 'WECHAT_DM_CANARY: is the dock invoice paid?' }],
  [MUTED, { conversationId: '42@chatroom', sender: 'Sam', text: 'MUTED_CANARY: lunch?' }],
])
const wechat = (message: string): PluginRouterSource => ({ kind: 'wechat', account: ACCOUNT, message })
const reference = (conversationId: string) => `wechat_messages ${JSON.stringify({ conversationId, limit: 20 })}`

const logger: PluginLogger = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(), child: vi.fn(() => logger) }
let context: PluginContext
let api: ReturnType<typeof createServerPluginApi>
let base = ''
const ids = { personal: '', owner: '' }
const sent: Array<{ route: RouterRoute; text: string }> = []
const prior = process.env.WALNUT_MAIL_AUTO_ROUTER

function itemOf(one: PluginRouterSource): PluginRouterItem {
  const row = CACHE.get(one.message)
  if (!row || one.account !== ACCOUNT) throw Object.assign(new Error('The exact message is not in the cache.'), { code: 'source_missing' })
  return {
    source: { kind: one.kind, account: one.account, message: one.message }, key: `wechat:${ACCOUNT}:${one.message}`,
    threadKey: `wechat:${ACCOUNT}:${row.conversationId}`, sender: row.sender, subject: `a WeChat message from ${row.sender}`,
    preview: row.text.slice(0, 40), reference: reference(row.conversationId),
  }
}

beforeAll(async () => {
  process.env.WALNUT_MAIL_AUTO_ROUTER = '1'
  __resetRouterKicks()
  // The person's settings: every experiment on, Slack's chat router explicitly off.
  await fs.mkdir(path.dirname(CONFIG_FILE), { recursive: true })
  await fs.writeFile(CONFIG_FILE, yaml.dump({ version: 1, user: { name: 'test' }, defaults: { priority: 'none' },
    experimental: { every_experiment: true, router_chat_sources: false } }), 'utf-8')
  const server = await startServer({ port: 0, dev: true })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  ids.personal = (await addTask({ title: 'Personal router' })).task.id
  ids.owner = (await addTask({ title: 'Dock invoices', project: 'Dock' })).task.id
  await updateRouterAreas(WALNUT_HOME, () => ({
    version: 1,
    areas: [{ id: 'personal', name: 'Personal', host: '__local__', taskIds: [ids.personal], sources: [{ kind: 'mail', account: MAILBOX }] }],
    routers: [{ taskId: ids.personal, areaId: 'personal', paused: false }],
    items: [],
    accountBindings: [{ kind: 'mail', account: MAILBOX, areaId: 'personal', boundAt: 1 }],
  }))
  await updateTaskRaw(ids.personal, { org_role: 'router', router_area_id: 'personal', router_paused: false }, { source: 'router-areas', emitEvent: false })

  context = new PluginContext({ id: PLUGIN, dataDir: path.join(WALNUT_HOME, 'plugin-data', PLUGIN), logger })
  const { api: legacyApi, collected } = createTestPluginApi({ id: PLUGIN, name: PLUGIN })
  api = createServerPluginApi({ context, pluginName: PLUGIN, legacyApi, contributions: collected, integrationRegistry: new IntegrationRegistry() })
  const read = async (one: PluginRouterSource): Promise<PluginRouterItemContent> => ({
    item: itemOf(one), body: { text: CACHE.get(one.message)!.text }, bodyAvailable: true, attachments: [], attachmentsAvailable: false,
  })
  api.registry.routerSource!('wechat', { resolve: async (one) => itemOf(one), read })
  api.registry.routerSource!('slack', { resolve: async (one) => itemOf(one), read })
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

describe('WeChat messages through a WeChat router of their own', () => {
  let wechatRouter = ''

  it('the first arrival makes the WeChat router, running, and binds the account there, not to Personal', async () => {
    const result = await api.router!.intake('wechat', ACCOUNT, [{ message: DM, labels: ['dm'] }, { message: MUTED, labels: ['muted'] }])
    // Muted chats are left out by the new router's starting filter, and named for the plugin.
    expect(result).toEqual({ taken: true, areaId: 'wechat', entered: 1, filtered: 1, skipped: [MUTED] })
    const file = await readRouterAreas(WALNUT_HOME)
    const area = file.areas.find((one) => one.id === 'wechat')!
    expect(area).toMatchObject({ name: 'WeChat', host: '__local__', sources: [{ kind: 'wechat', account: ACCOUNT, include: ['dm', 'group'] }] })
    expect(file.areas.find((one) => one.id === 'personal')!.sources).toEqual([{ kind: 'mail', account: MAILBOX }])
    expect(file.accountBindings?.find((one) => one.kind === 'wechat')).toMatchObject({ account: ACCOUNT, areaId: 'wechat' })
    const router = file.routers.find((one) => one.areaId === 'wechat')!
    expect(router.paused).toBe(false)
    wechatRouter = router.taskId
    const task = await getTask(wechatRouter)
    expect(task).toMatchObject({ org_role: 'router', router_area_id: 'wechat', router_paused: false, org_name: 'WeChat router' })
    expect(wakes.armed).toContain(wechatRouter)
    expect((file.openItems ?? []).map((one) => one.source.message)).toEqual([DM])
  })

  it('the Org lists it among the routers, with WeChat as what it reads', async () => {
    const response = await fetch(`${base}/api/v1/router/areas`)
    expect(response.status).toBe(200)
    const body = await response.json() as { areas: Array<{ id: string; sources: Array<{ kind: string }> }>; routers: Array<{ taskId: string; areaId: string }> }
    expect(body.routers.map((one) => one.areaId).sort()).toEqual(['personal', 'wechat'])
    expect(body.areas.find((one) => one.id === 'wechat')!.sources.map((one) => one.kind)).toEqual(['wechat'])
  })

  it('a second arrival goes to the same router; Slack, with its own switch off, is not taken at all', async () => {
    CACHE.set('wxid_pat/message_0.db:103', { conversationId: 'wxid_pat', sender: 'Pat', text: 'SECOND_CANARY' })
    expect(await api.router!.intake('wechat', ACCOUNT, [{ message: 'wxid_pat/message_0.db:103', labels: ['dm'] }]))
      .toMatchObject({ taken: true, areaId: 'wechat', entered: 1 })
    expect(await api.router!.intake('slack', 'T0TEAM', [{ message: 'D1/1', labels: ['dm'] }])).toEqual({ taken: false, reason: 'off' })
    expect((await readRouterAreas(WALNUT_HOME)).routers).toHaveLength(2)
  })

  it('hands the owner the original WeChat text, with the plugin\'s read as the reference', async () => {
    const result = await routeItem(
      { source: wechat(DM), taskId: ids.owner, reason: 'Dock invoices go to this task.', byTaskId: wechatRouter, text: 'Pat asks whether the dock invoice is paid.' },
      { send: async (route, text) => { sent.push({ route, text }) } },
    )
    expect(result).toMatchObject({ fresh: true, route: { status: 'routed', taskId: ids.owner } })
    const text = sent[0]!.text
    expect(text.split('\n')[0]).toBe('The router hands you this incoming WeChat message: it is yours to handle from here (do the work, hand it on, or ask your VP).')
    expect(text).toContain(`Reference: ${reference('wxid_pat')}`)
    expect(text).toContain('WECHAT_DM_CANARY: is the dock invoice paid?')
    expect(text).not.toContain('SECOND_CANARY')
    expect((await routerStore('wechat').getSource(wechat(DM)))?.status).toBe('routed')
  })

  it('where that message went reads back for the WeChat page, by its exact id', async () => {
    const url = `${base}/api/v1/router/routes?kind=wechat&account=${encodeURIComponent(ACCOUNT)}&messages=${encodeURIComponent(JSON.stringify([DM, MUTED]))}`
    const response = await fetch(url)
    expect(response.status, await response.clone().text()).toBe(200)
    const body = await response.json() as { routes: Record<string, { route?: { status: string; taskId?: string } }> }
    expect(body.routes[DM]?.route).toMatchObject({ status: 'routed', taskId: ids.owner })
    expect(body.routes[MUTED]?.route).toBeUndefined()
  })
})
