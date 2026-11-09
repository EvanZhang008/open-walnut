/**
 * The area route lock (src/core/router/route-lock.ts) around `routeItem`: a route waits for a
 * holder of its area's lock (a migration rollback), then reads and authorizes again, so a router
 * paused while it waited makes no claim. Real RouterStore under this test's temp home; the cache,
 * the task store and the send are fakes. All names are invented.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RouterAreasFile } from '../../src/core/router/areas.js'
import { ROUTE_LOCK_WAIT_MS, RouteLockBusyError, routeLockPath, routeLockPathForLedger, withAreaRouteLock, withLedgerRouteLock } from '../../src/core/router/route-lock.js'
import { routeItem, RouterError, type RouteItemInput, type RouterDeliveryDeps } from '../../src/core/router/service.js'
import { RouterStore, routerKey } from '../../src/core/router/store.js'
import type { RouterItem, RouterRoute, RouterSource } from '../../src/core/router/types.js'
import type { Task } from '../../src/core/types.js'

const ITEM: RouterSource = { kind: 'mail', account: 'desk@marina.example.invalid', message: 'INBOX:1:10' }
const ITEM_2: RouterSource = { kind: 'mail', account: 'desk@marina.example.invalid', message: 'INBOX:1:11' }

let home: string
let ledger: RouterStore
let areas: RouterAreasFile

function deps(extra: Partial<RouterDeliveryDeps> = {}): RouterDeliveryDeps {
  return {
    areas, store: ledger,
    resolve: vi.fn(async (source: RouterSource): Promise<RouterItem> => ({ source: { ...source }, key: routerKey(source), sender: 'pat@marina.example.invalid', subject: 'Dock' })),
    getTask: vi.fn(async (id: string) => ({ id, title: id, phase: 'IN_PROGRESS' }) as Task),
    send: vi.fn(async (_route: RouterRoute, _text: string): Promise<unknown> => ({ ok: true })),
    ...extra,
  }
}

const input = (extra: Partial<RouteItemInput> = {}): RouteItemInput =>
  ({ source: { ...ITEM }, taskId: 'task-worker', reason: 'Dock requests go to the dock task', text: 'Confirm the slot.', byTaskId: 'task-router', ...extra })

function holder() {
  let release!: () => void
  let holding!: () => void
  const held = new Promise<void>((resolve) => { holding = resolve })
  const gate = new Promise<void>((resolve) => { release = resolve })
  return { held, release: () => release(), work: async () => { holding(); await gate } }
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'router-route-lock-'))
  ledger = new RouterStore(home, 'personal')
  areas = {
    version: 1,
    areas: [{ id: 'personal', name: 'Personal', host: '__local__', taskIds: ['task-router', 'task-worker'], sources: [{ kind: 'mail', account: ITEM.account }] }],
    routers: [{ taskId: 'task-router', areaId: 'personal', paused: false }],
    items: [{ source: { ...ITEM }, areaId: 'personal' }, { source: { ...ITEM_2 }, areaId: 'personal' }],
  }
})

afterEach(async () => {
  await ledger.dispose()
  fs.rmSync(home, { recursive: true, force: true })
})

describe('route lock', () => {
  it('names one lock per area, beside the ledger file the area writes', () => {
    expect(routeLockPath(home, 'personal')).toBe(routeLockPathForLedger(ledger.file))
    expect(routeLockPath(home, 'work')).not.toBe(routeLockPath(home, 'personal'))
    expect(() => routeLockPath('relative/home', 'personal')).toThrow(/absolute/)
  })

  it('a route waits for the holder and reads the router again: paused meanwhile, it claims nothing', async () => {
    const rollback = holder()
    const held = withAreaRouteLock(home, 'personal', rollback.work)
    await rollback.held
    const d = deps()
    const route = routeItem(input(), d).then(() => 'routed', (e: { code?: string }) => e.code)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(d.resolve).not.toHaveBeenCalled()
    // What the rollback does while it holds the lock: the router is paused.
    areas.routers[0]!.paused = true
    rollback.release()
    await held
    expect(await route).toBe('area_forbidden')
    expect(await ledger.hasRouterDecisions()).toBe(false)
    expect(d.send).not.toHaveBeenCalled()
  })

  it('a route holds the lock through its send and settle', async () => {
    const probes: string[] = []
    const d = deps({
      send: vi.fn(async () => {
        probes.push(await withAreaRouteLock(home, 'personal', async () => 'free', { timeoutMs: 30 })
          .catch((e) => e instanceof RouteLockBusyError ? 'held' : String(e)))
        return { ok: true }
      }),
    })
    const result = await routeItem(input(), d)
    expect(result.route.status).toBe('routed')
    expect(probes).toEqual(['held'])
    expect(await withLedgerRouteLock(ledger, async () => 'free', { timeoutMs: 30 })).toBe('free')
  })

  it('waits ten seconds by default', () => {
    expect(ROUTE_LOCK_WAIT_MS).toBe(10_000)
  })

  it('a route that cannot get the lock in time is refused before its claim: no row, no send, never an unknown delivery', async () => {
    const rollback = holder()
    const held = withAreaRouteLock(home, 'personal', rollback.work)
    await rollback.held
    const busy = await withLedgerRouteLock(ledger, async () => 'ran', { timeoutMs: 30 }).catch((e) => e)
    expect(busy).toBeInstanceOf(RouteLockBusyError)
    expect(busy).toMatchObject({ code: 'area_route_busy', status: 503 })
    const d = deps({ routeLockWaitMs: 30 })
    const refused = await routeItem(input(), d).catch((e) => e)
    expect(refused).toBeInstanceOf(RouterError)
    expect(refused).toMatchObject({ code: 'area_route_busy', status: 503 })
    expect(d.resolve).not.toHaveBeenCalled()
    expect(d.send).not.toHaveBeenCalled()
    rollback.release()
    await held
    expect(await ledger.getSource(ITEM)).toBeUndefined()
    expect(await ledger.hasRouterDecisions()).toBe(false)
  })

  it('two routes of one area queue: both are delivered and settled, neither is busy or unknown', async () => {
    let inSend = 0
    let overlap = false
    const send = vi.fn(async () => {
      inSend++
      if (inSend > 1) overlap = true
      await new Promise((resolve) => setTimeout(resolve, 50))
      inSend--
      return { ok: true }
    })
    const [one, two] = await Promise.all([routeItem(input(), deps({ send })), routeItem(input({ source: { ...ITEM_2 } }), deps({ send }))])
    expect([one.route.status, two.route.status]).toEqual(['routed', 'routed'])
    expect([one.fresh, two.fresh]).toEqual([true, true])
    expect(overlap).toBe(false)
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('an error from the work itself passes through unchanged', async () => {
    const own = new Error('send failed')
    await expect(withAreaRouteLock(home, 'personal', async () => { throw own })).rejects.toBe(own)
  })
})
