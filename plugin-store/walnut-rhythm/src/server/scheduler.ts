/**
 * The stand-up reminder as a state machine. PURE: `evaluateReminder` is the whole
 * decision, with the clock, the streak and every pause signal passed in.
 *
 * A reminder is due once the person has been at the keyboard for the interval, and
 * it fires only when nothing better is about to happen:
 *   - a focus block (or its break) is running: the block's own break handles it;
 *   - it is inside quiet hours, or Walnut quiet mode is on;
 *   - an agent turn is in flight: wait for the natural pause when the turn ends, but
 *     never longer than the defer cap.
 *
 * "Due" is measured on ATTENTION, not the wall clock: the latest attention must reach
 * the due time. Someone who stood up at minute 58 is not reminded at minute 60 just
 * because the away threshold has not passed yet.
 *
 * After it fires the next one is an interval away, so an ignored reminder comes back
 * once per interval rather than on every tick. Snooze moves the due time to now plus
 * the snooze. A new streak (the person was away long enough) starts everything over.
 */
import type { PresenceState } from './presence'

export interface ReminderState {
  /** The `streakStartedAt` this state belongs to. A different streak resets it. */
  streakKey: number
  /** Explicit due time after a fire or a snooze; null derives it from the streak. */
  nextDueAt: number | null
  snoozedUntil: number | null
  /** When a due reminder started waiting for an agent turn to finish. */
  deferStartedAt: number | null
  /** A reminder fired and nobody answered it yet. */
  outstanding: boolean
  firedAt: number | null
}

export const EMPTY_REMINDER: ReminderState = {
  streakKey: 0,
  nextDueAt: null,
  snoozedUntil: null,
  deferStartedAt: null,
  outstanding: false,
  firedAt: null,
}

export type PauseReason = 'focus' | 'quiet_hours' | 'quiet'

export type ReminderPhase = 'away' | 'counting' | 'snoozed' | 'deferred' | 'paused' | 'due'

export interface ReminderView {
  phase: ReminderPhase
  pausedBy?: PauseReason
  /** Epoch ms the reminder is due at (by attention), or null while away. */
  dueAt: number | null
  snoozedUntil: number | null
  sittingMs: number
}

export interface SchedulerInput {
  now: number
  presence: PresenceState
  intervalMs: number
  awayMs: number
  deferCapMs: number
  focusActive: boolean
  inQuietHours: boolean
  quietActive: boolean
  turnsInFlight: number
  /** When the latest agent turn finished (the natural pause), epoch ms. 0 = never. */
  lastTurnEndedAt: number
}

export interface Evaluation {
  state: ReminderState
  fire: boolean
  view: ReminderView
}

/** Reset the reminder when the streak it was counting is no longer the current one. */
export function syncStreak(state: ReminderState, presence: PresenceState): ReminderState {
  if (state.streakKey === presence.streakStartedAt) return state
  return { ...EMPTY_REMINDER, streakKey: presence.streakStartedAt }
}

export function evaluateReminder(previous: ReminderState, input: SchedulerInput): Evaluation {
  const { now, presence } = input
  const state = syncStreak(previous, presence)
  const present = presence.streakStartedAt > 0 && now - presence.lastActiveAt < input.awayMs
  if (!present) {
    return {
      state: { ...state, deferStartedAt: null },
      fire: false,
      view: { phase: 'away', dueAt: null, snoozedUntil: state.snoozedUntil, sittingMs: 0 },
    }
  }
  const sittingMs = Math.max(0, presence.lastActiveAt - presence.streakStartedAt)
  const dueAt = state.nextDueAt ?? presence.streakStartedAt + input.intervalMs
  const view = (phase: ReminderPhase, pausedBy?: PauseReason): ReminderView => ({
    phase,
    ...(pausedBy ? { pausedBy } : {}),
    dueAt,
    snoozedUntil: state.snoozedUntil,
    sittingMs,
  })
  const hold = (phase: ReminderPhase, pausedBy?: PauseReason, keepDefer = false): Evaluation => ({
    state: keepDefer ? state : { ...state, deferStartedAt: null },
    fire: false,
    view: view(phase, pausedBy),
  })

  if (presence.lastActiveAt < dueAt) {
    const snoozed = state.snoozedUntil !== null && state.snoozedUntil > now
    return hold(snoozed ? 'snoozed' : 'counting')
  }
  if (input.focusActive) return hold('paused', 'focus')
  if (input.inQuietHours) return hold('paused', 'quiet_hours')
  if (input.quietActive) return hold('paused', 'quiet')

  if (input.turnsInFlight > 0 && input.deferCapMs > 0) {
    const since = state.deferStartedAt ?? now
    const pauseArrived = state.deferStartedAt !== null && input.lastTurnEndedAt >= state.deferStartedAt
    if (!pauseArrived && now - since < input.deferCapMs) {
      return { state: { ...state, deferStartedAt: since }, fire: false, view: view('deferred') }
    }
  }

  return {
    state: {
      ...state,
      nextDueAt: now + input.intervalMs,
      snoozedUntil: null,
      deferStartedAt: null,
      outstanding: true,
      firedAt: now,
    },
    fire: true,
    view: view('due'),
  }
}

/** Snooze: come back after `minutes`, counted like any due time (attention must reach it). */
export function snoozeReminder(state: ReminderState, now: number, minutes: number): ReminderState {
  const until = now + minutes * 60_000
  return { ...state, nextDueAt: until, snoozedUntil: until, deferStartedAt: null, outstanding: false }
}

/** Push the next reminder a full interval out (a focus block just told them to stand). */
export function pushBackReminder(state: ReminderState, now: number, intervalMs: number): ReminderState {
  return { ...state, nextDueAt: now + intervalMs, snoozedUntil: null, deferStartedAt: null, outstanding: false }
}

/** Parse what state.json held; anything malformed falls back to the empty state. */
export function reminderOnBoot(raw: unknown): ReminderState {
  if (!raw || typeof raw !== 'object') return { ...EMPTY_REMINDER }
  const value = raw as Partial<ReminderState>
  const num = (n: unknown): number | null => (typeof n === 'number' && Number.isFinite(n) ? n : null)
  return {
    streakKey: num(value.streakKey) ?? 0,
    nextDueAt: num(value.nextDueAt),
    snoozedUntil: num(value.snoozedUntil),
    // An in-memory wait for a turn does not survive a restart: the turns are gone too.
    deferStartedAt: null,
    outstanding: value.outstanding === true,
    firedAt: num(value.firedAt),
  }
}
