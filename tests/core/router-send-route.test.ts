// The real registry's row hook avoids divergent vi.mock instances across dynamic imports.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'
import type { RouterAreasFile } from '../../src/core/router/areas.js'
import type { SessionRecord } from '../../src/core/types.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-router-send-route'))

const h = vi.hoisted(() => ({
  tasks: new Map<string, Record<string, unknown>>(),
  records: [] as Array<Record<string, unknown>>,
  areas: { value: null as unknown },
}))
const m = vi.hoisted(() => ({
  getTask: vi.fn(),
  startSessionForTask: vi.fn(),
  performSessionSend: vi.fn(),
}))

vi.mock('../../src/core/task-manager.js', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), getTask: m.getTask }))
vi.mock('../../src/core/router/areas.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()), readRouterAreas: vi.fn(async () => structuredClone(h.areas.value)),
}))
vi.mock('../../src/core/sessions/task-start.js', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), startSessionForTask: m.startSessionForTask }))
vi.mock('../../src/core/sessions/session-send-core.js', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), performSessionSend: m.performSessionSend }))

import { installAwaySessions } from '../../src/core/session-tracker.js'
import { routeItem, sendRoute } from '../../src/core/router/service.js'
import { isRouterDelivery } from '../../src/core/router/delivery-scope.js'
import { routerAreaProfile } from '../../src/core/router/session-policy.js'
import { RouterStore, routerKey, routerMessageId } from '../../src/core/router/store.js'
import type { RouterRoute, RouterSource } from '../../src/core/router/types.js'
import { WALNUT_HOME } from '../../src/constants.js'

const ACCOUNT = 'desk@marina.example.invalid'
const ITEM: RouterSource = { kind: 'mail', account: ACCOUNT, message: 'INBOX:1:10' }
const AREAS: RouterAreasFile = {
  version: 1,
  areas: [
    { id: 'personal', name: 'Personal', host: '__local__', taskIds: ['t-work', 't-router'], sources: [{ kind: 'mail', account: ACCOUNT }] },
    { id: 'work', name: 'Work', host: '__local__', taskIds: [], sources: [] },
  ],
  routers: [{ taskId: 't-router', areaId: 'personal', paused: false }],
  items: [{ source: { ...ITEM }, areaId: 'personal' }],
}
const MID = routerMessageId('personal', routerKey(ITEM), 't-work')
const route: RouterRoute = {
  areaId: 'personal', key: routerKey(ITEM), source: { ...ITEM }, sender: 'pat@acme.example.invalid', subject: 'Dock slot',
  status: 'routing', taskId: 't-work', reason: 'Dock work.', at: 1, messageId: MID,
}
const isolated = (sid: string) => ({ claudeSessionId: sid, taskId: 't-work', archived: false, lastActiveAt: '', host: '__local__', profile: routerAreaProfile('personal', 'work') })
const fullTool = (sid: string) => ({ claudeSessionId: sid, taskId: 't-work', archived: false, lastActiveAt: '', host: '__local__' })
const code = async (p: Promise<unknown>): Promise<string> => p.then(() => 'resolved', (e: { code?: string }) => e.code ?? String(e))

beforeEach(() => {
  h.areas.value = structuredClone(AREAS)
  h.records = []
  h.tasks = new Map([
    ['t-work', { id: 't-work', title: 'Dock work', source: 'local', router_area_id: 'personal', phase: 'IN_PROGRESS' }],
    ['t-router', { id: 't-router', title: 'Router', source: 'local', router_area_id: 'personal', org_role: 'router', router_paused: false, phase: 'IN_PROGRESS' }],
  ])
  for (const fn of Object.values(m)) fn.mockReset()
  m.getTask.mockImplementation(async (id: string) => {
    const t = h.tasks.get(id)
    if (!t) throw new Error(`Task not found: ${id}`)
    return structuredClone(t)
  })
  // The real registry's own extra-rows hook: getSessionsForTask and getSessionByClaudeId return
  // these (by taskId / id) on top of the empty isolated store, for every importer of the module.
  installAwaySessions(() => structuredClone(h.records) as unknown as SessionRecord[])
  m.startSessionForTask.mockImplementation(async () => { h.records.push(isolated('sid-started')) })
  m.performSessionSend.mockImplementation(async (i: { to: string; messageId?: string }) => ({ scoped: isRouterDelivery(i.to, i.messageId) }))
})
afterEach(() => { installAwaySessions(null) })

describe('sendRoute (production same-area delivery)', () => {
  it('sends once to an existing isolated receiver, inside the router delivery scope, with no start', async () => {
    h.records = [isolated('sid-iso')]
    expect(await sendRoute(route, 'brief')).toEqual({ scoped: true })
    expect(m.startSessionForTask).not.toHaveBeenCalled()
    expect(m.performSessionSend).toHaveBeenCalledTimes(1)
    expect(m.performSessionSend.mock.calls[0][0]).toMatchObject({ to: 'sid-iso', messageId: MID, expectReply: false, source: 'api-agent', callerLabel: 'Router' })
  })

  it('starts one receiver for a task with none, and sends to it after reading everything again', async () => {
    await sendRoute(route, 'brief', 'sid-router')
    expect(m.startSessionForTask).toHaveBeenCalledWith(expect.objectContaining({ taskIdPrefix: 't-work', idle: true, awaitStart: true, expectReply: false }))
    expect(m.performSessionSend.mock.calls[0][0].to).toBe('sid-started')
  })

  it('refuses a task with a full-tool conversation in its history, with zero sends and no start', async () => {
    h.records = [isolated('sid-iso'), fullTool('sid-full')]
    expect(await code(sendRoute(route, 'brief'))).toBe('router_history_not_isolated')
    expect(m.performSessionSend).not.toHaveBeenCalled()
    expect(m.startSessionForTask).not.toHaveBeenCalled()
  })

  it('refuses a task naming a session the registry does not have', async () => {
    h.records = [isolated('sid-iso')]
    h.tasks.get('t-work')!.session_id = 'sid-ghost'
    expect(await code(sendRoute(route, 'brief'))).toBe('router_history_not_isolated')
    expect(m.performSessionSend).not.toHaveBeenCalled()
  })

  const during = (change: () => void) => m.startSessionForTask.mockImplementation(async () => { h.records.push(isolated('sid-started')); change() })

  it('a task completed during the start gets nothing', async () => {
    during(() => { h.tasks.get('t-work')!.phase = 'COMPLETE' })
    expect(await code(sendRoute(route, 'brief'))).toBe('target_unavailable')
    expect(m.performSessionSend).not.toHaveBeenCalled()
  })

  it('a task whose area mark changed during the start gets nothing', async () => {
    during(() => { h.tasks.get('t-work')!.router_area_id = 'work' })
    expect(await code(sendRoute(route, 'brief'))).toBe('target_scope')
    expect(m.performSessionSend).not.toHaveBeenCalled()
  })

  it('a task the registry moved out of the area during the start gets nothing', async () => {
    during(() => { (h.areas.value as RouterAreasFile).areas[0].taskIds = ['t-router'] })
    expect(await code(sendRoute(route, 'brief'))).toBe('task_unassigned')
    expect(m.performSessionSend).not.toHaveBeenCalled()
  })

  it('a receiver started with a full-tool profile gets nothing', async () => {
    m.startSessionForTask.mockImplementation(async () => { h.records.push(fullTool('sid-started-full')) })
    expect(await code(sendRoute(route, 'brief'))).toBe('router_history_not_isolated')
    expect(m.performSessionSend).not.toHaveBeenCalled()
  })

  it('a start that leaves no receiver sends nothing', async () => {
    m.startSessionForTask.mockImplementation(async () => undefined)
    expect(await code(sendRoute(route, 'brief'))).toBe('receiver_not_isolated')
    expect(m.performSessionSend).not.toHaveBeenCalled()
  })
})

describe('routeItem through the production sendRoute', () => {
  let store: RouterStore
  afterEach(async () => { await store.dispose() })

  it('a refused delivery settles failed with zero sends', async () => {
    store = new RouterStore(WALNUT_HOME, 'personal')
    h.records = [fullTool('sid-full')]
    const out = await routeItem(
      { source: { ...ITEM }, taskId: 't-work', reason: 'Dock work.', byTaskId: 't-router', text: 'Please confirm the slot.' },
      {
        areas: structuredClone(AREAS), store,
        resolve: async (source) => ({ source: { ...source }, key: routerKey(source), sender: 'pat@acme.example.invalid', subject: 'Dock slot' }),
        getTask: m.getTask,
      },
    )
    expect(out).toMatchObject({ fresh: true, route: { status: 'failed', taskId: 't-work' } })
    expect(m.performSessionSend).not.toHaveBeenCalled()
  })
})
