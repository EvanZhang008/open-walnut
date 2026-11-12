/**
 * The inbound router's delivery decision (src/core/router/service.ts `routeItem`), against a real
 * RouterStore (the real database worker, its file under this test's own temp home) and a real
 * Areas config written and read back through `updateRouterAreas` / `readRouterAreas`.
 *
 * Only the outside world is faked: `resolve` stands in for the source adapter's message cache,
 * `getTask` for the task store, `send` for session delivery, and `ensureNewWork` for making new
 * work (so no test here writes a task or an areas file outside its own temp home). Each fake records its calls, so
 * a test can say that a refused route never resolved the item, never looked at a target, and
 * never delivered anything.
 *
 * Scope: this pins `routeItem`'s own checks and ledger writes. It says nothing about the other
 * ways a session can reach an item (the CLI, other ops, the HTTP routes), and nothing about the
 * real `sendRoute` receiver checks, which `deps.send` replaces here.
 *
 * All names are invented.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { readRouterAreas, updateRouterAreas, RouterAreaError, type RouterAreasFile } from '../../src/core/router/areas.js'
import {
  noiseActionPrefix, RETRY_FAILED_PREFIX, routeItem, routerNewWorkId, RouterError, type RouteItemInput, type RouterDeliveryDeps, type RouterNewWorkRequest,
} from '../../src/core/router/service.js'
import { taskIdForKey } from '../../src/core/task-create-idempotency.js'
import { RouterStore, routerKey, routerMessageId } from '../../src/core/router/store.js'
import { registerRouterSource } from '../../src/core/router/source-registry.js'
import type { RouterItem, RouterRoute, RouterSource } from '../../src/core/router/types.js'
import type { Task } from '../../src/core/types.js'
import { seedTaskStore } from '../helpers/router-task-store.js'

const SHARED = 'desk@marina.example.invalid'
const OTHER_ACCOUNT = 'crew@acme.example.invalid'
const mail = (account: string, message: string): RouterSource => ({ kind: 'mail', account, message })

// Items the config classifies, and two it does not.
const P_ITEM = mail(SHARED, 'INBOX:1:10')
const P_ITEM_2 = mail(SHARED, 'INBOX:1:12')
const W_ITEM = mail(SHARED, 'INBOX:1:20')
const UNLISTED_ITEM = mail(SHARED, 'INBOX:1:99') // the account is an Area source, this message is not listed
const FOREIGN_ITEM = mail(OTHER_ACCOUNT, 'INBOX:1:1') // no Area has this account at all

const BRIEF = 'Please confirm the dock slot for Thursday.'

let home: string
let areas: RouterAreasFile
const opened: RouterStore[] = []

function store(areaId = 'personal'): RouterStore {
  const one = new RouterStore(home, areaId)
  opened.push(one)
  return one
}

interface Fakes {
  resolve: Mock<(source: RouterSource) => Promise<RouterItem>>
  getTask: Mock<(id: string) => Promise<Task>>
  send: Mock<(route: RouterRoute, text: string) => Promise<unknown>>
  tasks: Map<string, Partial<Task>>
}

function task(id: string, extra: Partial<Task> = {}): Partial<Task> {
  return { id, title: `Task ${id}`, phase: 'IN_PROGRESS', ...extra }
}

/** The outside world: a message cache, a task store, a delivery stand-in. */
function fakes(): Fakes {
  const tasks = new Map<string, Partial<Task>>([
    ['task-p-router', task('task-p-router')],
    ['task-p-router-paused', task('task-p-router-paused')],
    ['task-p-worker', task('task-p-worker')],
    ['task-p-worker-2', task('task-p-worker-2')],
    ['task-p-main', task('task-p-main', { org_role: 'main' })],
    ['task-p-done', task('task-p-done', { phase: 'COMPLETE' })],
    ['task-w-router', task('task-w-router')],
    ['task-w-worker', task('task-w-worker')],
    ['task-loose', task('task-loose')], // open work in no Area
  ])
  // Resolving is how the router reads an item from its source; every call is recorded.
  const resolve = vi.fn(async (source: RouterSource): Promise<RouterItem> => {
    return { source: { ...source }, key: routerKey(source), sender: 'pat@marina-desk.example.invalid', subject: 'Dock schedule' }
  })
  const getTask = vi.fn(async (id: string): Promise<Task> => {
    const found = tasks.get(id)
    if (!found) throw new Error(`Task not found: ${id}`)
    return { ...found } as Task
  })
  const send = vi.fn(async (_route: RouterRoute, _text: string): Promise<unknown> => ({ ok: true }))
  return { resolve, getTask, send, tasks }
}

function deps(f: Fakes, extra: Partial<RouterDeliveryDeps> = {}): RouterDeliveryDeps {
  return { areas, store: store(), resolve: f.resolve, getTask: f.getTask, send: f.send, ...extra }
}

function input(extra: Partial<RouteItemInput> = {}): RouteItemInput {
  return { source: P_ITEM, taskId: 'task-p-worker', reason: 'Dock requests go to the dock task', text: BRIEF, ...extra }
}

async function expectRefusal(run: () => Promise<unknown>, code: string, status: number): Promise<void> {
  let caught: unknown
  try { await run() } catch (err) { caught = err }
  expect(caught, `expected a ${code} refusal`).toBeInstanceOf(Error)
  const error = caught as { code?: string; status?: number }
  expect(error.code).toBe(code)
  expect(error.status).toBe(status)
}

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'router-service-'))
  seedTaskStore(home)
  areas = await updateRouterAreas(home, () => ({
    version: 1,
    areas: [
      {
        id: 'personal', name: 'Personal', host: '__local__',
        taskIds: ['task-p-router', 'task-p-router-paused', 'task-p-worker', 'task-p-worker-2', 'task-p-main', 'task-p-done'],
        sources: [{ kind: 'mail', account: SHARED }],
      },
      {
        id: 'work', name: 'Work', host: '__local__',
        taskIds: ['task-w-router', 'task-w-worker'],
        sources: [{ kind: 'mail', account: SHARED }],
      },
    ],
    routers: [
      { taskId: 'task-p-router', areaId: 'personal', paused: false },
      { taskId: 'task-p-router-paused', areaId: 'personal', paused: true },
      { taskId: 'task-w-router', areaId: 'work', paused: false },
    ],
    items: [
      { source: P_ITEM, areaId: 'personal' },
      { source: P_ITEM_2, areaId: 'personal' },
      { source: W_ITEM, areaId: 'work' },
    ],
  }))
  // The service gets the config as the server reads it from disk.
  areas = await readRouterAreas(home)
})

afterEach(async () => {
  vi.restoreAllMocks()
  for (const one of opened.splice(0)) await one.dispose().catch(() => undefined)
  // Remove only the home this test made.
  if (home && path.basename(home).startsWith('router-service-') && path.dirname(home) === path.resolve(os.tmpdir())) {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

describe('an item no Area classifies', () => {
  for (const [label, source] of [['an unlisted message of a known account', UNLISTED_ITEM], ['an account no Area has', FOREIGN_ITEM]] as const) {
    it(`refuses ${label} before reading it, looking up a target, touching the ledger or sending`, async () => {
      const f = fakes()
      const d = deps(f)
      await expectRefusal(() => routeItem(input({ source }), d), 'area_unassigned', 409)
      await expectRefusal(() => routeItem(input({ source, notRouted: true, taskId: undefined, text: undefined }), d), 'area_unassigned', 409)
      await expectRefusal(() => routeItem(input({ source, byTaskId: 'task-p-router' }), d), 'area_unassigned', 409)
      expect(f.resolve).not.toHaveBeenCalled()
      expect(f.getTask).not.toHaveBeenCalled()
      expect(f.send).not.toHaveBeenCalled()
      // The ledger was never opened, so no Area file exists.
      expect(fs.existsSync(d.store!.file)).toBe(false)
    })
  }
})

describe('who may route an item', () => {
  it('refuses the work Area router routing a personal item, before reading it', async () => {
    const f = fakes()
    const d = deps(f)
    await expectRefusal(() => routeItem(input({ byTaskId: 'task-w-router' }), d), 'area_forbidden', 403)
    expect(f.resolve).not.toHaveBeenCalled()
    expect(f.getTask).not.toHaveBeenCalled()
    expect(f.send).not.toHaveBeenCalled()
    expect(fs.existsSync(d.store!.file)).toBe(false)
  })

  it('refuses a paused router of the same Area, and a task that is no router', async () => {
    const f = fakes()
    const d = deps(f)
    await expectRefusal(() => routeItem(input({ byTaskId: 'task-p-router-paused' }), d), 'area_forbidden', 403)
    await expectRefusal(() => routeItem(input({ byTaskId: 'task-p-worker-2' }), d), 'area_forbidden', 403)
    expect(f.resolve).not.toHaveBeenCalled()
    expect(f.send).not.toHaveBeenCalled()
  })

  it('refuses a ledger that belongs to another Area, before reading the item', async () => {
    const f = fakes()
    const workLedger = store('work')
    await expectRefusal(() => routeItem(input(), deps(f, { store: workLedger })), 'area_forbidden', 403)
    await expectRefusal(() => routeItem(input({ notRouted: true, taskId: undefined, text: undefined }), deps(f, { store: workLedger })), 'area_forbidden', 403)
    expect(f.resolve).not.toHaveBeenCalled()
    expect(f.getTask).not.toHaveBeenCalled()
    expect(f.send).not.toHaveBeenCalled()
    expect(fs.existsSync(workLedger.file)).toBe(false)
  })
})

describe('which target a route may name', () => {
  it('refuses a target in another Area before any claim or send', async () => {
    const f = fakes()
    const d = deps(f)
    await expectRefusal(() => routeItem(input({ taskId: 'task-w-worker', byTaskId: 'task-p-router' }), d), 'cross_area', 403)
    expect(f.send).not.toHaveBeenCalled()
    expect(await d.store!.get(routerKey(P_ITEM))).toBeUndefined()
  })

  const refusals: Array<[string, Partial<RouteItemInput>, string, number]> = [
    ['open work that belongs to no Area', { taskId: 'task-loose' }, 'task_unassigned', 403],
    ['the active router itself', { taskId: 'task-p-router', byTaskId: 'task-p-router' }, 'router_loop', 409],
    ['another router of the Area (paused)', { taskId: 'task-p-router-paused', byTaskId: 'task-p-router' }, 'router_loop', 409],
    ['Main', { taskId: 'task-p-main' }, 'router_loop', 409],
    ['a completed task', { taskId: 'task-p-done' }, 'target_unavailable', 409],
    ['a task that does not exist', { taskId: 'task-gone' }, 'target_unavailable', 409],
  ]
  for (const [label, extra, code, status] of refusals) {
    it(`refuses ${label} with ${code}, leaving no row and sending nothing`, async () => {
      const f = fakes()
      const d = deps(f)
      await expectRefusal(() => routeItem(input(extra), d), code, status)
      expect(f.send).not.toHaveBeenCalled()
      expect(await d.store!.get(routerKey(P_ITEM))).toBeUndefined()
    })
  }

  it('refuses an input with no reason, no target or no brief before anything else', async () => {
    const f = fakes()
    const d = deps(f)
    await expectRefusal(() => routeItem(input({ reason: '   ' }), d), 'reason_required', 400)
    await expectRefusal(() => routeItem(input({ reason: 'r'.repeat(501) }), d), 'reason_required', 400)
    await expectRefusal(() => routeItem(input({ text: 'b'.repeat(20001) }), d), 'text_too_large', 400)
    await expectRefusal(() => routeItem(input({ taskId: undefined }), d), 'task_required', 400)
    await expectRefusal(() => routeItem(input({ text: '  ' }), d), 'text_required', 400)
    for (const extra of [{ retry: true }, { taskId: 'task-p-worker' }, { newTaskTitle: 'Dock task' }]) {
      await expectRefusal(() => routeItem({ source: P_ITEM, reason: 'No action', notRouted: true, ...extra }, d), 'bad_decision', 400)
    }
    expect(f.resolve).not.toHaveBeenCalled()
    expect(f.send).not.toHaveBeenCalled()
  })
})

describe('a route inside one Area', () => {
  it('delivers once under the Area message id and records it durably', async () => {
    const f = fakes()
    const d = deps(f)
    const key = routerKey(P_ITEM)
    const result = await routeItem(input({ byTaskId: 'task-p-router', ruleId: 'rule-dock' }), d)

    expect(result.fresh).toBe(true)
    expect(result.route).toMatchObject({
      areaId: 'personal', key, status: 'routed', taskId: 'task-p-worker',
      byTaskId: 'task-p-router', ruleId: 'rule-dock', reason: 'Dock requests go to the dock task',
      messageId: routerMessageId('personal', key, 'task-p-worker'),
    })
    expect(f.send).toHaveBeenCalledTimes(1)
    const [sentRoute, sentText] = f.send.mock.calls[0]!
    expect(sentRoute).toMatchObject({ status: 'routing', taskId: 'task-p-worker', messageId: result.route.messageId })
    expect(sentText).toContain(BRIEF)

    // Another connection (another worker, as another process would be) reads the same row.
    const reread = await store().get(key)
    expect(reread).toMatchObject({ areaId: 'personal', status: 'routed', taskId: 'task-p-worker', messageId: result.route.messageId })
    // The work Area's ledger is another file and never holds the row.
    expect(await store('work').get(key)).toBeUndefined()
  })

  it('records a not-routed decision without looking up a target or sending', async () => {
    const f = fakes()
    const d = deps(f)
    const key = routerKey(P_ITEM)
    const result = await routeItem(input({ notRouted: true, taskId: undefined, text: undefined, reason: 'Newsletter, nobody owns it' }), d)
    expect(result.fresh).toBe(true)
    expect(result.route).toMatchObject({ areaId: 'personal', status: 'not_routed', reason: 'Newsletter, nobody owns it' })
    expect(result.route.taskId).toBeUndefined()
    expect(result.route.messageId).toBeUndefined()
    expect(f.getTask).not.toHaveBeenCalled()
    expect(f.send).not.toHaveBeenCalled()
    expect(await store().get(key)).toMatchObject({ status: 'not_routed' })
  })

  it('a decision only the person can act on sends them one letter with the brief and records it handled', async () => {
    const f = fakes()
    const letter = vi.fn(async () => undefined)
    const d = deps(f, { letter })
    const key = routerKey(P_ITEM)
    const decide = () => routeItem({ source: P_ITEM, forUser: true, reason: 'A bill only the person can pay', text: 'Pay the dock fee by Friday.', byTaskId: 'task-p-router' }, d)
    const first = await decide()
    expect(first.fresh).toBe(true)
    expect(first.route).toMatchObject({ status: 'not_routed', reason: 'A bill only the person can pay' })
    expect(letter).toHaveBeenCalledTimes(1)
    expect(letter.mock.calls[0]).toEqual(expect.arrayContaining(['personal', expect.objectContaining({ key }), 'Pay the dock fee by Friday.']))
    // The same decision again is the same row: no second letter.
    const again = await decide()
    expect(again.fresh).toBe(false)
    expect(letter).toHaveBeenCalledTimes(1)
    expect(f.send).not.toHaveBeenCalled()
  })

  it('a letter to the person names no target, rule or retry, and needs its brief', async () => {
    const f = fakes()
    const letter = vi.fn(async () => undefined)
    const d = deps(f, { letter })
    const base = { source: P_ITEM, forUser: true, reason: 'Only the person', text: 'Reply to the dock.' }
    for (const extra of [{ retry: true }, { taskId: 'task-p-worker' }, { newTaskTitle: 'Dock task' }, { ruleId: 'rule-dock' }]) {
      await expectRefusal(() => routeItem({ ...base, ...extra }, d), 'bad_decision', 400)
    }
    await expectRefusal(() => routeItem({ ...base, text: '  ' }, d), 'text_required', 400)
    expect(letter).not.toHaveBeenCalled()
    expect(f.resolve).not.toHaveBeenCalled()
  })

  it('sends once when two callers on two connections route the same item at the same time', async () => {
    const f = fakes()
    const ledgerA = store()
    const ledgerB = store()
    // Open both connections first, so the two claims really race.
    await Promise.all([ledgerA.get('warm-up'), ledgerB.get('warm-up')])
    const results = await Promise.all([
      routeItem(input(), deps(f, { store: ledgerA })),
      routeItem(input({ taskId: 'task-p-worker-2', reason: 'Second opinion' }), deps(f, { store: ledgerB })),
    ])
    expect(f.send).toHaveBeenCalledTimes(1)
    expect(results.filter((r) => r.fresh)).toHaveLength(1)
    const winner = results.find((r) => r.fresh)!.route
    const row = await store().get(routerKey(P_ITEM))
    // The losing caller's decision never overwrote the winner's row.
    expect(row).toMatchObject({ status: 'routed', taskId: winner.taskId, messageId: winner.messageId })
    expect(f.send.mock.calls[0]![0].taskId).toBe(winner.taskId)
  })

  it('returns an existing row without sending, even after its target completed, and never moves it', async () => {
    const f = fakes()
    const d = deps(f)
    const key = routerKey(P_ITEM)
    const first = await routeItem(input(), d)
    expect(first.route.status).toBe('routed')
    expect(f.send).toHaveBeenCalledTimes(1)
    f.getTask.mockClear()

    // The target finishes; a later caller routes the same item again, even to another task.
    f.tasks.set('task-p-worker', task('task-p-worker', { phase: 'COMPLETE' }))
    for (const again of [input(), input({ taskId: 'task-p-worker-2' }), input({ notRouted: true, taskId: undefined, text: undefined })]) {
      const result = await routeItem(again, d)
      expect(result.fresh).toBe(false)
      expect(result.route).toMatchObject({ status: 'routed', taskId: 'task-p-worker', messageId: first.route.messageId })
    }
    expect(f.send).toHaveBeenCalledTimes(1)
    expect(f.getTask).not.toHaveBeenCalled()
    expect(await store().get(key)).toMatchObject({ status: 'routed', taskId: 'task-p-worker', at: first.route.at })
  })
})

describe('a delivery that did not go through', () => {
  it('a refused delivery retries once, under the same message id, even with two retries at once', async () => {
    const f = fakes()
    const d = deps(f)
    const key = routerKey(P_ITEM)
    f.send.mockRejectedValueOnce(Object.assign(new Error('queue is full'), { code: 'queue_full' }))
    const first = await routeItem(input(), d)
    expect(first.route).toMatchObject({ status: 'failed', error: 'queue is full' })
    const messageId = first.route.messageId
    expect(messageId).toBe(routerMessageId('personal', key, 'task-p-worker'))
    expect(f.send).toHaveBeenCalledTimes(1)

    const ledgerB = store()
    await ledgerB.get('warm-up')
    const retries = await Promise.allSettled([
      routeItem(input({ retry: true }), d),
      routeItem(input({ retry: true }), deps(f, { store: ledgerB })),
    ])
    expect(f.send).toHaveBeenCalledTimes(2)
    const won = retries.filter((r) => r.status === 'fulfilled' && r.value.fresh)
    expect(won).toHaveLength(1)
    // The other retry either read the winner's claim (not fresh) or saw the row already moving
    // out of failed and was refused; it never delivered.
    for (const other of retries.filter((r) => !won.includes(r))) {
      if (other.status === 'fulfilled') expect(other.value.fresh).toBe(false)
      else expect((other.reason as { code?: string }).code).toBe('retry_not_safe')
    }
    expect(f.send.mock.calls[1]![0]).toMatchObject({ status: 'routing', messageId, taskId: 'task-p-worker' })
    expect(await store().get(key)).toMatchObject({ status: 'routed', messageId })

    // Delivered now: a further retry is refused and sends nothing.
    await expectRefusal(() => routeItem(input({ retry: true }), d), 'retry_not_safe', 409)
    expect(f.send).toHaveBeenCalledTimes(2)
  })

  it('a retry keeps the original target, whatever task the retry names', async () => {
    const f = fakes()
    const d = deps(f)
    f.send.mockRejectedValueOnce(new RouterError('receiver_not_isolated', 'No receiver', 409))
    const first = await routeItem(input(), d)
    expect(first.route.status).toBe('failed')
    const again = await routeItem(input({ retry: true, taskId: 'task-p-worker-2' }), d)
    expect(again.route).toMatchObject({ status: 'routed', taskId: 'task-p-worker', messageId: first.route.messageId })
    expect(f.send.mock.calls[1]![0].taskId).toBe('task-p-worker')
  })

  it('a retry whose original target completed meanwhile is refused and sends nothing', async () => {
    const f = fakes()
    const d = deps(f)
    f.send.mockRejectedValueOnce(Object.assign(new Error('throttled'), { code: 'throttled' }))
    expect((await routeItem(input(), d)).route.status).toBe('failed')
    f.tasks.set('task-p-worker', task('task-p-worker', { phase: 'COMPLETE' }))
    await expectRefusal(() => routeItem(input({ retry: true }), d), 'target_unavailable', 409)
    expect(f.send).toHaveBeenCalledTimes(1)
    expect(await store().get(routerKey(P_ITEM))).toMatchObject({ status: 'failed' })
  })

  it('an uncertain delivery is recorded as unknown and may not retry', async () => {
    const f = fakes()
    const d = deps(f)
    f.send.mockRejectedValueOnce(new Error('socket closed before the answer'))
    const first = await routeItem(input(), d)
    expect(first.route).toMatchObject({ status: 'unknown', error: 'socket closed before the answer' })
    await expectRefusal(() => routeItem(input({ retry: true }), d), 'retry_not_safe', 409)
    // A plain call returns the row as it is.
    const plain = await routeItem(input(), d)
    expect(plain).toMatchObject({ fresh: false, route: { status: 'unknown', messageId: first.route.messageId } })
    expect(f.send).toHaveBeenCalledTimes(1)
  })

  it('a retry with no row, or on a not-routed row, is refused and sends nothing', async () => {
    const f = fakes()
    const d = deps(f)
    await expectRefusal(() => routeItem(input({ retry: true }), d), 'retry_not_safe', 409)
    await routeItem(input({ source: P_ITEM_2, notRouted: true, taskId: undefined, text: undefined }), d)
    await expectRefusal(() => routeItem(input({ source: P_ITEM_2, retry: true }), d), 'retry_not_safe', 409)
    expect(f.send).not.toHaveBeenCalled()
  })
})

describe('new work named by a route', () => {
  const KEY = routerKey(P_ITEM)
  let newId = ''
  beforeEach(async () => { newId = await routerNewWorkId('personal', KEY) })

  /** Makes the task in the fake store and returns a copy of the areas file that lists it. */
  function newWork(f: Fakes): Mock<(request: RouterNewWorkRequest) => Promise<RouterAreasFile>> {
    return vi.fn(async (request: RouterNewWorkRequest): Promise<RouterAreasFile> => {
      if (!f.tasks.has(request.taskId)) {
        f.tasks.set(request.taskId, task(request.taskId, { title: request.title, source: 'local', router_area_id: request.areaId }))
      }
      const listed = structuredClone(areas)
      const area = listed.areas.find((one) => one.id === request.areaId)!
      if (!area.taskIds.includes(request.taskId)) area.taskIds.push(request.taskId)
      return listed
    })
  }
  const fresh = (extra: Partial<RouteItemInput> = {}) => input({ taskId: undefined, newTaskTitle: 'Dock follow-up', ...extra })

  it('names the work by the area and the item, the same id every time', () => {
    expect(newId).toBe(taskIdForKey(`router-work:personal:${KEY}`))
    expect(newId).not.toBe(taskIdForKey(`router-work:work:${KEY}`))
  })

  it('makes one task when two new-work decisions race, and never touches the caller\'s snapshot', async () => {
    const f = fakes()
    const ensureNewWork = newWork(f)
    const snapshot = structuredClone(areas)
    const ledgerA = store()
    const ledgerB = store()
    await Promise.all([ledgerA.get('warm-up'), ledgerB.get('warm-up')])
    const results = await Promise.all([
      routeItem(fresh(), deps(f, { store: ledgerA, ensureNewWork })),
      routeItem(fresh({ newTaskTitle: 'Dock reply' }), deps(f, { store: ledgerB, ensureNewWork })),
    ])
    expect(results.filter((r) => r.fresh)).toHaveLength(1)
    expect(ensureNewWork).toHaveBeenCalledTimes(1)
    expect(ensureNewWork.mock.calls[0]![0]).toMatchObject({ areaId: 'personal', source: P_ITEM, key: KEY, taskId: newId, brief: BRIEF })
    expect(f.send).toHaveBeenCalledTimes(1)
    expect(f.send.mock.calls[0]![0]).toMatchObject({ taskId: newId, messageId: routerMessageId('personal', KEY, newId) })
    expect(await store().get(KEY)).toMatchObject({ status: 'routed', taskId: newId })
    const winner = results.find((r) => r.fresh)!
    expect(f.tasks.get(newId)?.title).toBe(winner === results[0] ? 'Dock follow-up' : 'Dock reply')
    expect(areas).toEqual(snapshot)
  })

  it('makes no task when existing work wins the race, and exactly one when the new work wins', async () => {
    const f = fakes()
    const ensureNewWork = newWork(f)
    const ledgerA = store()
    const ledgerB = store()
    await Promise.all([ledgerA.get('warm-up'), ledgerB.get('warm-up')])
    const results = await Promise.all([
      routeItem(fresh(), deps(f, { store: ledgerA, ensureNewWork })),
      routeItem(input({ taskId: 'task-p-worker-2' }), deps(f, { store: ledgerB, ensureNewWork })),
    ])
    expect(results.filter((r) => r.fresh)).toHaveLength(1)
    const winner = results.find((r) => r.fresh)!.route
    const newWon = winner.taskId === newId
    expect(winner.taskId).toBe(newWon ? newId : 'task-p-worker-2')
    expect(ensureNewWork).toHaveBeenCalledTimes(newWon ? 1 : 0)
    expect(f.tasks.has(newId)).toBe(newWon)
    expect(f.send).toHaveBeenCalledTimes(1)
    expect(f.send.mock.calls[0]![0].taskId).toBe(winner.taskId)
  })

  it('a new-work decision after existing work claimed the item makes nothing, and the reverse moves nothing', async () => {
    const f = fakes()
    const ensureNewWork = newWork(f)
    const d = deps(f, { ensureNewWork })
    expect((await routeItem(input(), d)).route).toMatchObject({ status: 'routed', taskId: 'task-p-worker' })
    expect(await routeItem(fresh(), d)).toMatchObject({ fresh: false, route: { taskId: 'task-p-worker' } })
    expect(ensureNewWork).not.toHaveBeenCalled()
    expect(f.tasks.has(newId)).toBe(false)

    const second = routerKey(P_ITEM_2)
    const secondId = await routerNewWorkId('personal', second)
    expect((await routeItem(fresh({ source: P_ITEM_2 }), d)).route).toMatchObject({ status: 'routed', taskId: secondId })
    expect(await routeItem(input({ source: P_ITEM_2 }), d)).toMatchObject({ fresh: false, route: { taskId: secondId } })
    expect(ensureNewWork).toHaveBeenCalledTimes(1)
    expect(f.send).toHaveBeenCalledTimes(2)
  })

  it('a repeated new-work decision returns the row and makes nothing again', async () => {
    const f = fakes()
    const ensureNewWork = newWork(f)
    const d = deps(f, { ensureNewWork })
    const first = await routeItem(fresh(), d)
    expect(first).toMatchObject({ fresh: true, route: { status: 'routed', taskId: newId } })
    for (const again of [fresh(), fresh({ newTaskTitle: 'Another title' })]) {
      expect(await routeItem(again, d)).toMatchObject({ fresh: false, route: { status: 'routed', taskId: newId, at: first.route.at } })
    }
    expect(ensureNewWork).toHaveBeenCalledTimes(1)
    expect(f.send).toHaveBeenCalledTimes(1)
    expect(f.tasks.get(newId)?.title).toBe('Dock follow-up')
  })

  it('a refused creation records failed, sends nothing, and only a new-work retry of the same id makes it', async () => {
    const f = fakes()
    const ensureNewWork = newWork(f)
    const d = deps(f, { ensureNewWork })
    const messageId = routerMessageId('personal', KEY, newId)
    ensureNewWork.mockRejectedValueOnce(new RouterAreaError('cross_area', 403, 'The incoming item changed area'))
    const first = await routeItem(fresh(), d)
    expect(first.route).toMatchObject({ status: 'failed', taskId: newId, messageId, error: 'The incoming item changed area' })
    expect(f.send).not.toHaveBeenCalled()
    expect(f.tasks.has(newId)).toBe(false)

    // A retry naming existing work, or no new work, keeps the original target, which is not made yet.
    await expectRefusal(() => routeItem(input({ retry: true }), d), 'target_unavailable', 409)
    await expectRefusal(() => routeItem(input({ retry: true, taskId: 'task-p-worker-2' }), d), 'target_unavailable', 409)
    expect(ensureNewWork).toHaveBeenCalledTimes(1)
    expect(await store().get(KEY)).toMatchObject({ status: 'failed', taskId: newId })

    const again = await routeItem(fresh({ retry: true, newTaskTitle: 'Dock retry' }), d)
    expect(again).toMatchObject({ fresh: true, route: { status: 'routed', taskId: newId, messageId } })
    expect(ensureNewWork).toHaveBeenCalledTimes(2)
    expect(f.send).toHaveBeenCalledTimes(1)
    expect(f.send.mock.calls[0]![0]).toMatchObject({ taskId: newId, messageId })
  })

  it('a new-work retry of a row that went to existing work makes nothing and keeps that target', async () => {
    const f = fakes()
    const ensureNewWork = newWork(f)
    const d = deps(f, { ensureNewWork })
    f.send.mockRejectedValueOnce(Object.assign(new Error('queue is full'), { code: 'queue_full' }))
    expect((await routeItem(input(), d)).route).toMatchObject({ status: 'failed', taskId: 'task-p-worker' })
    const again = await routeItem(fresh({ retry: true }), d)
    expect(again.route).toMatchObject({ status: 'routed', taskId: 'task-p-worker' })
    expect(ensureNewWork).not.toHaveBeenCalled()
    expect(f.tasks.has(newId)).toBe(false)
  })

  it('a creation that may have half-happened records unknown and is never retried or redone', async () => {
    const f = fakes()
    const ensureNewWork = newWork(f)
    const d = deps(f, { ensureNewWork })
    ensureNewWork.mockRejectedValueOnce(new Error('the task store did not answer'))
    expect((await routeItem(fresh(), d)).route).toMatchObject({ status: 'unknown', taskId: newId })
    await expectRefusal(() => routeItem(fresh({ retry: true }), d), 'retry_not_safe', 409)
    expect(await routeItem(fresh(), d)).toMatchObject({ fresh: false, route: { status: 'unknown' } })
    expect(ensureNewWork).toHaveBeenCalledTimes(1)
    expect(f.send).not.toHaveBeenCalled()
  })

  it('new work the creator returns outside the item\'s area is refused before any send', async () => {
    const f = fakes()
    // A creator that made the task but listed it nowhere: the target check reads its file, not the snapshot.
    const ensureNewWork = vi.fn(async (request: RouterNewWorkRequest) => {
      f.tasks.set(request.taskId, task(request.taskId))
      return structuredClone(areas)
    })
    const result = await routeItem(fresh(), deps(f, { ensureNewWork }))
    expect(result.route).toMatchObject({ status: 'failed', taskId: newId })
    expect(f.send).not.toHaveBeenCalled()
  })
})

describe('one item seen under two exact sources', () => {
  // A mail moved or copied keeps its RFC id, so the adapter gives both cache ids one canonical key.
  const RFC_KEY = JSON.stringify(['mail', SHARED, 'rfc', '<slot-10@marina.example.invalid>'])
  function sameRfc(f: Fakes): void {
    f.resolve.mockImplementation(async (source: RouterSource) => ({
      source: { ...source }, key: RFC_KEY, sender: 'pat@marina-desk.example.invalid', subject: 'Dock schedule',
    }))
  }

  it('the second confirmed source returns the original receipt, sends nothing, and now finds it by source', async () => {
    const f = fakes()
    sameRfc(f)
    const d = deps(f)
    const first = await routeItem(input(), d)
    expect(first.route).toMatchObject({ key: RFC_KEY, status: 'routed', source: P_ITEM })
    // Before the second source is routed, a reader by that source finds nothing.
    expect(await d.store!.getSource(P_ITEM_2)).toBeUndefined()

    const second = await routeItem(input({ source: P_ITEM_2, taskId: 'task-p-worker-2', reason: 'Copied into another folder' }), d)
    expect(second).toEqual({ fresh: false, route: first.route })
    expect(f.send).toHaveBeenCalledTimes(1)
    // The receipt keeps its original source; both sources read it, from another connection too.
    const reader = store()
    expect(await reader.getSource(P_ITEM_2)).toEqual(first.route)
    const batch = await reader.getSources([P_ITEM, P_ITEM_2])
    expect(batch.get(routerKey(P_ITEM))).toEqual(first.route)
    expect(batch.get(routerKey(P_ITEM_2))).toEqual(first.route)
    // The other Area's ledger holds neither.
    expect((await store('work').getSources([P_ITEM, P_ITEM_2])).size).toBe(0)
  })

  it('a source no Area classifies is refused before reading it and gains no alias', async () => {
    const f = fakes()
    sameRfc(f)
    const d = deps(f)
    await routeItem(input(), d)
    f.resolve.mockClear()
    await expectRefusal(() => routeItem(input({ source: UNLISTED_ITEM }), d), 'area_unassigned', 409)
    expect(f.resolve).not.toHaveBeenCalled()
    expect(await d.store!.getSource(UNLISTED_ITEM)).toBeUndefined()
  })

  it('two callers under the two sources at once send once, and both sources name the one receipt', async () => {
    const f = fakes()
    sameRfc(f)
    const ledgerA = store()
    const ledgerB = store()
    await Promise.all([ledgerA.get('warm-up'), ledgerB.get('warm-up')])
    const results = await Promise.all([
      routeItem(input(), deps(f, { store: ledgerA })),
      routeItem(input({ source: P_ITEM_2, taskId: 'task-p-worker-2' }), deps(f, { store: ledgerB })),
    ])
    expect(f.send).toHaveBeenCalledTimes(1)
    expect(results.filter((r) => r.fresh)).toHaveLength(1)
    const row = await store().get(RFC_KEY)
    expect(await store().getSource(P_ITEM)).toEqual(row)
    expect(await store().getSource(P_ITEM_2)).toEqual(row)
  })

  it('a refused delivery retried under the second source keeps the original row and message id', async () => {
    const f = fakes()
    sameRfc(f)
    const d = deps(f)
    f.send.mockRejectedValueOnce(Object.assign(new Error('queue is full'), { code: 'queue_full' }))
    const first = await routeItem(input(), d)
    expect(first.route.status).toBe('failed')
    const again = await routeItem(input({ source: P_ITEM_2, retry: true }), d)
    expect(again.route).toMatchObject({ key: RFC_KEY, status: 'routed', taskId: 'task-p-worker', messageId: first.route.messageId, source: P_ITEM })
    expect(await d.store!.getSource(P_ITEM_2)).toMatchObject({ key: RFC_KEY, status: 'routed' })
  })
})

describe('an item its source no longer has', () => {
  const missingError = () => Object.assign(new Error('The exact email is not in the mail cache.'), { code: 'source_missing' })
  const skip = (extra: Partial<RouteItemInput> = {}) => input({ notRouted: true, taskId: undefined, text: undefined, reason: 'Gone from the cache; nothing to do', ...extra })

  it('an item no Area classifies is refused before the source is asked', async () => {
    const f = fakes()
    f.resolve.mockRejectedValue(missingError())
    const d = deps(f)
    await expectRefusal(() => routeItem(skip({ source: UNLISTED_ITEM }), d), 'area_unassigned', 409)
    expect(f.resolve).not.toHaveBeenCalled()
    expect(fs.existsSync(d.store!.file)).toBe(false)
  })

  it('a route, a retry, or a not-routed record on any other failure is refused and leaves no receipt', async () => {
    const f = fakes()
    const d = deps(f)
    f.resolve.mockRejectedValue(missingError())
    await expect(routeItem(input(), d)).rejects.toMatchObject({ code: 'source_missing' })
    await expect(routeItem(input({ newTaskTitle: 'Dock follow-up', taskId: undefined }), d)).rejects.toMatchObject({ code: 'source_missing' })
    await expect(routeItem(skip({ retry: true }), d)).rejects.toMatchObject({ code: 'bad_decision' })
    for (const code of ['source_timeout', 'source_unavailable', 'identity_incompatible', undefined]) {
      f.resolve.mockRejectedValueOnce(Object.assign(new Error('not a confirmed miss'), code ? { code } : {}))
      await expect(routeItem(skip(), d)).rejects.toThrow('not a confirmed miss')
    }
    expect(f.send).not.toHaveBeenCalled()
    expect(f.getTask).not.toHaveBeenCalled()
    expect(await d.store!.getSource(P_ITEM)).toBeUndefined()
    expect(await d.store!.get(routerKey(P_ITEM))).toBeUndefined()
  })

  it('a confirmed miss of a classified item records the caller\'s not-routed reason under the source', async () => {
    const f = fakes()
    const d = deps(f)
    f.resolve.mockRejectedValue(missingError())
    const result = await routeItem(skip(), d)
    expect(result).toMatchObject({ fresh: true, route: {
      areaId: 'personal', key: routerKey(P_ITEM), source: P_ITEM, status: 'not_routed',
      reason: 'Gone from the cache; nothing to do', sender: '', subject: '',
    } })
    expect(result.route.messageId).toBeUndefined()
    expect(await d.store!.getSource(P_ITEM)).toEqual(result.route)
    expect(await routeItem(skip({ reason: 'Again' }), d)).toEqual({ fresh: false, route: result.route })

    // The cache has the item again, under its canonical key: the receipt stands, nothing is sent.
    f.resolve.mockImplementation(async (source: RouterSource) => ({
      source: { ...source }, key: JSON.stringify(['mail', SHARED, 'rfc', '<back@marina.example.invalid>']), sender: 'pat', subject: 'Back',
    }))
    expect(await routeItem(input(), d)).toEqual({ fresh: false, route: result.route })
    expect(f.send).not.toHaveBeenCalled()
  })
})

describe('noise the router decides', () => {
  const noiseInput = (extra: Partial<RouteItemInput> = {}) => input({ notRouted: true, taskId: undefined, text: undefined, reason: 'Newsletter, nobody owns it', ...extra })

  it('tidies a fresh noise decision once, and its reason says what was done', async () => {
    const f = fakes()
    const noise = vi.fn(async () => ({ read: true, archived: true }))
    const d = deps(f, { noise, awaitNoise: true })
    const first = await routeItem(noiseInput(), d)
    // The answer is the decision; what was done is written beside it once done.
    expect(first).toMatchObject({ fresh: true, route: { status: 'not_routed', reason: 'Newsletter, nobody owns it' } })
    expect(noise).toHaveBeenCalledTimes(1)
    expect(noise.mock.calls[0]).toEqual([P_ITEM])
    expect(await store().get(routerKey(P_ITEM))).toMatchObject({ reason: 'Marked read and archived: Newsletter, nobody owns it' })
    // The same decision again is the same row: nothing is tidied twice, the reason is not prefixed twice.
    const again = await routeItem(noiseInput(), d)
    expect(again.fresh).toBe(false)
    expect(noise).toHaveBeenCalledTimes(1)
    expect(again.route.reason).toBe('Marked read and archived: Newsletter, nobody owns it')
    expect(f.send).not.toHaveBeenCalled()
  })

  it('names a step that did not happen, and leaves the reason alone when nothing was tried', async () => {
    const f = fakes()
    const noise = vi.fn(async (source: RouterSource) => source.message === P_ITEM.message
      ? { read: true, archived: false, note: 'this account has no archive' }
      : { read: false, archived: false })
    const d = deps(f, { noise, awaitNoise: true })
    await routeItem(noiseInput(), d)
    await routeItem(noiseInput({ source: P_ITEM_2 }), d)
    expect((await store().get(routerKey(P_ITEM)))?.reason).toBe('Marked read, not archived (this account has no archive): Newsletter, nobody owns it')
    expect((await store().get(routerKey(P_ITEM_2)))?.reason).toBe('Newsletter, nobody owns it')
  })

  it('never tidies routed work or a letter to the person, and a hook that throws leaves the decision as recorded', async () => {
    const f = fakes()
    const noise = vi.fn(async () => { throw new Error('mail server down') })
    const letter = vi.fn(async () => undefined)
    const d = deps(f, { noise, letter, awaitNoise: true })
    await routeItem(input(), d)
    await routeItem({ source: P_ITEM_2, forUser: true, reason: 'A bill only the person can pay', text: 'Pay it by Friday.', byTaskId: 'task-p-router' }, d)
    expect(noise).not.toHaveBeenCalled()
    await updateRouterAreas(home, (file) => ({ ...file, items: [...file.items, { source: mail(SHARED, 'INBOX:1:13'), areaId: 'personal' }] }))
    areas = await readRouterAreas(home)
    await routeItem(noiseInput({ source: mail(SHARED, 'INBOX:1:13') }), deps(f, { noise, awaitNoise: true }))
    expect(noise).toHaveBeenCalledTimes(1)
    expect(await store().get(routerKey(mail(SHARED, 'INBOX:1:13')))).toMatchObject({ status: 'not_routed', reason: 'Newsletter, nobody owns it' })
  })

  it('tidies nothing until the person turns the experiment on, though the mail source can', async () => {
    const f = fakes()
    const hook = vi.fn(async () => ({ read: true, archived: true }))
    // A mail source that could tidy: only the person's choice (off by default) may let it.
    const dispose = registerRouterSource('mail', { resolve: async (one) => ({ source: { ...one }, key: routerKey(one), sender: 's', subject: 's' }), noise: hook })
    try {
      await routeItem(noiseInput(), deps(f, { awaitNoise: true }))
      expect(hook).not.toHaveBeenCalled()
      expect((await store().get(routerKey(P_ITEM)))?.reason).toBe('Newsletter, nobody owns it')
      await routeItem(noiseInput({ source: P_ITEM_2 }), deps(f, { noise: null, awaitNoise: true }))
      expect(hook).not.toHaveBeenCalled()
    } finally { dispose() }
  })

  it('answers the router before the tidy is done', async () => {
    const f = fakes()
    let finish: (value: { read: boolean; archived: boolean }) => void = () => undefined
    const noise = vi.fn(() => new Promise<{ read: boolean; archived: boolean }>((resolve) => { finish = resolve }))
    const answer = await routeItem(noiseInput(), deps(f, { noise }))
    expect(answer.route.reason).toBe('Newsletter, nobody owns it')
    expect(noise).toHaveBeenCalledTimes(1)
    finish({ read: true, archived: true })
    await vi.waitFor(async () => expect((await store().get(routerKey(P_ITEM)))?.reason).toBe('Marked read and archived: Newsletter, nobody owns it'))
  })

  it('says each outcome in plain words', () => {
    expect(noiseActionPrefix({ read: true, archived: true })).toBe('Marked read and archived: ')
    expect(noiseActionPrefix({ read: true, archived: false })).toBe('Marked read: ')
    expect(noiseActionPrefix({ read: false, archived: true })).toBe('Archived: ')
    expect(noiseActionPrefix({ read: false, archived: false, note: 'a later delivery replaced the email' })).toBe('Left as it was (a later delivery replaced the email): ')
    expect(noiseActionPrefix({ read: false, archived: false })).toBeUndefined()
  })
})

describe('the one automatic retry of a refused delivery', () => {
  it('an offered retry is marked once in the ledger, and the router may still take it', async () => {
    const f = fakes()
    const d = deps(f)
    f.send.mockRejectedValueOnce(Object.assign(new Error('queue is full'), { code: 'queue_full' }))
    const failed = await routeItem(input(), d)
    const ledger = store()
    expect(await ledger.offerRetry([failed.route.key, 'no-such-key'])).toBe(1)
    expect(await ledger.offerRetry([failed.route.key])).toBe(0)
    expect(await ledger.get(failed.route.key)).toMatchObject({ status: 'failed', error: 'Retry offered: queue is full' })
    const retried = await routeItem(input({ retry: true }), d)
    expect(retried.route).toMatchObject({ status: 'routed' })
    expect(await ledger.offerRetry([failed.route.key])).toBe(0)
  })

  it('a retry the receiver refuses again is final, and its error says so', async () => {
    const f = fakes()
    const d = deps(f)
    f.send.mockRejectedValue(Object.assign(new Error('No isolated receiver is ready in this area.'), { code: 'queue_full' }))
    const first = await routeItem(input(), d)
    expect(first.route).toMatchObject({ status: 'failed', error: 'No isolated receiver is ready in this area.' })
    const retried = await routeItem(input({ retry: true }), d)
    expect(retried.route).toMatchObject({ status: 'failed', error: `${RETRY_FAILED_PREFIX}No isolated receiver is ready in this area.` })
    expect(f.send).toHaveBeenCalledTimes(2)
  })
})
