// The production delivery (src/core/router/service.ts `sendRoute`): the routed item goes into the
// owner's own conversation as a Router message, never as the person's words; a task with no
// conversation yet starts with the message. Only the send core and the start are mocked.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'
import type { RouterAreasFile } from '../../src/core/router/areas.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-router-send-route'))

const m = vi.hoisted(() => ({
  getTask: vi.fn(),
  startSessionForTask: vi.fn(),
  performSessionSend: vi.fn(),
}))

vi.mock('../../src/core/task-manager.js', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), getTask: m.getTask }))
vi.mock('../../src/core/sessions/task-start.js', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), startSessionForTask: m.startSessionForTask }))
vi.mock('../../src/core/sessions/session-send-core.js', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), performSessionSend: m.performSessionSend }))

import { SendError } from '../../src/core/sessions/session-send-core.js'
import { ROUTER_START_SOURCE, routeItem, sendRoute } from '../../src/core/router/service.js'
import { RouterStore, routerKey, routerMessageId } from '../../src/core/router/store.js'
import type { RouterRoute, RouterSource } from '../../src/core/router/types.js'
import { WALNUT_HOME } from '../../src/constants.js'

const ACCOUNT = 'desk@marina.example.invalid'
const ITEM: RouterSource = { kind: 'mail', account: ACCOUNT, message: 'INBOX:1:10' }
// The ledger file lives under the mocked home for the whole file: each routeItem case has its own item.
const ITEM_2: RouterSource = { kind: 'mail', account: ACCOUNT, message: 'INBOX:1:11' }
const AREAS: RouterAreasFile = {
  version: 1,
  areas: [{ id: 'personal', name: 'Personal', host: '__local__', taskIds: ['t-router'], sources: [{ kind: 'mail', account: ACCOUNT }] }],
  routers: [{ taskId: 't-router', areaId: 'personal', paused: false }],
  items: [],
  openItems: [{ source: { ...ITEM }, areaId: 'personal' }, { source: { ...ITEM_2 }, areaId: 'personal' }],
}
const MID = routerMessageId('personal', routerKey(ITEM), 't-work')
const route: RouterRoute = {
  areaId: 'personal', key: routerKey(ITEM), source: { ...ITEM }, sender: 'pat@acme.example.invalid', subject: 'Dock slot',
  status: 'routing', taskId: 't-work', reason: 'Dock work.', at: 1, messageId: MID,
}
const code = async (p: Promise<unknown>): Promise<string> => p.then(() => 'resolved', (e: { code?: string }) => e.code ?? String(e))

beforeEach(() => {
  for (const fn of Object.values(m)) fn.mockReset()
  m.getTask.mockImplementation(async (id: string) => {
    if (id === 't-work') return { id, title: 'Dock work', phase: 'IN_PROGRESS' }
    if (id === 't-router') return { id, title: 'Router', phase: 'IN_PROGRESS', org_role: 'router' }
    throw new Error(`Task not found: ${id}`)
  })
  m.performSessionSend.mockResolvedValue({ ok: true })
  m.startSessionForTask.mockResolvedValue({ started: true })
})

describe('sendRoute', () => {
  it('sends once into the owner task as the Router, under the route message id, with no start', async () => {
    expect(await sendRoute(route, 'the routed text')).toEqual({ ok: true })
    expect(m.startSessionForTask).not.toHaveBeenCalled()
    expect(m.performSessionSend).toHaveBeenCalledTimes(1)
    expect(m.performSessionSend.mock.calls[0][0]).toMatchObject({
      to: 't-work', text: 'the routed text', messageId: MID, expectReply: false,
      callerSid: 'external', source: 'api-agent', callerLabel: 'Router',
    })
    expect(m.performSessionSend.mock.calls[0][0].title).toContain('Dock slot')
  })

  it('starts a task with no conversation yet with the routed text as its first message', async () => {
    m.performSessionSend.mockRejectedValueOnce(new SendError('task_has_no_session', 'no session', 409))
    expect(await sendRoute(route, 'the routed text')).toEqual({ started: true })
    expect(m.startSessionForTask).toHaveBeenCalledTimes(1)
    expect(m.startSessionForTask.mock.calls[0][0]).toMatchObject({
      taskIdPrefix: 't-work', source: ROUTER_START_SOURCE, expectReply: false, callerSid: 'external',
    })
    // Its first turn reads as the Router's, like every later delivery: never as the person's words.
    const first = m.startSessionForTask.mock.calls[0][0].message as string
    expect(first).toContain('the routed text')
    expect(first).toContain('Walnut (Router)')
    expect(ROUTER_START_SOURCE).toBe('router-delivery')
  })

  it('passes any other refusal through and starts nothing', async () => {
    m.performSessionSend.mockRejectedValueOnce(new SendError('target_complete', 'done', 409))
    expect(await code(sendRoute(route, 'x'))).toBe('target_complete')
    m.performSessionSend.mockRejectedValueOnce(new Error('socket closed'))
    expect(await code(sendRoute(route, 'x'))).toBe('Error: socket closed')
    expect(m.startSessionForTask).not.toHaveBeenCalled()
  })
})

describe('routeItem through the production sendRoute', () => {
  let store: RouterStore
  afterEach(async () => { await store.dispose() })

  const run = (item: RouterSource) => routeItem(
    { source: { ...item }, taskId: 't-work', reason: 'Dock work.', byTaskId: 't-router', text: 'Please confirm the slot.' },
    {
      areas: structuredClone(AREAS), store,
      resolve: async (source) => ({ source: { ...source }, key: routerKey(source), sender: 'pat@acme.example.invalid', subject: 'Dock slot' }),
      read: async () => { throw new Error('not cached') },
      getTask: m.getTask,
    },
  )

  it('a delivered item settles routed, and the owner got the brief and the reference', async () => {
    store = new RouterStore(WALNUT_HOME, 'personal')
    expect(await run(ITEM)).toMatchObject({ fresh: true, route: { status: 'routed', taskId: 't-work' } })
    const text = m.performSessionSend.mock.calls[0][0].text as string
    expect(text).toContain('Please confirm the slot.')
    expect(text).toContain(`mail_read {"account":"${ACCOUNT}","message":"INBOX:1:10"}`)
  })

  it('a refused delivery settles failed', async () => {
    store = new RouterStore(WALNUT_HOME, 'personal')
    m.performSessionSend.mockRejectedValueOnce(new SendError('queue_full', 'queue is full', 429))
    expect(await run(ITEM_2)).toMatchObject({ fresh: true, route: { status: 'failed', taskId: 't-work', error: 'queue is full' } })
    expect(m.startSessionForTask).not.toHaveBeenCalled()
  })
})
