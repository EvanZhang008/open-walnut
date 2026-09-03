/**
 * Retry = RECONNECT, never a synthesized message (user report 2026-09-03:
 * "I only click retry and it sends a `continue` to the session. I don't want it.
 * I just wanted to connect.").
 *
 * The dead-process + resumable-conversation + EMPTY-queue path used to enqueue
 * the literal word 'continue', i.e. Retry started a turn with a prompt the human
 * never wrote. It must now relabel the record to a resumable state, clear the
 * stale error, and send NOTHING.
 *
 * Real session-tracker + real message queue over an isolated tmp WALNUT_HOME —
 * the "no message was sent" assertion is only worth anything against the real
 * queue. Only liveness, the JSONL probe and the send call are instrumented.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fsp from 'node:fs/promises'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-retry-reconnect'))

// Hoisted so the mock factories below (which vitest lifts above every import)
// can read it AND the tests can steer it per case.
const stub = vi.hoisted(() => ({
  /** Liveness — the branch selector at the top of retrySession. */
  alive: false,
  /** Conversation pre-flight: present by default (the --resume-eligible shape). */
  jsonlPath: '/fake/projects/x/conv.jsonl' as string | null,
  /** Every sendMessageToSession call, recorded at the call site. */
  sendCalls: [] as unknown[][],
}))

vi.mock('../../src/core/session-file-reader.js', () => ({
  findLocalJsonlPath: async () => stub.jsonlPath,
}))
vi.mock('../../src/utils/session-liveness.js', () => ({
  isSessionProcessAlive: async () => stub.alive,
}))

// Partial mock: everything real EXCEPT that every sendMessageToSession call is
// recorded. This is the assertion the user's complaint is about, so it is pinned
// at the call site, not inferred from the queue's end state alone.
vi.mock('../../src/core/session-message-queue.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/session-message-queue.js')>()
  return {
    ...actual,
    sendMessageToSession: (...args: Parameters<typeof actual.sendMessageToSession>) => {
      stub.sendCalls.push(args)
      return actual.sendMessageToSession(...args)
    },
  }
})

import { WALNUT_HOME } from '../../src/constants.js'
import { bus, EventNames, type BusEvent } from '../../src/core/event-bus.js'
import {
  createSessionRecord,
  getSessionByClaudeId,
  updateSessionRecord,
  _resetSessionTrackerForTesting,
} from '../../src/core/session-tracker.js'
import { closeDb } from '../../src/core/session-db.js'
import { sendMessageToSession, getQueue } from '../../src/core/session-message-queue.js'
import { retrySession } from '../../src/core/sessions/session-lifecycle.js'

/** Every SESSION_SEND / SESSION_START the retry emits (a turn can only start
 *  through one of these two). */
function captureLaunchEvents(): { events: BusEvent[]; stop: () => void } {
  const events: BusEvent[] = []
  bus.subscribe('session-runner', (event) => {
    if (event.name === EventNames.SESSION_SEND || event.name === EventNames.SESSION_START) {
      events.push(event)
    }
  })
  return { events, stop: () => bus.unsubscribe('session-runner') }
}

beforeEach(async () => {
  closeDb()
  _resetSessionTrackerForTesting()
  bus.clear()
  stub.sendCalls.length = 0
  stub.alive = false
  stub.jsonlPath = '/fake/projects/x/conv.jsonl'
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
})

afterEach(async () => {
  vi.restoreAllMocks()
  closeDb()
  _resetSessionTrackerForTesting()
  bus.clear()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('retrySession — dead process, resumable conversation, EMPTY queue', () => {
  it('sends NO message and leaves the record resumable, stamped as user intent', async () => {
    const sid = 'retry-rc-empty'
    await createSessionRecord(sid, 'task-rc1', 'proj', '/tmp/rc', { initialProcessStatus: 'error' })
    await updateSessionRecord(sid, {
      errorMessage: 'Connection lost — unable to reach remote host',
      status_reason: 'remote_unreachable',
      status_changed_by: 'health-monitor',
    } as never)

    const cap = captureLaunchEvents()
    try {
      const res = await retrySession(sid)
      expect(res.status).toBe('resumable')
      expect(res).toMatchObject({ sessionId: sid })

      // The complaint, pinned three ways: no send call, nothing in the queue,
      // and no turn-starting bus event.
      expect(stub.sendCalls).toEqual([])
      expect(await getQueue(sid)).toHaveLength(0)
      expect(cap.events).toHaveLength(0)
    } finally {
      cap.stop()
    }

    const rec = await getSessionByClaudeId(sid)
    expect(rec?.process_status).toBe('stopped')   // resumable: --resume on next send
    expect(rec?.errorMessage ?? null).toBeNull()  // the stale banner text is gone
    expect(rec?.archived).not.toBe(true)          // conversation preserved
    // The stamp is the contract: ('user','retry_reconnect') is category-② in
    // session-snapshot-gate (never gated) and makes the row intentional-terminal
    // in session-snapshot-apply, so a death snapshot can't re-redden it.
    expect(rec?.status_changed_by).toBe('user')
    expect(rec?.status_reason).toBe('retry_reconnect')
  })

  it('never injects the word "continue" (the exact regression)', async () => {
    const sid = 'retry-rc-nocontinue'
    await createSessionRecord(sid, 'task-rc2', 'proj', '/tmp/rc', { initialProcessStatus: 'error' })

    await retrySession(sid)

    const queue = await getQueue(sid)
    expect(queue.some((m) => m.message === 'continue')).toBe(false)
    expect(stub.sendCalls).toEqual([])
  })
})

describe('retrySession — dead process with a NON-empty pending queue', () => {
  it("re-sends the user's ORIGINAL message and injects nothing", async () => {
    const sid = 'retry-rc-queued'
    await createSessionRecord(sid, 'task-rc3', 'proj', '/tmp/rc', { initialProcessStatus: 'error' })
    await sendMessageToSession(sid, 'original user prompt', { taskId: 'task-rc3' })
    stub.sendCalls.length = 0 // the seed above is the user's own send, not the retry's

    const cap = captureLaunchEvents()
    try {
      const res = await retrySession(sid)
      expect(res).toMatchObject({ status: 'resuming', sessionId: sid, restoredMessages: 1 })

      // processNext is re-triggered (that is what delivers the ORIGINAL text) …
      expect(cap.events).toHaveLength(1)
      expect(cap.events[0]?.name).toBe(EventNames.SESSION_SEND)
      // … and nothing new was enqueued on top of it.
      expect(stub.sendCalls).toEqual([])
    } finally {
      cap.stop()
    }

    const queue = await getQueue(sid)
    expect(queue.map((m) => m.message)).toEqual(['original user prompt'])
  })

  it('revives a PARKED row instead of reporting a retry that did nothing', async () => {
    const sid = 'retry-rc-parked'
    await createSessionRecord(sid, 'task-rc4', 'proj', '/tmp/rc', { initialProcessStatus: 'error' })
    await sendMessageToSession(sid, 'parked prompt', { taskId: 'task-rc4' })
    const seeded = await getQueue(sid)
    const { parkMessages } = await import('../../src/core/session-message-queue.js')
    await parkMessages(seeded, 'test-park')
    stub.sendCalls.length = 0

    const res = await retrySession(sid)
    expect(res).toMatchObject({ status: 'resuming', restoredMessages: 1 })
    const queue = await getQueue(sid)
    expect(queue[0]?.status).toBe('pending')
    expect(stub.sendCalls).toEqual([])
  })
})

describe('retrySession — process still alive', () => {
  it('returns reconnected and clears the stale error without sending anything', async () => {
    const sid = 'retry-rc-alive'
    stub.alive = true
    await createSessionRecord(sid, 'task-rc5', 'proj', '/tmp/rc', { initialProcessStatus: 'error' })
    await updateSessionRecord(sid, {
      errorMessage: 'Connection lost — unable to reach remote host',
    } as never)

    const cap = captureLaunchEvents()
    try {
      const res = await retrySession(sid)
      expect(res).toEqual({ status: 'reconnected', sessionId: sid })
      expect(cap.events).toHaveLength(0)
    } finally {
      cap.stop()
    }

    expect(stub.sendCalls).toEqual([])
    const rec = await getSessionByClaudeId(sid)
    expect(rec?.process_status).toBe('running')
    expect(rec?.errorMessage ?? null).toBeNull()
    expect(rec?.status_reason).toBe('retry_reconnect')
    expect(rec?.status_changed_by).toBe('user')
  })
})
