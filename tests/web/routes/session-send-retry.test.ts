/**
 * `session:send` retry must RE-DRAIN the surviving queue row, never enqueue a
 * second copy (inc-1786774073558).
 *
 * The incident: a `--resume` spawn failed, so `settleResumeFailure` reverted the
 * batch to 'pending' (the text must survive) AND emitted batch-failed so the UI
 * offered Retry. Retry re-sent the text as a BRAND-NEW message, so the queue held
 * the same words twice; `markProcessing` then batched both and joined them with
 * '\n\n', and the CLI received the user's message duplicated inside ONE enqueue
 * line. Live proof from the incident: the history row was 728 chars with
 * `firstHalf === secondHalf`, and the canonical JSONL's `queue-operation enqueue`
 * line was already double.
 *
 * Would-fail-if-reverted: drop the `retryOf` branch in session-chat.ts and test 1
 * sees a queue of 2 / test 3 sees the doubled '\n\n' payload.
 *
 * The RPC handler is captured by stubbing `registerMethod`, so no WS server, port,
 * or `claude` process is involved.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/constants.js')>()
  return { ...actual, ...createMockConstants('walnut-send-retry') }
})

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
vi.mock('../../../src/web/ws/handler.js', () => ({
  registerMethod, broadcastEvent, sendToClient: vi.fn(), sendStreamEvent: vi.fn(),
}))

import { WALNUT_HOME } from '../../../src/constants.js'
import { bus, EventNames, type BusEvent } from '../../../src/core/event-bus.js'
import { registerSessionChatRpc } from '../../../src/web/routes/session-chat.js'
import {
  enqueueMessage, getQueue, markProcessing, revertToPending, parkMessages, resetCache,
} from '../../../src/core/session-message-queue.js'

const SID = 'ffffffff-1111-2222-3333-444444444444'
const TEXT = 'please summarize the whole investigation and write it down'

const fakeClient = {} as never

/** Bus traffic we care about: the re-drain trigger and the bubble-minting event. */
let sends: BusEvent[] = []
let queued: BusEvent[] = []

async function callSend(payload: Record<string, unknown>): Promise<{ messageId?: string }> {
  const handler = methods.get('session:send')
  if (!handler) throw new Error('session:send was never registered')
  return (await handler(payload, fakeClient)) as { messageId?: string }
}

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  resetCache()

  bus.clear()
  sends = []
  queued = []
  bus.subscribe('session-runner', (event: BusEvent) => {
    if (event.name === EventNames.SESSION_SEND) sends.push(event)
  })
  bus.subscribe('main-ai', (event: BusEvent) => {
    if (event.name === EventNames.SESSION_MESSAGE_QUEUED) queued.push(event)
  })

  methods.clear()
  registerSessionChatRpc()
})

afterEach(async () => {
  bus.clear()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('session:send retryOf — retry after a failed delivery', () => {
  it('re-drains the surviving pending row instead of enqueueing a duplicate', async () => {
    // Reproduce the incident state: the message was batched, delivery failed, and
    // settleResumeFailure put it back as 'pending'.
    const original = await enqueueMessage(SID, TEXT)
    const batch = await markProcessing(SID)
    expect(batch).toHaveLength(1)
    await revertToPending(batch)

    const res = await callSend({ sessionId: SID, message: TEXT, retryOf: original.id })

    // Same identity back — the UI keeps its existing bubble.
    expect(res.messageId).toBe(original.id)

    // THE INVARIANT: the queue did not grow.
    const queue = await getQueue(SID)
    expect(queue).toHaveLength(1)
    expect(queue[0].id).toBe(original.id)
    expect(queue[0].message).toBe(TEXT)
    expect(queue[0].status).toBe('pending')

    // Delivery was re-triggered (session-runner then handleSend then processNext)...
    expect(sends).toHaveLength(1)
    expect((sends[0].data as { sessionId?: string }).sessionId).toBe(SID)
    // ...and no second bubble was minted.
    expect(queued).toHaveLength(0)
  })

  it('the next batch carries the text ONCE (the doubled payload can never form)', async () => {
    const original = await enqueueMessage(SID, TEXT)
    await revertToPending(await markProcessing(SID))

    await callSend({ sessionId: SID, message: TEXT, retryOf: original.id })

    // This is exactly what processNext does before writing to the CLI.
    const nextBatch = await markProcessing(SID)
    const combined = nextBatch.map((m) => m.message).join('\n\n')
    expect(nextBatch).toHaveLength(1)
    expect(combined).toBe(TEXT)
    // The incident signature: two identical halves inside one payload.
    expect(combined.split(TEXT).length - 1).toBe(1)
    expect(combined).not.toContain(`${TEXT}\n\n${TEXT}`)
  })

  it('falls back to a fresh enqueue when the original row is gone (retry never no-ops)', async () => {
    // The row was already drained (delivery actually succeeded, or the user
    // deleted it) — a retry must still put the text somewhere, or the message is
    // silently lost.
    const res = await callSend({ sessionId: SID, message: TEXT, retryOf: 'qm-long-gone' })

    expect(res.messageId).toBeTruthy()
    expect(res.messageId).not.toBe('qm-long-gone')

    const queue = await getQueue(SID)
    expect(queue).toHaveLength(1)
    expect(queue[0].message).toBe(TEXT)
    // The normal send path ran: it mints a bubble AND triggers delivery.
    expect(queued).toHaveLength(1)
    expect(sends).toHaveLength(1)
  })

  it('a retry of a row that is still mid-flight (processing) adds nothing', async () => {
    // Racy Retry click while the batch is being delivered. The row is 'processing',
    // not 'pending' — but it is still QUEUED, so delivery hasn't settled and the
    // text must not be duplicated beside it: if this in-flight batch also fails,
    // revertToPending would restore the original next to the copy and we'd be back
    // to the doubled payload one step later.
    const original = await enqueueMessage(SID, TEXT)
    const batch = await markProcessing(SID)
    expect(batch[0].id).toBe(original.id)

    const res = await callSend({ sessionId: SID, message: TEXT, retryOf: original.id })
    expect(res.messageId).toBe(original.id)

    const queue = await getQueue(SID)
    expect(queue).toHaveLength(1)
    expect(queue[0].id).toBe(original.id)
    expect(queued).toHaveLength(0)

    // Worst case: that in-flight batch fails and is reverted. The next batch still
    // carries the text exactly once.
    await revertToPending(batch)
    const nextBatch = await markProcessing(SID)
    expect(nextBatch).toHaveLength(1)
    expect(nextBatch.map((m) => m.message).join('\n\n')).toBe(TEXT)
  })
})

// A PARKED row is deliberately invisible to markProcessing, so the re-drain above
// would do nothing at all for one. An explicit user Retry is the ONLY thing allowed
// to revive it — and it still must not enqueue a duplicate.
describe('session:send retryOf — retry of a PARKED row', () => {
  it('un-parks the row to pending and re-drains it, without duplicating the text', async () => {
    const original = await enqueueMessage(SID, TEXT)
    await parkMessages(await markProcessing(SID), 'Working directory no longer exists: /gone')
    expect((await getQueue(SID))[0].status).toBe('parked')

    const res = await callSend({ sessionId: SID, message: TEXT, retryOf: original.id })
    expect(res.messageId).toBe(original.id)

    const queue = await getQueue(SID)
    expect(queue).toHaveLength(1)
    expect(queue[0].id).toBe(original.id)
    expect(queue[0].status).toBe('pending')
    expect(queue[0].parkedReason).toBeUndefined()

    // Delivery re-triggered, no second bubble.
    expect(sends).toHaveLength(1)
    expect(queued).toHaveLength(0)

    // And the revived row is drainable again (this is what silently did nothing
    // before the un-park).
    const nextBatch = await markProcessing(SID)
    expect(nextBatch).toHaveLength(1)
    expect(nextBatch.map((m) => m.message).join('\n\n')).toBe(TEXT)
  })
})
