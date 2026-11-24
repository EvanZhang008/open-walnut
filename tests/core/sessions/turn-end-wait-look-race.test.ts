/**
 * A turn's end that comes while a look still reads is not lost to the poll
 * (src/core/sessions/turn-end-wait.ts).
 *
 * 2026-11-24: the first look of a wait loads the retry rows (turn-run.ts), about a second on a
 * busy machine. The session's turn ended meanwhile; the status event's settled look found the
 * first look still reading and stepped aside, and the first look, holding the record read
 * before the change ('running'), answered 'wait' and replaced every timer with the 30 s poll.
 * A self-completed session's stop came a poll late (task-complete-stop-restart.test.ts failed
 * on a slower host). Both doors in (the event and a settled look) now leave a mark the reading
 * look honours when it is done.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { rec, firstRead } = vi.hoisted(() => {
  let release: () => void = () => {}
  const gate = new Promise<void>((r) => { release = r })
  return {
    rec: { claudeSessionId: 'race', process_status: 'running' as string },
    firstRead: { gate, release: () => release(), calls: 0 },
  }
})

vi.mock('../../../src/core/session-tracker.js', () => ({
  getSessionByClaudeId: async () => ({ ...rec }),
}))
vi.mock('../../../src/core/sessions/turn-run.js', () => ({
  // The first look's read is slow (the rows load); later ones answer at once.
  turnMidWork: async () => {
    if (firstRead.calls++ === 0) await firstRead.gate
    return null
  },
}))
vi.mock('../../../src/providers/claude-code-session.js', () => ({
  sessionRunner: { isInTurn: () => undefined, hasWorkOutlivingTurn: () => false },
}))

import { bus, EventNames } from '../../../src/core/event-bus.js'
import { TurnEndWait } from '../../../src/core/sessions/turn-end-wait.js'

const LIMITS = { backgroundGraceMs: 60 * 60_000, maxMs: 60 * 60_000 }
let waiter: TurnEndWait<{ since: number }>
let acted: string[]

beforeEach(() => {
  acted = []
  rec.process_status = 'running'
  firstRead.calls = 0
  waiter = new TurnEndWait<{ since: number }>({
    name: 'look-race-test',
    limits: LIMITS,
    queue: false,
    settleMs: 0,
    asked: async (_sid, data) => ({ askedAt: data.since }),
    act: async (sid, _data, verdict) => { acted.push(`${sid}:${verdict}`) },
  })
  // A poll far past the test's wait: only the status change can end it in time.
  waiter.setClockForTest({ limits: LIMITS, pollMs: 10 * 60_000 })
})

afterEach(() => {
  waiter.clear()
  bus.unsubscribe('look-race-test')
})

describe('a turn end during a look that still reads', () => {
  it('acts after the settle, not a poll later', async () => {
    waiter.watch('race', { since: Date.now() })
    await vi.waitFor(() => expect(firstRead.calls).toBe(1))

    // The turn ends while the first look still reads the record it got before the change.
    rec.process_status = 'idle'
    bus.emit(EventNames.SESSION_STATUS_CHANGED, { sessionId: 'race', process_status: 'idle' }, ['*'], { source: 'session-runner' })
    firstRead.release()

    await vi.waitFor(() => expect(acted).toEqual(['race:run']), { timeout: 5_000 })
    expect(waiter.has('race')).toBe(false)
  })
})
