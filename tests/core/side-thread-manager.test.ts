/**
 * Side-thread lifecycle — the manager is the ONLY reaper that will ever touch a
 * side thread (taskless + lane-hidden = every other reaper skips it), so these
 * are the tests that keep prewarmed forks from leaking `claude` processes.
 *
 * SAFETY: every destructive primitive is STUBBED before any test body runs —
 * `terminateSession`, `sessionRunner.markExpectedTeardown` and
 * `sendMessageToSession` are pure spies, and no `claude` is ever spawned (the
 * 'session-runner' subscriber is a fake that just marks the record as spawned).
 * Only ARGUMENTS are asserted. Nothing here may signal a real process.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fsp from 'node:fs/promises'
import { createMockConstants } from '../helpers/mock-constants.js'

const mocks = vi.hoisted(() => ({
  terminateSession: vi.fn(async (sessionId: string) => ({ status: 'terminated' as const, sessionId })),
  markExpectedTeardown: vi.fn(),
  sendMessageToSession: vi.fn(async () => ({ id: 'qm-test' })),
}))

vi.mock('../../src/constants.js', () => createMockConstants('walnut-side-mgr'))
vi.mock('../../src/core/sessions/session-lifecycle.js', () => ({
  terminateSession: mocks.terminateSession,
}))
vi.mock('../../src/providers/claude-code-session.js', () => ({
  sessionRunner: { markExpectedTeardown: mocks.markExpectedTeardown },
}))
vi.mock('../../src/core/session-message-queue.js', () => ({
  sendMessageToSession: mocks.sendMessageToSession,
}))

import { bus, EventNames, type BusEvent } from '../../src/core/event-bus.js'
import { WALNUT_HOME } from '../../src/constants.js'
import {
  createSessionRecord, getSessionByClaudeId, updateSessionRecord,
} from '../../src/core/session-tracker.js'
import { sideThreadManager } from '../../src/core/sessions/side-thread-manager.js'
import { listSideQuestions } from '../../src/core/side-questions.js'
import type { SessionStartEvent } from '../../src/core/event-types.js'

const PARENT = '11111111-1111-4111-8111-111111111111'
let started: SessionStartEvent[] = []

/** Stand in for the runner: no spawn, just the record state a spawned CLI leaves
 *  behind (idle + an output file, which is what makes it live and resumable). */
function installFakeRunner(): void {
  bus.subscribe('session-runner', (event: BusEvent) => {
    if (event.name !== EventNames.SESSION_START) return
    const data = event.data as SessionStartEvent
    started.push(data)
    const sid = data.preassignedSessionId
    if (!sid) return
    void updateSessionRecord(sid, {
      process_status: 'idle',
      outputFile: `/tmp/streams/${sid}.jsonl`,
    }).catch(() => {})
  })
}

beforeEach(async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-08-31T10:00:00.000Z'))
  bus.clear()
  started = []
  mocks.terminateSession.mockClear()
  mocks.markExpectedTeardown.mockClear()
  mocks.sendMessageToSession.mockClear()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
  const [sessionDb, sessionTracker] = await Promise.all([
    import('../../src/core/session-db.js'),
    import('../../src/core/session-tracker.js'),
  ])
  sessionDb.closeDb()
  sessionTracker._resetSessionTrackerForTesting()
  installFakeRunner()
  await createSessionRecord(PARENT, 'task-77', 'proj', '/repo/walnut', {
    title: 'Fix the FIFO stall',
    cliModel: 'opus[1m]',
    outputFile: '/tmp/streams/parent.jsonl',
  })
})

afterEach(async () => {
  sideThreadManager.stop()
  bus.clear()
  vi.useRealTimers()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
})

/**
 * Let the manager's fire-and-forget tails settle. Those chains are long (dynamic
 * imports + sqlite reads/writes) but purely microtask-bound — no real I/O — so
 * spinning the microtask queue is enough; the timer flushes cover any 0ms hop.
 */
async function settle(): Promise<void> {
  for (let round = 0; round < 12; round++) {
    for (let i = 0; i < 25; i++) await Promise.resolve()
    await vi.advanceTimersByTimeAsync(0)
  }
}

describe('standby prewarm', () => {
  it('forks one init-only standby and reuses it on the next call', async () => {
    const first = await sideThreadManager.ensureStandby(PARENT)
    const second = await sideThreadManager.ensureStandby(PARENT)
    expect(second).toBe(first)
    expect(started).toHaveLength(1)
    expect(started[0]!.message).toBe('')
    expect(started[0]!.lane).toBe(`side:${PARENT}:standby`)
  })

  it('dedupes concurrent prewarms into ONE fork', async () => {
    const [a, b, c] = await Promise.all([
      sideThreadManager.ensureStandby(PARENT),
      sideThreadManager.ensureStandby(PARENT),
      sideThreadManager.ensureStandby(PARENT),
    ])
    expect(new Set([a, b, c]).size).toBe(1)
    expect(started).toHaveLength(1)
  })

  it('retires an unconsumed standby after its TTL (terminate + archive)', async () => {
    const sid = await sideThreadManager.ensureStandby(PARENT)
    expect(mocks.terminateSession).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(120_000)
    await settle()

    expect(mocks.markExpectedTeardown).toHaveBeenCalledWith(sid, 'side_thread_standby_ttl')
    expect(mocks.terminateSession).toHaveBeenCalledWith(sid, { force: true })
    const record = await getSessionByClaudeId(sid!)
    expect(record?.archived).toBe(true)
    expect(record?.archive_reason).toBe('side_thread_standby_ttl')
  })

  it('replaces a standby the parent has moved past', async () => {
    const stale = await sideThreadManager.ensureStandby(PARENT)
    // The parent's TRANSCRIPT grew (stream events consumed) — bookkeeping-only
    // writes (activity/status) must NOT count as staleness, only this does.
    vi.setSystemTime(new Date('2026-08-31T10:00:05.000Z'))
    await updateSessionRecord(PARENT, { consumedOffset: 4321 })

    const fresh = await sideThreadManager.ensureStandby(PARENT)
    expect(fresh).not.toBe(stale)
    expect(started).toHaveLength(2)
    // The stale standby's retire is fire-and-forget (out of the ask path).
    await settle()
    expect(mocks.terminateSession).toHaveBeenCalledWith(stale, { force: true })
    expect((await getSessionByClaudeId(stale!))?.archived).toBe(true)
  })
})

describe('createThread', () => {
  it('consumes the standby: lane re-pointed, TTL cancelled, question sent', async () => {
    const standby = await sideThreadManager.ensureStandby(PARENT)
    const thread = await sideThreadManager.createThread(PARENT, { question: 'why hasPipe?' })

    expect(thread.threadSessionId).toBe(standby)
    expect((await getSessionByClaudeId(standby!))?.lane)
      .toBe(`side:${PARENT}:${thread.id}`)
    // Consuming means the ordinary send path delivers — no second spawn.
    expect(started).toHaveLength(1)
    expect(mocks.sendMessageToSession).toHaveBeenCalledWith(standby, 'why hasPipe?', { source: 'side-thread' })

    await vi.advanceTimersByTimeAsync(120_000)
    await settle()
    expect(mocks.terminateSession).not.toHaveBeenCalled()
  })

  it('forks fresh with the question as the first turn when no standby exists', async () => {
    const thread = await sideThreadManager.createThread(PARENT, { question: 'what broke?' })
    expect(started).toHaveLength(1)
    expect(started[0]!.message).toBe('what broke?')
    expect(started[0]!.lane).toBe(`side:${PARENT}:${thread.id}`)
    // Riding the spawn is the only race-free delivery — no send is issued.
    expect(mocks.sendMessageToSession).not.toHaveBeenCalled()
  })

  it('persists the thread in the parent\'s store', async () => {
    const thread = await sideThreadManager.createThread(PARENT, { question: 'q1', title: 'FIFO' })
    const stored = await listSideQuestions(PARENT)
    expect(stored).toHaveLength(1)
    expect(stored[0]!.id).toBe(thread.id)
    expect(stored[0]!.threadSessionId).toBe(thread.threadSessionId)
    expect(stored[0]!.title).toBe('FIFO')
    expect(stored[0]!.answer).toBeUndefined()
  })

  it('two concurrent creates never both consume the one standby', async () => {
    await sideThreadManager.ensureStandby(PARENT)
    const [t1, t2] = await Promise.all([
      sideThreadManager.createThread(PARENT, { question: 'q-a' }),
      sideThreadManager.createThread(PARENT, { question: 'q-b' }),
    ])
    // Distinct sessions: exactly ONE consumed the standby (ordinary send),
    // the loser forked fresh (question rides the spawn, no send).
    expect(t1.threadSessionId).not.toBe(t2.threadSessionId)
    expect(mocks.sendMessageToSession).toHaveBeenCalledTimes(1)
    expect(started).toHaveLength(2) // standby fork + the loser's fresh fork
    const stored = await listSideQuestions(PARENT)
    expect(stored.map((e) => e.id).sort()).toEqual([t1.id, t2.id].sort())
  })

  it('rejects an empty question', async () => {
    await expect(sideThreadManager.createThread(PARENT, { question: '  ' }))
      .rejects.toMatchObject({ statusCode: 400 })
  })

  it('terminates the least-recently-active thread past the live cap', async () => {
    const ids: string[] = []
    for (let i = 0; i < 3; i++) {
      vi.setSystemTime(new Date(`2026-08-31T10:0${i}:00.000Z`))
      ids.push((await sideThreadManager.createThread(PARENT, { question: `q${i}` })).threadSessionId)
      await settle()
    }
    expect(mocks.terminateSession).not.toHaveBeenCalled()

    vi.setSystemTime(new Date('2026-08-31T10:05:00.000Z'))
    await sideThreadManager.createThread(PARENT, { question: 'q4' })
    // Cap enforcement is deliberately background (never in the ask path).
    await settle()

    // Oldest one evicted — and only its PROCESS: the record stays resumable.
    expect(mocks.terminateSession).toHaveBeenCalledTimes(1)
    expect(mocks.terminateSession).toHaveBeenCalledWith(ids[0], { force: true })
    expect(mocks.markExpectedTeardown).toHaveBeenCalledWith(ids[0], 'side_thread_live_cap')
    expect((await getSessionByClaudeId(ids[0]!))?.archived).toBeFalsy()
  })
})

describe('retire + list', () => {
  it('retireThread terminates, archives and forgets', async () => {
    const thread = await sideThreadManager.createThread(PARENT, { question: 'q' })
    await settle()
    await sideThreadManager.retireThread(PARENT, thread.id)

    expect(mocks.terminateSession).toHaveBeenCalledWith(thread.threadSessionId, { force: true })
    expect((await getSessionByClaudeId(thread.threadSessionId))?.archived).toBe(true)
    expect(await listSideQuestions(PARENT)).toHaveLength(0)
  })

  it('404s an unknown thread', async () => {
    await expect(sideThreadManager.retireThread(PARENT, 'sth-nope'))
      .rejects.toMatchObject({ statusCode: 404 })
  })

  it('listThreads splits threads from legacy Q&As and flags archived', async () => {
    const { addSideQuestion } = await import('../../src/core/side-questions.js')
    await addSideQuestion(PARENT, 'legacy q', 'legacy a')
    const thread = await sideThreadManager.createThread(PARENT, { question: 'thread q' })
    await settle()

    let view = await sideThreadManager.listThreads(PARENT)
    expect(view.legacy.map((e) => e.question)).toEqual(['legacy q'])
    expect(view.threads).toHaveLength(1)
    expect(view.threads[0]!.archived).toBe(false)

    await updateSessionRecord(thread.threadSessionId, { archived: true })
    view = await sideThreadManager.listThreads(PARENT)
    expect(view.threads[0]!.archived).toBe(true)
  })
})

describe('sweeps', () => {
  it('archives standbys orphaned by a previous process at boot', async () => {
    const orphan = await sideThreadManager.ensureStandby(PARENT)
    // Simulate a restart: the TTL timer lived in the dead process's memory.
    sideThreadManager.stop()
    sideThreadManager.start()
    await settle()

    expect(mocks.terminateSession).toHaveBeenCalledWith(orphan, { force: true })
    const record = await getSessionByClaudeId(orphan!)
    expect(record?.archived).toBe(true)
    expect(record?.archive_reason).toBe('side_thread_standby_orphan')
  })

  it('terminates (never archives) a thread idle past 30 minutes', async () => {
    const thread = await sideThreadManager.createThread(PARENT, { question: 'q' })
    await settle()
    sideThreadManager.start()

    vi.setSystemTime(new Date('2026-08-31T11:00:00.000Z'))
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    await settle()

    expect(mocks.markExpectedTeardown).toHaveBeenCalledWith(thread.threadSessionId, 'side_thread_idle')
    expect(mocks.terminateSession).toHaveBeenCalledWith(thread.threadSessionId, { force: true })
    expect((await getSessionByClaudeId(thread.threadSessionId))?.archived).toBeFalsy()
  })
})
