/**
 * A test that mocks config-manager with only getConfig never runs config-manager's own code, so it
 * never hands experimental-cache its reader (2026-11-22: plugin-quiet-show-only read every switch
 * off after experimental-cache stopped importing config-manager). experimental-cache loads it then.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../src/core/config-manager.js', () => ({ getConfig: async () => ({ experimental: { brief_off: true } }) }))

describe('experimental-cache with a mocked config-manager', () => {
  it('reads the switch from the mocked getConfig without a handed reader', async () => {
    const { experimentCache } = await import('../../src/core/experimental-cache.js')
    const flag = experimentCache('brief_off')
    expect(await flag.on()).toBe(true)
    expect(flag.now()).toBe(true)
  })
})
