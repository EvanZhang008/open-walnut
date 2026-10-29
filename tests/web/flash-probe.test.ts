/**
 * The flash probe (web/src/utils/flash-probe.ts) is temporary debug logging:
 * it must switch itself off at its date, and a stored '0' turns it off sooner.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/utils/log', () => ({ log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } }))
const { flashProbeEnabled, FLASH_PROBE_UNTIL } = await import('../../web/src/utils/flash-probe')

const store = new Map<string, string>()
;(globalThis as unknown as { localStorage: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v) },
}
afterEach(() => store.clear())

describe('flash probe switch', () => {
  it('is on before its date and off from it', () => {
    expect(flashProbeEnabled(FLASH_PROBE_UNTIL - 1)).toBe(true)
    expect(flashProbeEnabled(FLASH_PROBE_UNTIL)).toBe(false)
  })
  it('runs a week at most', () => {
    expect(FLASH_PROBE_UNTIL - Date.parse('2026-10-29T00:00:00Z')).toBeLessThanOrEqual(8 * 86_400_000)
  })
  it('a stored 0 turns it off', () => {
    store.set('walnut:flash-probe', '0')
    expect(flashProbeEnabled(FLASH_PROBE_UNTIL - 1)).toBe(false)
  })
})
