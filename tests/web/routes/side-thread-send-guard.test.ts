/**
 * A FILED side thread must stay filed.
 *
 * Archiving a thread retires its CLI on purpose. Nothing else stopped a send to it:
 * the composer's `disabled` prop is not a guarantee (a second tab, a stale view, a
 * script), and a send to a dead session cold-resumes it. The resulting process is a
 * `side:` LANE session, so it is hidden from every session list, and the side-thread
 * reapers skip archived records — nothing in Walnut would ever reap it again.
 *
 * The guard is scoped to `side:` lanes on purpose: an ordinary archived session may
 * still be resumed by sending to it, which is a shipped behaviour this must not break.
 *
 * Would-fail-if-reverted: drop the archived-lane check in session-chat.ts and the
 * first test queues a message for a thread the user filed away.
 *
 * Harness: `registerMethod` is stubbed to capture the RPC handler (same approach as
 * session-output-mode.test.ts) — no WS server, no port, no `claude` process.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/constants.js')>()
  return { ...actual, ...createMockConstants('walnut-side-send-guard') }
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
import { bus } from '../../../src/core/event-bus.js'
import { registerSessionChatRpc } from '../../../src/web/routes/session-chat.js'
import { getQueue, resetCache } from '../../../src/core/session-message-queue.js'
import {
  createSessionRecord, updateSessionRecord, _resetSessionTrackerForTesting,
} from '../../../src/core/session-tracker.js'
import { sideThreadLaneKey } from '../../../src/core/sessions/side-thread-fork.js'
import { addSideThread, setSideThreadArchived } from '../../../src/core/side-questions.js'

const PARENT = '11111111-1111-4111-8111-111111111111'
const fakeClient = {} as never

let seq = 0
async function newThreadSession(opts: {
  lane?: string; archived?: boolean;
}): Promise<string> {
  seq += 1
  const sid = `bbbbbbbb-cccc-4ddd-8eee-${String(seq).padStart(12, '0')}`
  await createSessionRecord(sid, '', '', '/tmp/side-guard-repo')
  await updateSessionRecord(sid, {
    ...(opts.lane ? { lane: opts.lane } : {}),
    ...(opts.archived ? { archived: true, archive_reason: 'side_thread_archived' } : {}),
  })
  return sid
}

async function callSend(sessionId: string, message: string): Promise<unknown> {
  const handler = methods.get('session:send')
  if (!handler) throw new Error('session:send was never registered')
  return handler({ sessionId, message }, fakeClient)
}

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

describe('session:send — a filed side thread refuses the follow-up', () => {
  it('refuses an ARCHIVED side-thread lane session and queues nothing', async () => {
    const sid = await newThreadSession({
      lane: sideThreadLaneKey(PARENT, 'sth-1'), archived: true,
    })

    await expect(callSend(sid, 'one more thing')).rejects.toThrow(/archived/i)
    expect(await getQueue(sid)).toHaveLength(0)
  })

  it('allows the same thread once it is restored', async () => {
    const sid = await newThreadSession({ lane: sideThreadLaneKey(PARENT, 'sth-2') })

    await expect(callSend(sid, 'one more thing')).resolves.toBeTruthy()
    expect(await getQueue(sid)).toHaveLength(1)
  })

  /** The one filed state that keeps its process: a thread with no transcript yet is
   *  filed WITHOUT the kill (killing it would strand it), so the record flag says
   *  nothing. The row carries the stamp, and the row is what the user acted on. */
  it('refuses a thread the ROW says was filed, even with the record still un-archived', async () => {
    const sid = await newThreadSession({ lane: sideThreadLaneKey(PARENT, 'sth-filed') })
    await addSideThread(PARENT, {
      id: 'sth-filed', question: 'why does bind() need this', threadSessionId: sid,
    })
    await setSideThreadArchived(PARENT, 'sth-filed', true)

    await expect(callSend(sid, 'one more thing')).rejects.toThrow(/archived/i)
    expect(await getQueue(sid)).toHaveLength(0)
  })

  it('allows a side thread whose row is present and NOT filed', async () => {
    const sid = await newThreadSession({ lane: sideThreadLaneKey(PARENT, 'sth-live') })
    await addSideThread(PARENT, {
      id: 'sth-live', question: 'still working on this', threadSessionId: sid,
    })

    await expect(callSend(sid, 'one more thing')).resolves.toBeTruthy()
    expect(await getQueue(sid)).toHaveLength(1)
  })

  it('leaves an ordinary archived session alone (resume-on-send is a real feature)', async () => {
    const sid = await newThreadSession({ archived: true })

    await expect(callSend(sid, 'pick this back up')).resolves.toBeTruthy()
    expect(await getQueue(sid)).toHaveLength(1)
  })
})
