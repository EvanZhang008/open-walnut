/**
 * Rhythm focus blocks: the focus → break → long break cycle and the quiet hold union (pure).
 */
import { describe, expect, it } from 'vitest'
import {
  advanceFocus, BREAK_DUE_EXPIRY_MS, CYCLE_RESET_MS, desiredHold, focusOnBoot, IDLE_FOCUS,
  sameHold, skipBreak, startBreak, startFocus, stopFocus, type FocusDurations, type FocusState,
} from '../../../plugin-store/walnut-rhythm/src/server/focus'

const MIN = 60_000
const T0 = Date.UTC(2026, 8, 25, 16, 0)
const D: FocusDurations = { focusMinutes: 25, breakMinutes: 5, longBreakMinutes: 15, longBreakEvery: 4, standBreakMinutes: 10 }

/** Run one block to its end at `start + minutes` and return the state and the event. */
function completeBlock(state: FocusState, start: number, minutes = 25) {
  const running = startFocus(state, { now: start, minutes, taskId: 'task-1', title: 'Write the report' })
  return advanceFocus(running, start + minutes * MIN, D)
}

describe('the focus cycle', () => {
  it('focus → break_due → break → idle, with the block reported once', () => {
    const running = startFocus(IDLE_FOCUS, { now: T0, minutes: 25, taskId: 'task-1', title: 'Write the report' })
    expect(running).toMatchObject({ phase: 'focus', endsAt: T0 + 25 * MIN, completedInCycle: 0 })
    expect(advanceFocus(running, T0 + 24 * MIN, D).events).toEqual([])

    const ended = advanceFocus(running, T0 + 25 * MIN, D)
    expect(ended.events).toEqual([{
      type: 'focus-completed',
      block: { startedAt: T0, endedAt: T0 + 25 * MIN, minutes: 25, taskId: 'task-1', title: 'Write the report' },
      breakKind: 'short',
      lateMs: 0,
    }])
    expect(ended.state).toMatchObject({ phase: 'break_due', breakKind: 'short', completedInCycle: 1 })
    expect(advanceFocus(ended.state, T0 + 26 * MIN, D).events).toEqual([])

    const onBreak = startBreak(ended.state, T0 + 26 * MIN, D)
    expect(onBreak).toMatchObject({ phase: 'break', endsAt: T0 + 31 * MIN })
    const over = advanceFocus(onBreak, T0 + 31 * MIN, D)
    expect(over.events).toEqual([{ type: 'break-ended', breakKind: 'short', lateMs: 0 }])
    expect(over.state).toMatchObject({ phase: 'idle', completedInCycle: 1, taskId: 'task-1', minutes: 25 })
  })

  it('every fourth block earns the long break, and the cycle starts over after it', () => {
    let state: FocusState = IDLE_FOCUS
    let t = T0
    const kinds: string[] = []
    for (let block = 0; block < 5; block++) {
      const done = completeBlock(state, t)
      const event = done.events[0]
      if (event?.type !== 'focus-completed') throw new Error('expected a completed block')
      kinds.push(event.breakKind)
      t += 25 * MIN
      state = startBreak(done.state, t, D)
      t += (event.breakKind === 'long' ? 15 : 5) * MIN
      expect(state.endsAt).toBe(t)
      state = advanceFocus(state, t, D).state
    }
    expect(kinds).toEqual(['short', 'short', 'short', 'long', 'short'])
    expect(state.completedInCycle).toBe(1)
  })

  it('skipping a break keeps the cycle count; stopping ends the cycle', () => {
    const done = completeBlock(IDLE_FOCUS, T0).state
    const skipped = skipBreak(done, T0 + 26 * MIN)
    expect(skipped).toMatchObject({ phase: 'idle', completedInCycle: 1 })
    const again = startFocus(skipped, { now: T0 + 27 * MIN, minutes: 25 })
    expect(again.completedInCycle).toBe(1)
    const stopped = stopFocus(again, T0 + 37 * MIN)
    expect(stopped.stoppedMinutes).toBe(10)
    expect(stopped.state).toMatchObject({ phase: 'idle', completedInCycle: 0 })
    expect(stopFocus(IDLE_FOCUS, T0).stoppedMinutes).toBeNull()
  })

  it('a break from idle is the stand-up break: its own length, and the cycle count is untouched', () => {
    const idle = { ...IDLE_FOCUS, completedInCycle: 2, lastEndedAt: T0 - 5 * MIN }
    const stand = startBreak(idle, T0, D)
    expect(stand).toMatchObject({ phase: 'break', breakKind: 'stand', startedAt: T0, endsAt: T0 + 10 * MIN, completedInCycle: 2 })
    expect(desiredHold({ focus: stand, focusQuietsWalnut: true, macosFocusName: null })).toBeNull()
    const over = advanceFocus(stand, T0 + 11 * MIN, D)
    expect(over.events).toEqual([{ type: 'break-ended', breakKind: 'stand', lateMs: MIN }])
    expect(over.state).toMatchObject({ phase: 'idle', completedInCycle: 2, lastEndedAt: T0 + 10 * MIN })
    // A restart reads the kind back.
    expect(focusOnBoot(JSON.parse(JSON.stringify(stand)))).toMatchObject({ phase: 'break', breakKind: 'stand' })
  })

  it('refuses a second block while one runs, and a break during a block', () => {
    const running = startFocus(IDLE_FOCUS, { now: T0, minutes: 25 })
    expect(() => startFocus(running, { now: T0 + MIN, minutes: 25 })).toThrow(/already running/)
    expect(() => startBreak(running, T0 + MIN, D)).toThrow(/focus block is running/)
  })

  it('an unanswered block-done prompt lapses, and a long idle spell starts a fresh cycle', () => {
    const done = completeBlock(IDLE_FOCUS, T0).state
    const lapsed = advanceFocus(done, T0 + 25 * MIN + BREAK_DUE_EXPIRY_MS, D)
    expect(lapsed.events).toEqual([{ type: 'break-due-lapsed' }])
    expect(lapsed.state).toMatchObject({ phase: 'idle', completedInCycle: 1 })
    const later = startFocus(lapsed.state, { now: T0 + 25 * MIN + CYCLE_RESET_MS + MIN, minutes: 25 })
    expect(later.completedInCycle).toBe(0)
  })

  it('catches up across a restart that slept through the whole block and its prompt', () => {
    const running = startFocus(IDLE_FOCUS, { now: T0, minutes: 25 })
    const caught = advanceFocus(running, T0 + 3 * 60 * MIN, D)
    expect(caught.events.map((event) => event.type)).toEqual(['focus-completed', 'break-due-lapsed'])
    const first = caught.events[0]
    expect(first?.type === 'focus-completed' && first.lateMs).toBe(3 * 60 * MIN - 25 * MIN)
    expect(caught.state.phase).toBe('idle')
  })

  it('focusOnBoot keeps a valid state and drops junk', () => {
    const running = startFocus(IDLE_FOCUS, { now: T0, minutes: 25, taskId: 't' })
    expect(focusOnBoot(JSON.parse(JSON.stringify(running)))).toEqual(running)
    expect(focusOnBoot({ phase: 'focus', endsAt: 0 })).toMatchObject({ phase: 'idle' })
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
    const done = completeBlock(IDLE_FOCUS, T0).state
    expect(desiredHold({ focus: startBreak(done, T0 + 26 * MIN, D), focusQuietsWalnut: true, macosFocusName: null })).toBeNull()
  })
})
