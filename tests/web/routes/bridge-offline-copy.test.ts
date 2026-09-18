/**
 * The shared "the primary box's bridge is not there" copy
 * (src/web/routes/bridge-offline-copy.ts), unit-tested at its own seam.
 *
 * Why this file exists: three /api/v1 relay paths now answer the same outage
 * with this one sentence, so a wording or rounding mistake here is a mistake on
 * the launch route, the control route and every relayed lifecycle call at once.
 *
 * The rounding cases are the point. A user reads "unreachable for 41 minutes"
 * and opens the lid; "unreachable for 2460 seconds" or a plural "1 seconds"
 * reads like a bug, and the singular forms are exactly the ones a wrong
 * threshold makes unreachable (a `<=` in place of a `<` and no duration ever
 * lands on "1 minute" again).
 */
import { describe, it, expect } from 'vitest'
import { bridgeOfflineMessage, humanizeElapsed } from '../../../src/web/routes/bridge-offline-copy.js'

const PLAIN = 'No live bridge to the primary box. Your primary box (Mac) is asleep or offline.'

describe('humanizeElapsed', () => {
  it('says nothing for a duration not worth reporting', () => {
    // Sub-second is noise, and a clock that ran backwards must never produce a
    // negative duration: no answer beats a wrong one.
    expect(humanizeElapsed(0)).toBeNull()
    expect(humanizeElapsed(999)).toBeNull()
    expect(humanizeElapsed(-5_000)).toBeNull()
    expect(humanizeElapsed(Number.NaN)).toBeNull()
    expect(humanizeElapsed(Number.POSITIVE_INFINITY)).toBeNull()
  })

  it('reaches every singular form', () => {
    // Each of these is one threshold slip away from being unreachable.
    expect(humanizeElapsed(1_000)).toBe('1 second')
    expect(humanizeElapsed(60_000)).toBe('1 minute')
    expect(humanizeElapsed(3_600_000)).toBe('1 hour')
  })

  it('pluralizes everything else', () => {
    expect(humanizeElapsed(2_000)).toBe('2 seconds')
    expect(humanizeElapsed(12_000)).toBe('12 seconds')
    expect(humanizeElapsed(59_000)).toBe('59 seconds')
    expect(humanizeElapsed(8 * 60_000)).toBe('8 minutes')
    expect(humanizeElapsed(41 * 60_000)).toBe('41 minutes')
    expect(humanizeElapsed(95 * 60_000)).toBe('2 hours')
    expect(humanizeElapsed(3 * 3_600_000)).toBe('3 hours')
  })

  it('rounds to the coarsest unit a person reads, never raw milliseconds', () => {
    // 61 minutes is an hour to a human, and 90 minutes is 2 hours, not "1.5".
    expect(humanizeElapsed(61 * 60_000)).toBe('1 hour')
    expect(humanizeElapsed(90 * 60_000)).toBe('2 hours')
    for (const ms of [1_400, 45_000, 20 * 60_000, 5 * 3_600_000]) {
      expect(humanizeElapsed(ms)).not.toMatch(/\d{4,}/)
      expect(humanizeElapsed(ms)).not.toMatch(/ms/)
    }
  })
})

describe('bridgeOfflineMessage', () => {
  it('names the outage duration when the loss moment is known', () => {
    expect(bridgeOfflineMessage(Date.now() - 41 * 60_000, 0)).toBe(
      'Your primary box (Mac) has been unreachable for 41 minutes. '
      + 'It may be asleep (open the lid) or offline.',
    )
  })

  it('tells the user what to try, without inventing a number, when it is unknown', () => {
    // A replica that just restarted never saw the link drop and must not guess.
    expect(bridgeOfflineMessage(null, 0)).toBe(PLAIN)
  })

  it('falls back to the plain wording on a nonsense duration', () => {
    // A loss stamped in the future (clock skew between the boxes).
    expect(bridgeOfflineMessage(Date.now() + 5_000, 0)).toBe(PLAIN)
    // And a sub-second hole, which rounds to nothing worth saying.
    expect(bridgeOfflineMessage(Date.now() - 200, 0)).toBe(PLAIN)
  })

  it('reports a wait only when one actually happened', () => {
    // waitedMs is the caller's honesty knob: the control routes pass 0 because
    // they never wait, so the sentence must not claim they did.
    expect(bridgeOfflineMessage(null, 0)).not.toMatch(/Waited/)
    expect(bridgeOfflineMessage(Date.now() - 12_000, 0)).not.toMatch(/Waited/)
    expect(bridgeOfflineMessage(null, 8_000)).toBe(`${PLAIN} Waited 8s for it to reconnect.`)
    expect(bridgeOfflineMessage(Date.now() - 12_000, 8_000)).toBe(
      'Your primary box (Mac) has been unreachable for 12 seconds. '
      + 'It may be asleep (open the lid) or offline. Waited 8s for it to reconnect.',
    )
  })

  it('stays readable on a phone: plain sentences, no dashes', () => {
    for (const message of [
      bridgeOfflineMessage(null, 0),
      bridgeOfflineMessage(Date.now() - 41 * 60_000, 8_000),
    ]) {
      // U+2013 en dash, U+2014 em dash: written as escapes so the assertion
      // states the rule without containing the characters it bans.
      expect(message).not.toMatch(/[\u2013\u2014]/)
      expect(message).toMatch(/primary box \(Mac\)/)
    }
  })
})
