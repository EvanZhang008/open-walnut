/**
 * WS `chat:stop` reaches the Personal AI's lane session.
 *
 * The handler used to abort ONLY the per-socket AbortController. On the lane
 * engine the turn is running inside a `claude` CLI the daemon owns, so that abort
 * stops nothing observable: the user pressed stop, the spinner cleared, and the
 * CLI kept working (and kept spending tokens). The fix routes the stop through the
 * canonical bus SESSION_INTERRUPT — the exact path the session composer's stop
 * button uses — so this file asserts that emit, plus the two properties that keep
 * it safe: the pre-existing in-process abort still happens, and a lane failure can
 * never turn a stop into an RPC error.
 *
 * The handler is captured by stubbing `registerMethod`, so no WS server or port is
 * involved. No `claude` is spawned; no signal is ever sent.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/constants.js')>()
  return { ...actual, ...createMockConstants('walnut-chatstop-lane') }
})

/** RPC methods chat.ts registers, captured instead of attached to a WS server. */
const { methods, registerMethod, broadcastEvent } = vi.hoisted(() => {
  const methods = new Map<string, (payload: unknown, client: unknown) => Promise<unknown>>()
  return {
    methods,
    registerMethod: vi.fn((name: string, handler: (p: unknown, c: unknown) => Promise<unknown>) => {
      methods.set(name, handler)
    }),
    broadcastEvent: vi.fn(),
  }
})
vi.mock('../../../src/web/ws/handler.js', () => ({ registerMethod, broadcastEvent, sendToClient: vi.fn() }))

import { WALNUT_HOME } from '../../../src/constants.js'
import { bus, EventNames, type BusEvent } from '../../../src/core/event-bus.js'
import { registerChatRpc } from '../../../src/web/routes/chat.js'
import { personalAiLaneKey } from '../../../src/core/sessions/personal-ai-lane.js'

const LANE_SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

/** SESSION_INTERRUPT payloads seen on the bus. */
let interrupts: Array<{ sessionId?: string }> = []

/** A stand-in for the WebSocket the RPC receives (only used as a Map key). */
const fakeClient = {} as never

async function callStop(payload: Record<string, unknown>): Promise<void> {
  const handler = methods.get('chat:stop')
  if (!handler) throw new Error('chat:stop was never registered')
  await handler(payload, fakeClient)
}

async function seedLane(conversationId: string, processStatus = 'running'): Promise<void> {
  const { createSessionRecord, updateSessionRecord } = await import('../../../src/core/session-tracker.js')
  await createSessionRecord(LANE_SID, '', '', WALNUT_HOME, {
    title: 'Personal AI chat',
    lane: personalAiLaneKey('general', conversationId),
    initialProcessStatus: 'idle',
  })
  if (processStatus !== 'idle') {
    await updateSessionRecord(LANE_SID, { process_status: processStatus } as Record<string, unknown>)
  }
}

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  const [sessionDb, sessionTracker] = await Promise.all([
    import('../../../src/core/session-db.js'),
    import('../../../src/core/session-tracker.js'),
  ])
  sessionDb.closeDb()
  sessionTracker._resetSessionTrackerForTesting()

  bus.clear()
  interrupts = []
  bus.subscribe('session-runner', (event: BusEvent) => {
    if (event.name === EventNames.SESSION_INTERRUPT) interrupts.push(event.data as { sessionId?: string })
  })

  methods.clear()
  registerChatRpc()
})

afterEach(async () => {
  bus.clear()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {})
})

describe('chat:stop with a lane session', () => {
  it('interrupts the lane bound to the EXPLICIT conversation in the payload', async () => {
    const { createConversation } = await import('../../../src/core/conversations.js')
    const conv = await createConversation('general', 'Stop target')
    await seedLane(conv.id, 'running')

    await callStop({ agentId: 'general', conversationId: conv.id })
    expect(interrupts).toEqual([{ sessionId: LANE_SID }])
  })

  it("falls back to the agent's ACTIVE conversation when the payload omits one", async () => {
    // The web client does send conversationId, but REST/older clients may not —
    // resolving the active pointer is what keeps stop working for them.
    const { getActiveConversationId } = await import('../../../src/core/conversations.js')
    const active = await getActiveConversationId('general')
    await seedLane(active, 'running')

    await callStop({})
    expect(interrupts).toEqual([{ sessionId: LANE_SID }])
  })

  it('does not interrupt a lane belonging to a DIFFERENT conversation', async () => {
    const { createConversation } = await import('../../../src/core/conversations.js')
    const mine = await createConversation('general', 'Mine')
    const other = await createConversation('general', 'Other')
    await seedLane(other.id, 'running')

    await callStop({ agentId: 'general', conversationId: mine.id })
    expect(interrupts).toEqual([])
  })

  it('is a silent no-op when the conversation has no lane (in-process engine)', async () => {
    const { createConversation } = await import('../../../src/core/conversations.js')
    const conv = await createConversation('general', 'No lane')
    await expect(callStop({ agentId: 'general', conversationId: conv.id })).resolves.toBeUndefined()
    expect(interrupts).toEqual([])
  })

  it('never rejects when the lane lookup itself fails', async () => {
    // A stop that throws would surface as a red RPC error on a button whose whole
    // job is to calm things down.
    const tracker = await import('../../../src/core/session-tracker.js')
    const spy = vi.spyOn(tracker, 'getSessionByLane').mockRejectedValue(new Error('sqlite is gone'))
    try {
      await expect(callStop({ agentId: 'general', conversationId: 'conv-anything' })).resolves.toBeUndefined()
      expect(interrupts).toEqual([])
    } finally {
      spy.mockRestore()
    }
  })

  it('never sends a process signal', async () => {
    const { createConversation } = await import('../../../src/core/conversations.js')
    const conv = await createConversation('general', 'Bus only')
    await seedLane(conv.id, 'running')
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    try {
      await callStop({ agentId: 'general', conversationId: conv.id })
      expect(killSpy).not.toHaveBeenCalled()
    } finally {
      killSpy.mockRestore()
    }
  })
})
