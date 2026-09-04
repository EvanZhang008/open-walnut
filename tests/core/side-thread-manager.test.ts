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
  // Typed args (unused): the output-mode assertions below read call[1], which a
  // zero-arg vi.fn() would type as never.
  sendMessageToSession: vi.fn(async (
    _sessionId: string, _message: string, _opts?: { source?: string },
  ) => ({ id: 'qm-test' })),
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
import {
  OUTPUT_MODE_INSTRUCTION_MARKER, stripOutputModeWrappers,
} from '../../src/core/sessions/output-mode.js'
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

describe('warmStandby (typing-triggered cache warm-up)', () => {
  it('sends the tagged warm-up ONCE to the standby and extends its TTL', async () => {
    const { CACHE_WARMUP_MESSAGE, consumeWarmupTurn } = await import('../../src/core/sessions/side-thread-warmup.js')
    const standby = await sideThreadManager.ensureStandby(PARENT)

    expect(await sideThreadManager.warmStandby(PARENT)).toEqual({ warmed: true })
    expect(mocks.sendMessageToSession).toHaveBeenCalledTimes(1)
    expect(mocks.sendMessageToSession).toHaveBeenCalledWith(
      standby, CACHE_WARMUP_MESSAGE, { source: 'side-thread-warmup' })
    // The observability sentinel must not file "turn lost" for the hidden reply.
    expect(consumeWarmupTurn(standby!)).toBe(true)

    // A second keystroke burst is a no-op: the cache is already populated.
    expect(await sideThreadManager.warmStandby(PARENT)).toEqual({ warmed: true, reason: 'already_warm' })
    expect(mocks.sendMessageToSession).toHaveBeenCalledTimes(1)

    // Warmed standby outlives the plain 2-min TTL (the user is mid-sentence).
    await vi.advanceTimersByTimeAsync(120_000)
    await settle()
    expect(mocks.terminateSession).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(15 * 60_000)
    await settle()
    expect(mocks.terminateSession).toHaveBeenCalledWith(standby, { force: true })
  })

  it('does nothing without a standby', async () => {
    expect(await sideThreadManager.warmStandby(PARENT)).toEqual({ warmed: false, reason: 'no_standby' })
    expect(mocks.sendMessageToSession).not.toHaveBeenCalled()
    expect(started).toHaveLength(0)
  })

  it('refuses to warm a standby the parent has moved past', async () => {
    await sideThreadManager.ensureStandby(PARENT)
    vi.setSystemTime(new Date('2026-08-31T10:00:05.000Z'))
    await updateSessionRecord(PARENT, { consumedOffset: 4321 })

    expect(await sideThreadManager.warmStandby(PARENT)).toEqual({ warmed: false, reason: 'stale' })
    expect(mocks.sendMessageToSession).not.toHaveBeenCalled()
  })

  it('a consumed warm standby forgets its warmed state so the next one warms again', async () => {
    const first = await sideThreadManager.ensureStandby(PARENT)
    await sideThreadManager.warmStandby(PARENT)
    const thread = await sideThreadManager.createThread(PARENT, { question: 'q' })
    expect(thread.threadSessionId).toBe(first)

    const second = await sideThreadManager.ensureStandby(PARENT)
    expect(second).not.toBe(first)
    expect(await sideThreadManager.warmStandby(PARENT)).toEqual({ warmed: true })
    // warm-up #1, the question, warm-up #2
    expect(mocks.sendMessageToSession).toHaveBeenCalledTimes(3)
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
    const [sentTo, sentText, sentOpts] = mocks.sendMessageToSession.mock.calls.at(-1)!
    expect(sentTo).toBe(standby)
    expect(sentOpts).toEqual({ source: 'side-thread' })
    // The question itself is verbatim; rich mode (the default) rides behind it.
    expect(stripOutputModeWrappers(sentText)).toBe('why hasPipe?')

    await vi.advanceTimersByTimeAsync(120_000)
    await settle()
    expect(mocks.terminateSession).not.toHaveBeenCalled()
  })

  it('forks fresh with the question as the first turn when no standby exists', async () => {
    const thread = await sideThreadManager.createThread(PARENT, { question: 'what broke?' })
    expect(started).toHaveLength(1)
    expect(stripOutputModeWrappers(started[0]!.message)).toBe('what broke?')
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

  it('does NOT consume the standby when the ask picks a different model', async () => {
    const standby = await sideThreadManager.ensureStandby(PARENT)
    const thread = await sideThreadManager.createThread(PARENT, {
      question: 'answer this one cheaply', model: 'haiku-5',
    })

    // --model is a SPAWN argument, so a process prewarmed on the parent's model
    // cannot serve this ask: fork fresh with the override.
    expect(thread.threadSessionId).not.toBe(standby)
    expect(started).toHaveLength(2)
    expect(started[1]!.model).toBe('haiku-5')
    // …and the standby is left ALONE (not retired): it is still exactly right for
    // the next ask that doesn't override anything.
    await settle()
    expect(mocks.terminateSession).not.toHaveBeenCalled()
    const parked = await getSessionByClaudeId(standby!)
    expect(parked?.lane).toBe(`side:${PARENT}:standby`)
    expect(parked?.archived).toBeFalsy()

    const next = await sideThreadManager.createThread(PARENT, { question: 'and now the default' })
    expect(next.threadSessionId).toBe(standby)
    expect(started).toHaveLength(2)
  })

  it('does NOT consume the standby when the ask picks an effort it was not spawned with', async () => {
    const standby = await sideThreadManager.ensureStandby(PARENT)
    const thread = await sideThreadManager.createThread(PARENT, {
      question: 'think harder', effort: 'max',
    })
    expect(thread.threadSessionId).not.toBe(standby)
    expect(started[1]!.effort).toBe('max')
    expect((await getSessionByClaudeId(standby!))?.lane).toBe(`side:${PARENT}:standby`)
  })

  it('still consumes the standby when the ask picks the SAME model', async () => {
    const standby = await sideThreadManager.ensureStandby(PARENT)
    const thread = await sideThreadManager.createThread(PARENT, {
      question: 'same prefix, nothing to re-spawn', model: 'opus[1m]',
    })
    expect(thread.threadSessionId).toBe(standby)
    expect(started).toHaveLength(1)
  })

  it('a SLASH COMMAND first question is never wrapped, and still owes the instruction', async () => {
    // inc-1788194545341: a prefixed/appended slash command stops being a command.
    const thread = await sideThreadManager.createThread(PARENT, { question: '/compact' })
    expect(started[0]!.message).toBe('/compact')
    expect(started[0]!.message).not.toContain(OUTPUT_MODE_INSTRUCTION_MARKER)
    // Edge NOT advanced: the next real message must still carry the instruction.
    expect((await getSessionByClaudeId(thread.threadSessionId))?.output_mode_injected)
      .toBeUndefined()
  })

  it('a consumed standby re-seeds the output mode from the parent\'s CURRENT style', async () => {
    // The standby froze the parent's mode when it forked; the parent switched after.
    const standby = await sideThreadManager.ensureStandby(PARENT)
    await updateSessionRecord(standby!, { output_mode: 'rich' })
    await updateSessionRecord(PARENT, { output_mode: 'markdown' })

    const thread = await sideThreadManager.createThread(PARENT, { question: 'plain, please' })
    expect(thread.threadSessionId).toBe(standby)
    expect((await getSessionByClaudeId(standby!))?.output_mode).toBe('markdown')
    expect(mocks.sendMessageToSession.mock.calls.at(-1)![1]).toBe('plain, please')
  })

  it('a differing OUTPUT MODE still consumes the standby (per-record, not a spawn arg)', async () => {
    const standby = await sideThreadManager.ensureStandby(PARENT)
    const thread = await sideThreadManager.createThread(PARENT, {
      question: 'plain please', outputMode: 'markdown',
    })
    expect(thread.threadSessionId).toBe(standby)
    expect(started).toHaveLength(1)
    expect((await getSessionByClaudeId(standby!))?.output_mode).toBe('markdown')
    // markdown = the model's native style, so nothing is appended.
    expect(mocks.sendMessageToSession.mock.calls.at(-1)![1]).toBe('plain please')
  })

  it('wraps the FIRST question of a FRESH fork while the store keeps the plain text', async () => {
    const thread = await sideThreadManager.createThread(PARENT, { question: 'what broke?' })

    // Rich is the default effective mode, and a brand-new CLI has never been told
    // it — so the question that rides the spawn carries the full instruction.
    const spawned = started[0]!.message
    expect(spawned.startsWith('what broke?')).toBe(true)
    expect(spawned).toContain(OUTPUT_MODE_INSTRUCTION_MARKER)
    expect(stripOutputModeWrappers(spawned)).toBe('what broke?')
    // Edge marker advanced, so the thread's next send doesn't repeat it.
    expect((await getSessionByClaudeId(thread.threadSessionId))?.output_mode_injected).toBe('rich')
    // The stored row is the user's words only (chip label + promoted task read it).
    const stored = await listSideQuestions(PARENT)
    expect(stored[0]!.question).toBe('what broke?')
  })

  it('wraps the FIRST question of a CONSUMED standby and advances its edge', async () => {
    const standby = await sideThreadManager.ensureStandby(PARENT)
    const thread = await sideThreadManager.createThread(PARENT, {
      question: 'why hasPipe?', outputMode: 'rich',
    })
    expect(thread.threadSessionId).toBe(standby)

    const sent = mocks.sendMessageToSession.mock.calls.at(-1)![1]
    expect(sent.startsWith('why hasPipe?')).toBe(true)
    expect(sent).toContain(OUTPUT_MODE_INSTRUCTION_MARKER)
    const record = await getSessionByClaudeId(standby!)
    expect(record?.output_mode).toBe('rich')
    expect(record?.output_mode_injected).toBe('rich')
    expect((await listSideQuestions(PARENT))[0]!.question).toBe('why hasPipe?')
  })

  it('keeps the image preamble first and the mode wrapper last', async () => {
    await sideThreadManager.createThread(PARENT, {
      question: 'what is wrong here?', imageContext: 'Read this file: /tmp/shot.png',
    })
    const spawned = started[0]!.message
    expect(spawned.startsWith('Read this file: /tmp/shot.png')).toBe(true)
    expect(stripOutputModeWrappers(spawned).endsWith('what is wrong here?')).toBe(true)
  })

  it('never wraps the warm-up send nor lets it advance the output-mode edge', async () => {
    const { CACHE_WARMUP_MESSAGE } = await import('../../src/core/sessions/side-thread-warmup.js')
    const standby = await sideThreadManager.ensureStandby(PARENT)
    await sideThreadManager.warmStandby(PARENT)

    expect(mocks.sendMessageToSession).toHaveBeenCalledWith(
      standby, CACHE_WARMUP_MESSAGE, { source: 'side-thread-warmup' })
    expect((await getSessionByClaudeId(standby!))?.output_mode_injected).toBeUndefined()

    // …which is the point: the real question that follows still owes the full
    // instruction (spending the edge on a hidden turn would lose it).
    const thread = await sideThreadManager.createThread(PARENT, { question: 'now the real one' })
    expect(mocks.sendMessageToSession.mock.calls.at(-1)![1]).toContain(OUTPUT_MODE_INSTRUCTION_MARKER)
    expect((await getSessionByClaudeId(thread.threadSessionId))?.output_mode_injected).toBe('rich')
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

describe('requestDigest', () => {
  it('sends the tagged digest RAW to the thread and returns its session id', async () => {
    const { SIDE_THREAD_DIGEST_MESSAGE } = await import('../../src/core/sessions/side-thread-digest.js')
    const thread = await sideThreadManager.createThread(PARENT, { question: 'why hasPipe?' })
    await settle()
    mocks.sendMessageToSession.mockClear()

    const res = await sideThreadManager.requestDigest(PARENT, thread.id)
    expect(res).toEqual({ threadSessionId: thread.threadSessionId })
    expect(mocks.sendMessageToSession).toHaveBeenCalledWith(
      thread.threadSessionId, SIDE_THREAD_DIGEST_MESSAGE, { source: 'side-thread-digest' })
    // RAW: a machine turn must not carry the output-mode instruction (the digest
    // asks for plain text — its destination is a composer, not a bubble).
    const [, sentText] = mocks.sendMessageToSession.mock.calls.at(-1)!
    expect(sentText).not.toContain(OUTPUT_MODE_INSTRUCTION_MARKER)
  })

  it('404s an unknown thread', async () => {
    await expect(sideThreadManager.requestDigest(PARENT, 'sth-nope'))
      .rejects.toMatchObject({ statusCode: 404 })
  })

  /** Every refusal below must ALSO not send. Asserted as "no digest text was sent",
   *  never with `toContain(expect.stringContaining(...))` — vitest compares array
   *  members by identity there, so an asymmetric matcher can never match and the
   *  negation passes no matter what was sent. */
  const SIDE_THREAD_DIGEST_TAG = '<walnut-side-thread-digest>'
  const noDigestSent = () => expect(
    mocks.sendMessageToSession.mock.calls.some((c) => String(c[1]).includes(SIDE_THREAD_DIGEST_TAG)),
  ).toBe(false)

  it('409s an archived thread rather than cold-resuming one for a summary', async () => {
    const thread = await sideThreadManager.createThread(PARENT, { question: 'q' })
    await settle()
    await updateSessionRecord(thread.threadSessionId, { archived: true })

    await expect(sideThreadManager.requestDigest(PARENT, thread.id))
      .rejects.toMatchObject({ statusCode: 409 })
    noDigestSent()
  })

  /** The state the reapers in THIS class actually produce: the live-cap eviction and
   *  the 30-minute idle sweep both terminate WITHOUT archiving. An hour-old aside is
   *  exactly what a summary is for, so this is the common case, not an edge one. */
  it('409s a thread whose process was reaped but not archived', async () => {
    const thread = await sideThreadManager.createThread(PARENT, { question: 'q' })
    await settle()
    await updateSessionRecord(thread.threadSessionId, { process_status: 'stopped' })
    mocks.sendMessageToSession.mockClear()

    await expect(sideThreadManager.requestDigest(PARENT, thread.id))
      .rejects.toMatchObject({ statusCode: 409 })
    noDigestSent()
  })

  it('409s a thread waiting on a permission prompt instead of auto-denying it', async () => {
    const thread = await sideThreadManager.createThread(PARENT, { question: 'q' })
    await settle()
    await updateSessionRecord(thread.threadSessionId, {
      process_status: 'idle',
      pendingPermission: { tool: 'Bash', requestId: 'perm-1', requestedAt: new Date().toISOString() },
    })
    mocks.sendMessageToSession.mockClear()

    await expect(sideThreadManager.requestDigest(PARENT, thread.id))
      .rejects.toMatchObject({ statusCode: 409 })
    noDigestSent()
  })

  it('409s mid-turn (the caller cannot tell which reply is the summary)', async () => {
    const thread = await sideThreadManager.createThread(PARENT, { question: 'q' })
    await settle()
    await updateSessionRecord(thread.threadSessionId, { process_status: 'running' })
    mocks.sendMessageToSession.mockClear()

    await expect(sideThreadManager.requestDigest(PARENT, thread.id))
      .rejects.toMatchObject({ statusCode: 409 })
    noDigestSent()
  })

  /** A promoted thread is a real task session: no side-thread lane, so a turn on it
   *  runs the task machinery (phase → NEED_ACTION, session hooks, the triage's own
   *  extra model call rewriting the task note). Never for a plumbing summary. */
  it('409s a promoted thread', async () => {
    const thread = await sideThreadManager.createThread(PARENT, { question: 'q' })
    await settle()
    const { markThreadPromoted } = await import('../../src/core/side-questions.js')
    await markThreadPromoted(PARENT, thread.id, 'task-1')
    mocks.sendMessageToSession.mockClear()

    await expect(sideThreadManager.requestDigest(PARENT, thread.id))
      .rejects.toMatchObject({ statusCode: 409 })
    noDigestSent()
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

  /** The × in the drawer. The whole point is that the ENTRY survives: an aside is
   *  often the only place a decision was reasoned out. */
  it('archiveThread keeps the entry, stamps it, and retires only the process', async () => {
    const thread = await sideThreadManager.createThread(PARENT, { question: 'q' })
    await settle()
    const { archivedAt } = await sideThreadManager.archiveThread(PARENT, thread.id)

    expect(archivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(mocks.terminateSession).toHaveBeenCalledWith(thread.threadSessionId, { force: true })
    const entries = await listSideQuestions(PARENT)
    expect(entries).toHaveLength(1)
    expect(entries[0]!.archivedAt).toBe(archivedAt)
    // Still addressable: question + thread session id untouched, so the transcript
    // (and therefore "inject full") keeps working.
    expect(entries[0]!.question).toBe('q')
    expect(entries[0]!.threadSessionId).toBe(thread.threadSessionId)
    const view = await sideThreadManager.listThreads(PARENT)
    expect(view.threads[0]!.archivedAt).toBe(archivedAt)
  })

  it('archiveThread is idempotent — the first stamp is when you filed it', async () => {
    const thread = await sideThreadManager.createThread(PARENT, { question: 'q' })
    await settle()
    const first = await sideThreadManager.archiveThread(PARENT, thread.id)
    const second = await sideThreadManager.archiveThread(PARENT, thread.id)
    expect(second.archivedAt).toBe(first.archivedAt)
  })

  it('archiveThread leaves a PROMOTED thread session alone (it belongs to its task)', async () => {
    const thread = await sideThreadManager.createThread(PARENT, { question: 'q' })
    await settle()
    const { markThreadPromoted } = await import('../../src/core/side-questions.js')
    await markThreadPromoted(PARENT, thread.id, 'task-1')
    mocks.terminateSession.mockClear()

    await sideThreadManager.archiveThread(PARENT, thread.id)
    expect(mocks.terminateSession).not.toHaveBeenCalled()
    expect((await getSessionByClaudeId(thread.threadSessionId))?.archived).toBeFalsy()
    expect((await listSideQuestions(PARENT))[0]!.archivedAt).toBeTruthy()
  })

  /** Restore has to make the aside USABLE again, not merely visible: the record
   *  un-archives so the composer unlocks and the next follow-up cold-resumes it. */
  it('restoreThread clears the stamp and un-archives the record', async () => {
    const thread = await sideThreadManager.createThread(PARENT, { question: 'q' })
    await settle()
    await sideThreadManager.archiveThread(PARENT, thread.id)
    expect((await getSessionByClaudeId(thread.threadSessionId))?.archived).toBe(true)

    await sideThreadManager.restoreThread(PARENT, thread.id)
    expect((await listSideQuestions(PARENT))[0]!.archivedAt).toBeUndefined()
    expect((await getSessionByClaudeId(thread.threadSessionId))?.archived).toBe(false)
  })

  /** Filing must stay UNDOABLE. A fork whose CLI never wrote a transcript cannot be
   *  cold-resumed, so killing it strands it — the same reason the idle sweep refuses
   *  to. Hitting × on the aside you just started is exactly when this happens. */
  it('archiveThread files the row but does NOT kill a thread that has no transcript yet', async () => {
    const thread = await sideThreadManager.createThread(PARENT, { question: 'q' })
    await settle()
    // Never-turned: no outputFile, no consumedOffset, process still live.
    await updateSessionRecord(thread.threadSessionId, { outputFile: '', process_status: 'running' })
    mocks.terminateSession.mockClear()

    const { archivedAt } = await sideThreadManager.archiveThread(PARENT, thread.id)
    expect(archivedAt).toBeTruthy()
    expect(mocks.terminateSession).not.toHaveBeenCalled()
    // Record stays live, so restore + follow-up has something to resume; the sweep
    // still owns this process (it is not archived, so threadRecords sees it).
    expect((await getSessionByClaudeId(thread.threadSessionId))?.archived).toBeFalsy()
    expect((await listSideQuestions(PARENT))[0]!.archivedAt).toBe(archivedAt)
  })

  /** A promote landing INSIDE archive's ~8s terminate used to lose: our
   *  `archived: true` overwrote the promote's `archived: false`, handing the new task
   *  a session it can never work. Promote runs outside this manager's queue, so the
   *  window is real — the fix re-reads the row afterwards and undoes the archive. */
  it('archiveThread un-archives the record when a promote lands mid-terminate', async () => {
    const thread = await sideThreadManager.createThread(PARENT, { question: 'q' })
    await settle()
    const { markThreadPromoted } = await import('../../src/core/side-questions.js')
    mocks.terminateSession.mockClear()
    mocks.terminateSession.mockImplementation(async () => {
      // The interleave: promote stamps the row and un-archives the record while our
      // terminate is still running.
      await markThreadPromoted(PARENT, thread.id, 'task-9')
      await updateSessionRecord(thread.threadSessionId, { taskId: 'task-9', archived: false })
    })

    await sideThreadManager.archiveThread(PARENT, thread.id)
    expect(mocks.terminateSession).toHaveBeenCalledTimes(1)
    const record = await getSessionByClaudeId(thread.threadSessionId)
    expect(record?.archived).toBeFalsy()
    expect(record?.taskId).toBe('task-9')
    // The row is still filed — the user did ask for that; only the dead-session part
    // of it is undone.
    expect((await listSideQuestions(PARENT))[0]!.archivedAt).toBeTruthy()
  })

  /** Filing an aside must not make the NEXT ask wait. The terminate is a daemon RPC
   *  bounded at 8s and `createThread`/`ensureStandby` share this parent's queue, so
   *  holding it for the kill is felt as "I filed one and the new question hung". Only
   *  the stamp is serialized; the promote race is closed by the re-read, not the lock. */
  it('archiveThread does not hold the parent queue while the process is terminating', async () => {
    const a = await sideThreadManager.createThread(PARENT, { question: 'a' })
    await settle()
    const b = await sideThreadManager.createThread(PARENT, { question: 'b' })
    await settle()

    let releaseKill: () => void = () => {}
    const killStarted = new Promise<void>((resolveStarted) => {
      mocks.terminateSession.mockImplementationOnce(async () => {
        resolveStarted()
        await new Promise<void>((r) => { releaseKill = r })
      })
    })

    const filing = sideThreadManager.archiveThread(PARENT, a.id)
    await killStarted

    // Another queued op on the SAME parent completes while the kill is still pending.
    // Raced against a timer so a regression fails as an assertion, not as a 5s hang.
    const queued = sideThreadManager.restoreThread(PARENT, b.id).then(() => 'ran' as const)
    const winner = await Promise.race([
      queued,
      new Promise<'blocked'>((r) => setTimeout(() => r('blocked'), 300)),
    ])
    expect(winner).toBe('ran')

    releaseKill()
    await Promise.all([filing, queued])
    expect((await listSideQuestions(PARENT)).find((q) => q.id === a.id)?.archivedAt).toBeTruthy()
  })

  it('restoreThread reports the SESSION state it actually achieved', async () => {
    const thread = await sideThreadManager.createThread(PARENT, { question: 'q' })
    await settle()
    await sideThreadManager.archiveThread(PARENT, thread.id)
    const { recordArchived } = await sideThreadManager.restoreThread(PARENT, thread.id)
    // A rubber-stamped `false` would let the drawer unlock a composer whose send the
    // server refuses; this is read back from the record.
    expect(recordArchived).toBe(false)
  })

  it('404s archive/restore for an unknown thread', async () => {
    await expect(sideThreadManager.archiveThread(PARENT, 'sth-nope'))
      .rejects.toMatchObject({ statusCode: 404 })
    await expect(sideThreadManager.restoreThread(PARENT, 'sth-nope'))
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
