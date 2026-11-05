/**
 * watchedDeadline (src/providers/daemon-connection.ts), the clock of every liveness check, on a
 * loop driven by hand: timers, then the poll phase (where an answer that already came in is read),
 * then immediates. Review 4: a hold that ended less than 500 ms past the deadline got no extra
 * watch and closed a healthy link, and judging inside the timer (no setImmediate) failed no test.
 *
 * MACHINE SAFETY: no timer, socket or process; the clock is this test's own.
 */
import { describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-watched-deadline'))

import { watchedDeadline, type DeadlineClock } from '../../src/providers/daemon-connection.js'

/** A loop whose clock and phases the test moves. */
function handLoop() {
  let now = 0
  let timers: Array<{ at: number; fn: () => void; id: number }> = []
  let immediates: Array<() => void> = []
  let seq = 0
  const clock: DeadlineClock = {
    now: () => now,
    setTimeout: (fn, ms) => { const id = ++seq; timers.push({ at: now + ms, fn, id }); return id },
    clearTimeout: (id) => { timers = timers.filter((t) => t.id !== id) },
    setImmediate: (fn) => { immediates.push(fn) },
  }
  /** One loop turn at `at`: due timers, then `poll` (what the sockets bring), then immediates. */
  const turn = (at: number, poll: () => void = () => {}) => {
    now = at
    const due = timers.filter((t) => t.at <= now)
    timers = timers.filter((t) => t.at > now)
    for (const t of due) t.fn()
    poll()
    const run = immediates
    immediates = []
    for (const fn of run) fn()
  }
  return { clock, turn, pending: () => timers.length + immediates.length }
}

function watch(ms: number, answered: () => boolean, clock: DeadlineClock) {
  const out: { verdict?: boolean | null; extended?: boolean } = {}
  watchedDeadline(ms, () => (answered() ? true : null), (verdict, extended) => { out.verdict = verdict; out.extended = extended }, clock)
  return out
}

describe('the clock of a liveness check', () => {
  it('judges after the loop read what had come in: a pong read in the poll phase after an on-time timer is the answer', () => {
    const loop = handLoop()
    let answered = false
    const out = watch(3_000, () => answered, loop.clock)
    loop.turn(3_000, () => { answered = true })
    // Judged inside the timer instead, this would be silent: the pong was read after it.
    expect(out).toEqual({ verdict: true, extended: false })
  })

  it('a timer that fired late at all gives the wire that lateness again, once (review 4: 300 ms late closed a healthy link)', () => {
    const loop = handLoop()
    let answered = false
    const out = watch(3_000, () => answered, loop.clock)
    loop.turn(3_300) // held 300 ms past the deadline; the far side, held too, has not answered yet
    expect(out.verdict).toBeUndefined()
    loop.turn(3_400, () => { answered = true })
    loop.turn(3_600)
    expect(out).toEqual({ verdict: true, extended: true })
  })

  it('the extra watch is the lateness, at most a second, and only once: no answer is silent then', () => {
    const loop = handLoop()
    const out = watch(3_000, () => false, loop.clock)
    loop.turn(9_000) // 6 s late
    expect(out.verdict).toBeUndefined()
    loop.turn(9_999)
    expect(out.verdict).toBeUndefined()
    loop.turn(10_000)
    expect(out).toEqual({ verdict: null, extended: true })
    expect(loop.pending()).toBe(0)
  })

  it('an on-time timer with nothing read is silent at once', () => {
    const loop = handLoop()
    const out = watch(3_000, () => false, loop.clock)
    loop.turn(3_000)
    expect(out).toEqual({ verdict: null, extended: false })
  })
})
