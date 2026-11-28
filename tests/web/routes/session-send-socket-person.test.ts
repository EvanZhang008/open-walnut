/**
 * The console's `session:send` and `session:start` RPCs frame words as the person's only from the
 * person's own socket (`client.person`, decided at the upgrade by person-caller.ts isPersonCaller;
 * the dispatcher scopes each call with ws/rpc-caller.ts). A local process that opened `/ws` with no
 * proof of his client sends as an agent, as its HTTP send does (2026-11-28 review: the RPC was
 * `sentBy: 'person'` whatever the socket). Same harness as session-hints-send.test.ts: the handler
 * is captured by stubbing `registerMethod`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/constants.js')>()
  return { ...actual, ...createMockConstants('walnut-socket-person') }
})

const { methods, registerMethod, broadcastEvent } = vi.hoisted(() => {
  const methods = new Map<string, (payload: unknown, client: unknown) => Promise<unknown>>()
  return {
    methods,
    registerMethod: vi.fn((name: string, handler: (p: unknown, c: unknown) => Promise<unknown>) => { methods.set(name, handler) }),
    broadcastEvent: vi.fn(),
  }
})
vi.mock('../../../src/web/ws/handler.js', () => ({
  registerMethod, broadcastEvent, sendToClient: vi.fn(), sendStreamEvent: vi.fn(),
}))

import { WALNUT_HOME } from '../../../src/constants.js'
import { bus, EventNames, type BusEvent } from '../../../src/core/event-bus.js'
import { registerSessionChatRpc } from '../../../src/web/routes/session-chat.js'
import { getQueue, resetCache } from '../../../src/core/session-message-queue.js'
import { createSessionRecord, _resetSessionTrackerForTesting } from '../../../src/core/session-tracker.js'
import { queueSentBy } from '../../../src/core/sessions/send-sent-by.js'
import { withRpcCaller } from '../../../src/web/ws/rpc-caller.js'

let seq = 0
async function newSession(): Promise<string> {
  seq += 1
  const sid = `dddddddd-eeee-ffff-aaaa-${String(seq).padStart(12, '0')}`
  await createSessionRecord(sid, `task-socket-${seq}`, '', '/tmp/socket-person-repo')
  return sid
}
const call = (name: string, payload: Record<string, unknown>) => methods.get(name)!(payload, {} as never)

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  resetCache()
  _resetSessionTrackerForTesting()
  bus.clear()
  methods.clear()
  registerSessionChatRpc()
})
afterEach(async () => {
  bus.clear()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('session:send frames the person only from the person\'s socket', () => {
  it('a socket that is not the person queues an agent\'s row', async () => {
    const sid = await newSession()
    await withRpcCaller(false, () => call('session:send', { sessionId: sid, message: 'from a local process' }))
    const [row] = await getQueue(sid)
    expect(row!.sentBy).toBe('agent')
    expect(queueSentBy('api-agent')).toBe('agent')
  })

  it('the person\'s socket queues the person\'s row', async () => {
    const sid = await newSession()
    await withRpcCaller(true, () => call('session:send', { sessionId: sid, message: 'his words' }))
    const [row] = await getQueue(sid)
    expect(row!.sentBy).toBe('person')
  })
})

describe('session:start attributes the words to the person only from his socket', () => {
  function startEvents(): BusEvent[] {
    const seen: BusEvent[] = []
    bus.subscribe('socket-person-test', (e) => { if (e.name === EventNames.SESSION_START) seen.push(e) }, { global: true })
    return seen
  }

  it('a socket that is not the person leaves the first message unattributed (framed as Walnut\'s)', async () => {
    const seen = startEvents()
    await withRpcCaller(false, () => call('session:start', { message: 'start something' }))
    expect(seen).toHaveLength(1)
    const data = seen[0]!.data as { attributed?: true; attributionSource?: string }
    expect(data.attributed).toBeUndefined()
    expect(data.attributionSource).toBe('a local client that is not the person')
  })

  it('the person\'s socket attributes it to his typed message', async () => {
    const seen = startEvents()
    await withRpcCaller(true, () => call('session:start', { message: 'start something' }))
    const data = seen[0]!.data as { attributed?: true; attributionSource?: string }
    expect(data).toMatchObject({ attributed: true, attributionSource: 'ui:typed-message' })
  })
})
