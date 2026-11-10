import { describe, expect, it } from 'vitest'
import { ephemeralContendedIdleTtlMs, ephemeralIdleTtlMs, idleExitRule } from '../../src/commands/ephemeral-idle.js'

describe('ephemeral server idle timeout', () => {
  it('is ten minutes unless WALNUT_EPHEMERAL_IDLE_MINUTES says otherwise', () => {
    expect(ephemeralIdleTtlMs({})).toBe(10 * 60_000)
    expect(ephemeralIdleTtlMs({ WALNUT_EPHEMERAL_IDLE_MINUTES: '360' })).toBe(360 * 60_000)
    expect(ephemeralIdleTtlMs({ WALNUT_EPHEMERAL_IDLE_MINUTES: ' 1.5 ' })).toBe(90_000)
  })

  it('keeps the default for anything unreadable, and caps at a day', () => {
    for (const v of ['', '0', '-5', 'abc', '10m', 'Infinity', '1e9']) {
      expect(ephemeralIdleTtlMs({ WALNUT_EPHEMERAL_IDLE_MINUTES: v })).toBe(10 * 60_000)
    }
    expect(ephemeralIdleTtlMs({ WALNUT_EPHEMERAL_IDLE_MINUTES: '100000' })).toBe(24 * 60 * 60_000)
  })
})

describe('idle while another launcher waits for a slot', () => {
  const min = 60_000
  it('is 15 minutes unless WALNUT_EPHEMERAL_CONTENDED_IDLE_MINUTES says otherwise', () => {
    expect(ephemeralContendedIdleTtlMs({})).toBe(15 * min)
    expect(ephemeralContendedIdleTtlMs({ WALNUT_EPHEMERAL_CONTENDED_IDLE_MINUTES: '5' })).toBe(5 * min)
    expect(ephemeralContendedIdleTtlMs({ WALNUT_EPHEMERAL_CONTENDED_IDLE_MINUTES: 'x' })).toBe(15 * min)
  })

  it('a raised limit holds only while nobody waits', () => {
    // A server raised to 240 min, idle 20 min.
    expect(idleExitRule(20 * min, 240 * min, false, 15 * min)).toBeNull()
    expect(idleExitRule(20 * min, 240 * min, true, 15 * min)).toBe('idle-contended')
    expect(idleExitRule(14 * min, 240 * min, true, 15 * min)).toBeNull()
    expect(idleExitRule(241 * min, 240 * min, false, 15 * min)).toBe('idle')
  })

  it('never lengthens a server\'s own limit: the default 10 minutes ends on plain idle', () => {
    expect(idleExitRule(11 * min, 10 * min, true, 15 * min)).toBe('idle')
    expect(idleExitRule(9 * min, 10 * min, true, 15 * min)).toBeNull()
    expect(idleExitRule(16 * min, 15 * min, true, 15 * min)).toBe('idle')
  })
})
