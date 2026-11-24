/**
 * The ledger goes by the physical footprint (Activity Monitor's Memory) where it can be read, not
 * RSS, which on macOS keeps counting pages the allocator already freed. 2026-11-24: RSS 4,271 MB,
 * footprint 1,483 MB.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { _setFootprintReaderForTesting, physFootprintMb } from '../../../src/core/observability/footprint.js'
import { memoryReadingMb, processMemoryMb } from '../../../src/core/observability/memory-ledger.js'

afterEach(() => _setFootprintReaderForTesting(undefined))

describe('physFootprintMb', () => {
  it.runIf(process.platform === 'darwin' && !!(globalThis as { Bun?: unknown }).Bun)('reads this process on macOS: above zero, at most a little over RSS', () => {
    const fp = physFootprintMb()
    expect(fp).not.toBeNull()
    expect(fp!).toBeGreaterThan(0)
    // Footprint counts compressed and swapped pages too, so it may pass RSS, never by gigabytes here.
    expect(fp!).toBeLessThan(Math.round(process.memoryUsage().rss / 1048576) + 2048)
  })

  it('is null where it cannot be read, and the reading falls back to RSS', () => {
    _setFootprintReaderForTesting(null)
    expect(physFootprintMb()).toBeNull()
    expect(processMemoryMb()).not.toHaveProperty('footprintMb')
    const rss = Math.round(process.memoryUsage().rss / 1048576)
    expect(Math.abs(memoryReadingMb() - rss)).toBeLessThan(256)
  })

  it('the reading and the process numbers use the footprint when there is one', () => {
    _setFootprintReaderForTesting(() => 1483 * 1048576)
    expect(physFootprintMb()).toBe(1483)
    expect(memoryReadingMb()).toBe(1483)
    expect(processMemoryMb().footprintMb).toBe(1483)
  })

  it('a reader that fails or reads zero is no footprint', () => {
    _setFootprintReaderForTesting(() => { throw new Error('gone') })
    expect(physFootprintMb()).toBeNull()
    _setFootprintReaderForTesting(() => 0)
    expect(physFootprintMb()).toBeNull()
  })
})
