/**
 * A surface outside Mail (a Slack message) asks where the router sent an item by its message id
 * alone (src/core/router/item-routes.ts, GET /api/v1/router/routes).
 *
 * Why (2026-11-16): every arrival is entered with its delivery version, and the area and the ledger
 * both key on it, so an ask without one matched nothing on real data and every item read as
 * unrouted. The fixture enters every item versioned, as live areas do; all names are invented.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readRouterAreas, updateRouterAreas, type RouterAreasFile } from '../../src/core/router/areas.js'
import { itemRoutes } from '../../src/core/router/item-routes.js'
import { routerStore } from '../../src/core/router/runtime.js'
import { routeItem, type RouterDeliveryDeps } from '../../src/core/router/service.js'
import { routerKey } from '../../src/core/router/store.js'
import { ROUTER_SOURCE_KINDS, type RouterItem, type RouterSource, type RouterSourceKind } from '../../src/core/router/types.js'
import type { Task } from '../../src/core/types.js'
import { seedTaskStore } from '../helpers/router-task-store.js'

const ACCOUNT = 'desk@maple-cafe.example.invalid'
const source = (kind: RouterSourceKind, message: string, version = `v2-${message}`): RouterSource => ({ kind, account: ACCOUNT, message, version })
const itemFor = (one: RouterSource): RouterItem => ({ source: { ...one }, key: routerKey(one), sender: 'robin@maple-cafe.example.invalid', subject: 'Pastry order' })

let home: string
let areas: RouterAreasFile
const OLD = source('slack', 'C1/1.1', 'v1-C1/1.1')
const NEW = source('slack', 'C1/1.1')
const MAIL = source('mail', 'INBOX:1:7')

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'router-item-routes-'))
  seedTaskStore(home)
  await updateRouterAreas(home, () => ({
    version: 1,
    areas: [{ id: 'cafe', name: 'Cafe', host: '__local__', taskIds: ['router'], sources: ROUTER_SOURCE_KINDS.map((kind) => ({ kind, account: ACCOUNT })) }],
    routers: [{ taskId: 'router', areaId: 'cafe', paused: false }],
    items: [],
    // An edited message is entered again with its new version, after the first.
    openItems: [OLD, NEW, MAIL].map((one) => ({ source: one, areaId: 'cafe' })),
  }))
  areas = await readRouterAreas(home)
})

afterEach(async () => {
  await routerStore('cafe', home).dispose().catch(() => undefined)
  if (home && path.basename(home).startsWith('router-item-routes-')) fs.rmSync(home, { recursive: true, force: true })
})

function deps(): RouterDeliveryDeps {
  return {
    areas, store: routerStore('cafe', home), letter: vi.fn(async () => 'lt-1'), noise: null,
    resolve: async (one) => itemFor(one),
    getTask: async (id) => ({ id, title: id === 'router' ? 'Cafe router' : 'Pastry orders', org_role: id === 'router' ? 'router' : undefined, phase: 'IN_PROGRESS' }) as Task,
    send: async () => ({ ok: true }),
  }
}

describe('where an item went, asked by its message id alone', () => {
  it('finds the newest delivery the area lists, and its route', async () => {
    await routeItem({ source: NEW, taskId: 'pastry', reason: 'The pastry order task owns it', text: 'Robin changed the order.', byTaskId: 'router' }, deps())
    await routeItem({ source: MAIL, notRouted: true, reason: 'A receipt', byTaskId: 'router' }, deps())
    const slack = await itemRoutes([{ kind: 'slack', account: ACCOUNT, message: NEW.message }], home)
    expect(slack[NEW.message]).toMatchObject({ area: { id: 'cafe' }, route: { status: 'routed', taskId: 'pastry' } })
    const mail = await itemRoutes([{ kind: 'mail', account: ACCOUNT, message: MAIL.message }], home)
    expect(mail[MAIL.message]).toMatchObject({ area: { id: 'cafe' }, route: { status: 'not_routed' } })
  })

  it('an item the area lists but no router decided yet has its area and no route', async () => {
    const out = await itemRoutes([{ kind: 'mail', account: ACCOUNT, message: MAIL.message }], home)
    expect(out[MAIL.message]).toEqual({ area: { id: 'cafe', name: 'Cafe' } })
  })

  it('an item no area lists, and another account, read nothing', async () => {
    const out = await itemRoutes([
      { kind: 'mail', account: ACCOUNT, message: 'INBOX:1:999' },
      { kind: 'mail', account: 'other@maple-cafe.example.invalid', message: MAIL.message },
    ], home)
    expect(out).toEqual({})
  })

  // Guard: every kind a surface may ask about is found without its version.
  it.each(ROUTER_SOURCE_KINDS)('a %s item is found without its version', async (kind) => {
    const one = source(kind, `${kind}-msg-1`)
    await updateRouterAreas(home, (file) => ({ ...file, openItems: [...(file.openItems ?? []), { source: one, areaId: 'cafe' }] }))
    const out = await itemRoutes([{ kind, account: ACCOUNT, message: one.message }], home)
    expect(out[one.message]?.area?.id).toBe('cafe')
  })
})
