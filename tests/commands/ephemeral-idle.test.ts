import { describe, expect, it } from 'vitest'
import { ephemeralIdleTtlMs } from '../../src/commands/ephemeral-idle.js'

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
