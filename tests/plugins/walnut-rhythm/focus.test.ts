/**
 * Rhythm's focus run: off → block → break → off, the long break, catching up across a
 * restart, an older version's stored state, and the quiet hold union (pure).
 */
import { describe, expect, it } from 'vitest'
import {
  advanceFocus, CYCLE_RESET_MS, desiredHold, focusOnBoot, IDLE_FOCUS,
  sameHold, skipBreak, startFocus, stopFocus, type FocusDurations, type FocusState,
} from '../../../plugin-store/walnut-rhythm/src/server/focus'

const MIN = 60_000
const T0 = Date.UTC(2026, 8, 25, 16, 0)
const D: FocusDurations = { focusMinutes: 25, breakMinutes: 5, longBreakMinutes: 15, longBreakEvery: 4 }

/** Run one block to its end at `start + minutes` and return the state and the event. */
function completeBlock(state: FocusState, start: number, minutes = 25) {
  const running = startFocus(state, { now: start, minutes, taskId: 'task-1', title: 'Write the report' })
  return advanceFocus(running, start + minutes * MIN, D)
}

describe('the focus run', () => {
  it('off → focus → break (by itself) → off, with the block reported once and the run remembered', () => {
    const { state, events } = completeBlock(IDLE_FOCUS, T0)
    expect(events).toEqual([{
      type: 'focus-completed',
      block: { startedAt: T0, endedAt: T0 + 25 * MIN, minutes: 25, breakMinutes: 0, taskId: 'task-1', title: 'Write the report' },
      breakKind: 'short', breakEndsAt: T0 + 30 * MIN, lateMs: 0,
    }])
    expect(state).toMatchObject({ phase: 'break', breakKind: 'short', startedAt: T0 + 25 * MIN, endsAt: T0 + 30 * MIN, runStartedAt: T0, completedInCycle: 1 })
    expect(advanceFocus(state, T0 + 29 * MIN, D).events).toEqual([])
    const over = advanceFocus(state, T0 + 30 * MIN, D)
    expect(over.events).toEqual([{ type: 'break-ended', breakKind: 'short', lateMs: 0 }])
    expect(over.state).toMatchObject({ phase: 'idle', startedAt: 0, endsAt: 0, runStartedAt: 0, completedInCycle: 1, lastRunStartedAt: T0, lastRunEndedAt: T0 + 30 * MIN, taskId: 'task-1', minutes: 25 })
  })

  it('a block keeps the break picked with it (the long break keeps its own), and its Spotify playlist', () => {
    const uri = 'spotify:playlist:37i9dQZF1DWZeKCadgRdKQ'
    const running = startFocus(IDLE_FOCUS, { now: T0, minutes: 50, breakMinutes: 12, spotifyUri: uri })
    const ended = advanceFocus(running, T0 + 50 * MIN, D)
    expect(ended.events[0]).toMatchObject({ type: 'focus-completed', block: { minutes: 50, breakMinutes: 12, spotifyUri: uri }, breakEndsAt: T0 + 62 * MIN })
    expect(ended.state).toMatchObject({ phase: 'break', endsAt: T0 + 62 * MIN })
    // Off after it, the run still knows its lengths and playlist, so "Start next block" repeats them.
    const off = advanceFocus(ended.state, T0 + 62 * MIN, D).state
    expect(off).toMatchObject({ phase: 'idle', minutes: 50, breakMinutes: 12, spotifyUri: uri })
    // A restart reads all of it back; a malformed playlist is dropped.
    expect(focusOnBoot(JSON.parse(JSON.stringify(running)))).toEqual(running)
    expect(focusOnBoot({ ...running, spotifyUri: 'spotify:playlist:x"; do shell script "y' }).spotifyUri).toBeUndefined()
    // The fourth block's long break is the configured one whatever was picked.
    const fourth = startFocus({ ...IDLE_FOCUS, completedInCycle: 3, lastEndedAt: T0 }, { now: T0 + MIN, minutes: 25, breakMinutes: 12 })
    expect(advanceFocus(fourth, T0 + 26 * MIN, D).state).toMatchObject({ breakKind: 'long', endsAt: T0 + 41 * MIN })
    // A state an older version wrote has no break pick: the configured break.
    const old = focusOnBoot({ phase: 'focus', minutes: 25, startedAt: T0, endsAt: T0 + 25 * MIN, completedInCycle: 0, lastEndedAt: 0 })
    expect(old.breakMinutes).toBe(0)
    expect(advanceFocus(old, T0 + 25 * MIN, D).state.endsAt).toBe(T0 + 30 * MIN)
  })

  it('off never moves by itself, however long the clock runs', () => {
    expect(advanceFocus(IDLE_FOCUS, T0 + 365 * 24 * 60 * MIN, D)).toEqual({ state: IDLE_FOCUS, events: [] })
    const ended = advanceFocus(completeBlock(IDLE_FOCUS, T0).state, T0 + 30 * MIN, D).state
    expect(advanceFocus(ended, T0 + 48 * 60 * MIN, D)).toEqual({ state: ended, events: [] })
  })

  it('every fourth block earns the long break, and the cycle starts over after it', () => {
    let state: FocusState = IDLE_FOCUS
    let t = T0
    for (let block = 1; block <= 4; block++) {
      const done = completeBlock(state, t)
      const event = done.events[0]
      expect(event?.type === 'focus-completed' && event.breakKind).toBe(block === 4 ? 'long' : 'short')
      state = done.state
      t += 25 * MIN
      expect(state.endsAt - state.startedAt).toBe(block === 4 ? 15 * MIN : 5 * MIN)
      state = skipBreak(state, t + MIN)
      t += 2 * MIN
    }
    expect(state.completedInCycle).toBe(0)
  })

  it('ending a break keeps the cycle count; stopping ends the cycle; both remember the run', () => {
    const done = completeBlock(IDLE_FOCUS, T0).state
    const skipped = skipBreak(done, T0 + 27 * MIN)
    expect(skipped).toMatchObject({ phase: 'idle', completedInCycle: 1, lastRunStartedAt: T0, lastRunEndedAt: T0 + 27 * MIN })
    expect(skipBreak(IDLE_FOCUS, T0)).toBe(IDLE_FOCUS)
    const running = startFocus(skipped, { now: T0 + 30 * MIN, minutes: 25 })
    const stopped = stopFocus(running, T0 + 42 * MIN)
    expect(stopped.stoppedMinutes).toBe(12)
    expect(stopped.state).toMatchObject({ phase: 'idle', completedInCycle: 0, lastRunStartedAt: T0 + 30 * MIN, lastRunEndedAt: T0 + 42 * MIN })
    // Stopping while off changes nothing.
    expect(stopFocus(stopped.state, T0 + 50 * MIN)).toEqual({ state: stopped.state, stoppedMinutes: null })
  })

  it('refuses a second block while one runs, and a long idle spell starts a fresh cycle', () => {
    const running = startFocus(IDLE_FOCUS, { now: T0, minutes: 25 })
    expect(() => startFocus(running, { now: T0 + MIN, minutes: 25 })).toThrow(/already running/)
    const ended = skipBreak(completeBlock(IDLE_FOCUS, T0).state, T0 + 26 * MIN)
    expect(startFocus(ended, { now: T0 + 26 * MIN + CYCLE_RESET_MS + 1, minutes: 25 }).completedInCycle).toBe(0)
    expect(startFocus(ended, { now: T0 + 40 * MIN, minutes: 25 }).completedInCycle).toBe(1)
  })

  it('catches up across a restart that slept through the whole block and its break, ending off', () => {
    const running = startFocus(IDLE_FOCUS, { now: T0, minutes: 25 })
    const caught = advanceFocus(running, T0 + 3 * 60 * MIN, D)
    expect(caught.events.map((event) => event.type)).toEqual(['focus-completed', 'break-ended'])
    const first = caught.events[0]
    expect(first?.type === 'focus-completed' && first.lateMs).toBe(3 * 60 * MIN - 25 * MIN)
    expect(caught.state).toMatchObject({ phase: 'idle', lastRunStartedAt: T0, lastRunEndedAt: T0 + 30 * MIN })
  })

  it('reads an older version\'s waiting break as the break it started at the block\'s end', () => {
    const legacy = focusOnBoot({ phase: 'break_due', minutes: 25, startedAt: T0 + 25 * MIN, endsAt: T0 + 55 * MIN, completedInCycle: 1, breakKind: 'short', lastEndedAt: T0 + 25 * MIN })
    const now = advanceFocus(legacy, T0 + 27 * MIN, D)
    expect(now.events).toEqual([])
    // It kept no run start: the block began its length before the break did.
    expect(now.state).toMatchObject({ phase: 'break', startedAt: T0 + 25 * MIN, endsAt: T0 + 30 * MIN, runStartedAt: T0 })
    expect(advanceFocus(legacy, T0 + 31 * MIN, D).state).toMatchObject({ phase: 'idle', lastRunStartedAt: T0, lastRunEndedAt: T0 + 30 * MIN })
    // Its running break gets the same start.
    expect(focusOnBoot({ phase: 'break', minutes: 25, startedAt: T0 + 25 * MIN, endsAt: T0 + 30 * MIN, breakKind: 'short' })).toMatchObject({ phase: 'break', runStartedAt: T0 })
    // Its stand-up break was no run of a block: it boots off, with no last run.
    expect(focusOnBoot({ phase: 'break', minutes: 0, startedAt: T0, endsAt: T0 + 10 * MIN, breakKind: 'stand' })).toMatchObject({ phase: 'idle', endsAt: 0, lastRunStartedAt: 0, lastRunEndedAt: 0 })
  })

  it('Another block during a break records the run it cuts off as the last run', () => {
    const rest = completeBlock(IDLE_FOCUS, T0).state
    const next = startFocus(rest, { now: T0 + 26 * MIN, minutes: 25 })
    expect(next).toMatchObject({ phase: 'focus', runStartedAt: T0 + 26 * MIN, completedInCycle: 1, lastRunStartedAt: T0, lastRunEndedAt: T0 + 26 * MIN })
  })

  it('focusOnBoot keeps a valid state and drops junk', () => {
    const running = startFocus(IDLE_FOCUS, { now: T0, minutes: 25, taskId: 't' })
    expect(focusOnBoot(JSON.parse(JSON.stringify(running)))).toEqual(running)
    expect(focusOnBoot({ phase: 'focus', endsAt: 0 })).toMatchObject({ phase: 'idle' })
    expect(focusOnBoot({ phase: 'idle', startedAt: T0, endsAt: T0 + MIN, runStartedAt: T0 })).toMatchObject({ phase: 'idle', startedAt: 0, endsAt: 0, runStartedAt: 0 })
    expect(focusOnBoot('x')).toEqual(IDLE_FOCUS)
  })
})

describe('the quiet hold union', () => {
  const running = startFocus(IDLE_FOCUS, { now: T0, minutes: 25 })

  it('a focus block alone holds until the block ends', () => {
    expect(desiredHold({ focus: running, focusQuietsWalnut: true, macosFocusName: null }))
      .toEqual({ reason: 'Focus block', until: T0 + 25 * MIN })
    expect(desiredHold({ focus: running, focusQuietsWalnut: false, macosFocusName: null })).toBeNull()
  })

  it('a macOS Focus alone holds with no end', () => {
    expect(desiredHold({ focus: IDLE_FOCUS, focusQuietsWalnut: true, macosFocusName: 'Deep Work' }))
      .toEqual({ reason: 'macOS Focus: Deep Work' })
  })

  it('both at once name both reasons and keep no end time, because macOS decides when it ends', () => {
    const both = desiredHold({ focus: running, focusQuietsWalnut: true, macosFocusName: 'Deep Work' })
    expect(both).toEqual({ reason: 'Focus block, macOS Focus: Deep Work' })
    expect(sameHold(both, { reason: 'Focus block, macOS Focus: Deep Work' })).toBe(true)
    expect(sameHold(both, null)).toBe(false)
    expect(sameHold(null, null)).toBe(true)
  })

  it('a break never holds quiet', () => {
    const rest = completeBlock(IDLE_FOCUS, T0).state
    expect(rest.phase).toBe('break')
    expect(desiredHold({ focus: rest, focusQuietsWalnut: true, macosFocusName: null })).toBeNull()
  })
})
