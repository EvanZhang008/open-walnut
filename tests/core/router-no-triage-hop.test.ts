/**
 * Guard: no separate triage hop between a mailbox and its router.
 *
 * Decision 2026-11-14, Evan: "mailbox goes straight to the router; the router itself is the triage;
 * no separate triage in between". The router hands each item straight to the open task, VP or Main
 * that owns it and never creates tasks. If any of these fail, a triage hop (router-made work, a
 * person-confirmed hand-off, rules) is coming back: talk to the owner before changing this file.
 *
 * Real server, task store, areas file and ledger under this test's own mocked home; only the item's
 * source and the session send are stand-ins. All names are invented.
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-router-no-triage-hop'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import * as taskManager from '../../src/core/task-manager.js'
import { readRouterAreas, updateRouterAreas, type RouterAreasFile } from '../../src/core/router/areas.js'
import { registerRouterSource } from '../../src/core/router/source-registry.js'
import { disposeRouterStores, routerStore } from '../../src/core/router/runtime.js'
import { routeItem } from '../../src/core/router/service.js'
import { routerKey } from '../../src/core/router/store.js'
import type { RouterRoute, RouterSource } from '../../src/core/router/types.js'
import { getOp } from '../../src/ops/index.js'
import { createMailRouterIntake } from '../../src/integrations/mail/router-intake.js'
import type { MailboxRow, MessageRow } from '../../src/integrations/mail/store.js'
import { mailRowDeliveryVersion } from '../../src/integrations/mail/router-source.js'

const REPO = path.resolve(import.meta.dirname, '..', '..')
const DESK = 'desk@marina.example.invalid'
const item = (message: string): RouterSource => ({ kind: 'mail', account: DESK, message, version: `v-${message}` })
const HTTP_ITEM = item('INBOX:1:1')
const CORE_ITEM = item('INBOX:1:2')

let base = ''
let routerId = ''
let ownerId = ''
let stopSource = () => {}

const post = (p: string, body: unknown) => fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

beforeAll(async () => {
  const server = await startServer({ port: 0, dev: true })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  routerId = (await taskManager.addTask({ title: 'Mail router', project: '' })).task.id
  ownerId = (await taskManager.addTask({ title: 'Dock slot follow-up', project: 'Marina' })).task.id
  await updateRouterAreas(WALNUT_HOME, () => ({
    version: 1,
    areas: [{ id: 'mail', name: 'Mail', host: '__local__', taskIds: [routerId], sources: [{ kind: 'mail', account: DESK }] }],
    routers: [{ taskId: routerId, areaId: 'mail', paused: false }],
    items: [],
    openItems: [{ source: HTTP_ITEM, areaId: 'mail' }, { source: CORE_ITEM, areaId: 'mail' }],
  }))
  await taskManager.updateTaskRaw(routerId, { org_role: 'router', router_area_id: 'mail', router_paused: false }, { source: 'router-areas', emitEvent: false })
  stopSource = registerRouterSource('mail', {
    resolve: async (source) => ({ source: { ...source }, key: routerKey(source), sender: 'pat@marina.example.invalid', subject: 'Dock slot' }),
    read: async (source) => ({
      item: { source: { ...source }, key: routerKey(source), sender: 'pat@marina.example.invalid', subject: 'Dock slot' },
      body: { text: 'Can we move the slot?' }, bodyAvailable: true, attachments: [], attachmentsAvailable: false,
    }),
  })
})

afterAll(async () => {
  stopSource()
  await disposeRouterStores()
  await stopServer()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
})

describe('the router never makes work (POST /api/v1/router/route)', () => {
  it('refuses new_task_title with no_new_work, writing no receipt and no task', async () => {
    const before = (await taskManager.listTasks({})).length
    const response = await post('/api/v1/router/route', { source: HTTP_ITEM, new_task_title: 'Dock follow-up', reason: 'No open work owns it', text: 'Brief' })
    expect(response.status).toBe(400)
    expect((await response.json()).error.code).toBe('no_new_work')
    expect(await routerStore('mail').getSource(HTTP_ITEM)).toBeUndefined()
    expect((await taskManager.listTasks({})).length).toBe(before)
  })

  it('refuses a rule or a hand-off confirmation with bad_decision', async () => {
    for (const extra of [{ rule_id: 'rule-dock' }, { approval_id: 'approval-1' }]) {
      const response = await post('/api/v1/router/route', { source: HTTP_ITEM, task_id: ownerId, reason: 'Dock', text: 'Brief', ...extra })
      expect(response.status).toBe(400)
      expect((await response.json()).error.code).toBe('bad_decision')
    }
    expect(await routerStore('mail').getSource(HTTP_ITEM)).toBeUndefined()
  })

  it('router_route takes no new_task_title, and no router_item or router_work op exists', () => {
    const op = getOp('router_route')
    expect(op).toBeDefined()
    expect(Object.keys(op!.input ?? {})).not.toContain('new_task_title')
    expect(Object.keys(op!.input ?? {})).not.toContain('rule_id')
    expect(getOp('router_item')).toBeUndefined()
    expect(getOp('router_work')).toBeUndefined()
  })
})

describe('routeItem never creates a task', () => {
  it('hands an item to existing work and refuses a router, with no task-creating call at all', async () => {
    const spies = [vi.spyOn(taskManager, 'addTask'), vi.spyOn(taskManager, 'addTaskFull'), vi.spyOn(taskManager, 'addTasksBulk')]
    try {
      const before = (await taskManager.listTasks({})).map((task) => task.id).sort()
      const sent: RouterRoute[] = []
      const send = async (route: RouterRoute) => { sent.push(route) }
      await expect(routeItem({ source: CORE_ITEM, taskId: routerId, reason: 'Loop', byTaskId: routerId, text: 'Brief' }, { send }))
        .rejects.toMatchObject({ code: 'router_loop' })
      const result = await routeItem({ source: CORE_ITEM, taskId: ownerId, reason: 'It owns the dock slot', byTaskId: routerId, text: 'Brief' }, { send })
      expect(result.route).toMatchObject({ status: 'routed', taskId: ownerId })
      expect(sent).toHaveLength(1)
      for (const spy of spies) expect(spy).not.toHaveBeenCalled()
      expect((await taskManager.listTasks({})).map((task) => task.id).sort()).toEqual(before)
      // The registry gained no member: an area lists only its routers.
      expect((await readRouterAreas(WALNUT_HOME)).areas[0]!.taskIds).toEqual([routerId])
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
  })
})

describe('source ratchet', () => {
  function sourceFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) return sourceFiles(full)
      return /\.(ts|tsx|js|mjs)$/.test(entry.name) ? [full] : []
    })
  }

  it('no file under src/ names router-made work or registers router_item / router_work', () => {
    const offenders: string[] = []
    for (const file of sourceFiles(path.join(REPO, 'src'))) {
      const text = fs.readFileSync(file, 'utf-8')
      for (const pattern of [/router-work:/, /ensureRouterNewWork/, /name:\s*['"]router_(item|work)['"]/]) {
        if (pattern.test(text)) offenders.push(`${path.relative(REPO, file)}: ${pattern}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('the router_route op declares no new_task_title input', () => {
    const text = fs.readFileSync(path.join(REPO, 'src', 'ops', 'router.ts'), 'utf-8')
    const start = text.indexOf("name: 'router_route'")
    expect(start).toBeGreaterThan(-1)
    const end = text.indexOf('defineOp(', start)
    expect(text.slice(start, end < 0 ? undefined : end)).not.toMatch(/new_task_title\s*:/)
  })

  it('the mail intake path never imports the triage code', () => {
    for (const file of ['src/integrations/mail/router-intake.ts', 'src/core/router/account-intake.ts', 'src/core/router/service.ts', 'src/core/router/wake.ts']) {
      const text = fs.readFileSync(path.join(REPO, file), 'utf-8')
      expect(text, file).not.toMatch(/from\s+['"][^'"]*\/triage\/|import\(\s*['"][^'"]*\/triage\//)
    }
  })
})

describe('the mail intake hands a new inbox mail only to the router', () => {
  it('enters the arrival through confirmAccount and nothing else', async () => {
    const row = {
      rowid: 1, account_id: 'acct', message_id: 'inbox:m-1', rfc_message_id: 'rfc-1@example.invalid', mailbox_id: 'inbox',
      thread_id: 't-1', from_addr: 'pat@example.invalid', subject: 'Dock slot', snippet: 'Can we move it?', sent_at: 1000, received_at: 1000,
      flags_json: '[]', attachments_json: '[]', body_ref: null, body_bytes: null, payload: '{}', updated_at: 1000, envelope_hash: 'h', body_error: null,
    } as MessageRow
    const version = mailRowDeliveryVersion(row)
    const areas: RouterAreasFile = {
      version: 1,
      areas: [{ id: 'mail', name: 'Mail', host: '__local__', taskIds: ['router-1'], sources: [{ kind: 'mail', account: 'acct' }] }],
      routers: [{ taskId: 'router-1', areaId: 'mail', paused: false }],
      items: [],
      accountBindings: [{ kind: 'mail', account: 'acct', areaId: 'mail', boundAt: 1 }],
    }
    const confirmAccount = vi.fn(async (sources: readonly RouterSource[]) => sources)
    const capture = createMailRouterIntake({
      store: {
        messagesByIds: async () => [row],
        listMailboxes: async () => [{ mailbox_id: 'inbox', role: 'inbox', name: 'Inbox' } as MailboxRow],
      },
      home: '/walnut-home-under-test',
      readAreas: async () => areas,
      routerOpen: async () => true,
      ensureRouter: async () => ({ bound: true, areaId: 'mail', created: false, already: true }),
      confirmAccount,
      now: () => 2000,
    })
    const finish = await capture('acct', [{ from: row.from_addr, subject: row.subject, messageId: row.message_id, version }])
    const shown = await finish()
    expect(confirmAccount).toHaveBeenCalledTimes(1)
    expect(confirmAccount.mock.calls[0]![0]).toEqual([{ kind: 'mail', account: 'acct', message: 'inbox:m-1', version }])
    expect(shown).toMatchObject([{ messageId: 'inbox:m-1', version }])
  })
})
