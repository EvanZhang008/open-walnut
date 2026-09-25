/**
 * Rhythm scheduler: when the stand-up reminder is due, paused, deferred or fired (pure).
 */
import { describe, expect, it } from 'vitest'
import type { PresenceState } from '../../../plugin-store/walnut-rhythm/src/server/presence'
import {
  EMPTY_REMINDER, evaluateReminder, pushBackReminder, reminderOnBoot, snoozeReminder,
  type ReminderState, type SchedulerInput,
} from '../../../plugin-store/walnut-rhythm/src/server/scheduler'

const MIN = 60_000
const T0 = Date.UTC(2026, 8, 25, 16, 0)

function input(presence: PresenceState, now: number, extra: Partial<SchedulerInput> = {}): SchedulerInput {
  return {
    now,
    presence,
    intervalMs: 60 * MIN,
    awayMs: 5 * MIN,
    deferCapMs: 5 * MIN,
    focusActive: false,
    inQuietHours: false,
    quietActive: false,
    turnsInFlight: 0,
    lastTurnEndedAt: 0,
    ...extra,
  }
}

/** Sitting since T0, last attention at `minutes`, evaluated right then. */
function sat(minutes: number): PresenceState {
  return { streakStartedAt: T0, lastActiveAt: T0 + minutes * MIN }
}

describe('evaluateReminder', () => {
  it('counts until the streak reaches the interval, then fires once and re-arms an interval out', () => {
    const early = evaluateReminder(EMPTY_REMINDER, input(sat(59), T0 + 59 * MIN))
    expect(early.fire).toBe(false)
    expect(early.view).toMatchObject({ phase: 'counting', dueAt: T0 + 60 * MIN, sittingMs: 59 * MIN })

    const due = evaluateReminder(early.state, input(sat(60), T0 + 60 * MIN))
    expect(due.fire).toBe(true)
    expect(due.state).toMatchObject({ outstanding: true, nextDueAt: T0 + 120 * MIN, firedAt: T0 + 60 * MIN })

    // The next ticks do not re-fire.
    const again = evaluateReminder(due.state, input(sat(61), T0 + 61 * MIN))
    expect(again.fire).toBe(false)
    expect(again.view.phase).toBe('counting')
    // Ignored and still sitting: it comes back one interval later.
    expect(evaluateReminder(again.state, input(sat(120), T0 + 120 * MIN)).fire).toBe(true)
  })

  it('is due on attention, not the wall clock: someone who stood up at 58 is not reminded at 60', () => {
    const left = evaluateReminder(EMPTY_REMINDER, input(sat(58), T0 + 62 * MIN))
    expect(left.fire).toBe(false)
    expect(left.view.phase).toBe('counting')
    expect(evaluateReminder(EMPTY_REMINDER, input(sat(58), T0 + 63 * MIN)).view.phase).toBe('away')
  })

  it('a new streak resets a pending reminder state', () => {
    const fired = evaluateReminder(EMPTY_REMINDER, input(sat(60), T0 + 60 * MIN)).state
    const fresh = { streakStartedAt: T0 + 70 * MIN, lastActiveAt: T0 + 71 * MIN }
    const next = evaluateReminder(fired, input(fresh, T0 + 71 * MIN))
    expect(next.state).toMatchObject({ streakKey: T0 + 70 * MIN, nextDueAt: null, outstanding: false })
    expect(next.view.dueAt).toBe(T0 + 130 * MIN)
  })

  it('pauses for a focus block, quiet hours and quiet mode, and fires once they lift', () => {
    const now = T0 + 65 * MIN
    expect(evaluateReminder(EMPTY_REMINDER, input(sat(65), now, { focusActive: true })).view).toMatchObject({ phase: 'paused', pausedBy: 'focus' })
    expect(evaluateReminder(EMPTY_REMINDER, input(sat(65), now, { inQuietHours: true })).view).toMatchObject({ phase: 'paused', pausedBy: 'quiet_hours' })
    const quiet = evaluateReminder(EMPTY_REMINDER, input(sat(65), now, { quietActive: true }))
    expect(quiet).toMatchObject({ fire: false, view: { phase: 'paused', pausedBy: 'quiet' } })
    expect(evaluateReminder(quiet.state, input(sat(66), now + MIN)).fire).toBe(true)
  })

  it('waits for the natural pause of an agent turn, and fires the moment the turn ends', () => {
    const now = T0 + 60 * MIN
    const waiting = evaluateReminder(EMPTY_REMINDER, input(sat(60), now, { turnsInFlight: 1 }))
    expect(waiting).toMatchObject({ fire: false, view: { phase: 'deferred' }, state: { deferStartedAt: now } })
    const still = evaluateReminder(waiting.state, input(sat(61), now + MIN, { turnsInFlight: 1 }))
    expect(still.fire).toBe(false)
    expect(still.state.deferStartedAt).toBe(now)
    // Another session is still running, but THIS pause arrived: fire now.
    const paused = evaluateReminder(still.state, input(sat(62), now + 2 * MIN, { turnsInFlight: 1, lastTurnEndedAt: now + 2 * MIN }))
    expect(paused.fire).toBe(true)
    expect(paused.state.deferStartedAt).toBeNull()
  })

  it('caps the wait at the defer limit, and never waits when the cap is 0', () => {
    const now = T0 + 60 * MIN
    const waiting = evaluateReminder(EMPTY_REMINDER, input(sat(60), now, { turnsInFlight: 2 }))
    expect(evaluateReminder(waiting.state, input(sat(64), now + 4 * MIN, { turnsInFlight: 2 })).fire).toBe(false)
    expect(evaluateReminder(waiting.state, input(sat(65), now + 5 * MIN, { turnsInFlight: 2 })).fire).toBe(true)
    expect(evaluateReminder(EMPTY_REMINDER, input(sat(60), now, { turnsInFlight: 1, deferCapMs: 0 })).fire).toBe(true)
  })

  it('a pause that ended before the wait began does not count', () => {
    const now = T0 + 60 * MIN
    const waiting = evaluateReminder(EMPTY_REMINDER, input(sat(60), now, { turnsInFlight: 1, lastTurnEndedAt: now - MIN }))
    expect(waiting.fire).toBe(false)
    expect(evaluateReminder(waiting.state, input(sat(61), now + MIN, { turnsInFlight: 1, lastTurnEndedAt: now - MIN })).fire).toBe(false)
  })
})

describe('snooze and push back', () => {
  it('snooze brings the reminder back after the snooze length of attention', () => {
    const fired = evaluateReminder(EMPTY_REMINDER, input(sat(60), T0 + 60 * MIN)).state
    const snoozed = snoozeReminder(fired, T0 + 61 * MIN, 10)
    expect(snoozed).toMatchObject({ nextDueAt: T0 + 71 * MIN, snoozedUntil: T0 + 71 * MIN, outstanding: false })
    const during = evaluateReminder(snoozed, input(sat(70), T0 + 70 * MIN))
    expect(during).toMatchObject({ fire: false, view: { phase: 'snoozed' } })
    expect(evaluateReminder(during.state, input(sat(71), T0 + 71 * MIN)).fire).toBe(true)
  })

  it('pushBackReminder moves the next one a full interval out', () => {
    const base: ReminderState = { ...EMPTY_REMINDER, streakKey: T0 }
    const pushed = pushBackReminder(base, T0 + 55 * MIN, 60 * MIN)
    expect(evaluateReminder(pushed, input(sat(65), T0 + 65 * MIN)).fire).toBe(false)
    expect(evaluateReminder(pushed, input(sat(115), T0 + 115 * MIN)).fire).toBe(true)
  })

  it('reminderOnBoot keeps the due time and drops the in-memory wait', () => {
    const stored = { streakKey: T0, nextDueAt: T0 + 5, snoozedUntil: null, deferStartedAt: T0, outstanding: true, firedAt: 3 }
    expect(reminderOnBoot(stored)).toEqual({ ...stored, deferStartedAt: null })
    expect(reminderOnBoot('junk')).toEqual(EMPTY_REMINDER)
  })
})
