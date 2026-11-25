/**
 * The palette's host-scan cache (src/web/routes/slash-commands-cache.ts): a
 * failure nobody waits for is still heard, a refresh never takes the answer of
 * a scan that began before it, and the cache stays within its entry cap.
 */
import { describe, it, expect, vi } from 'vitest'
import { PaletteScanCache } from '../../../src/web/routes/slash-commands-cache.js'
import { readMemoryHolders } from '../../../src/core/observability/memory-ledger.js'

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))
let n = 0
const cache = <T>(ttlMs = 60_000, maxEntries = 16) => new PaletteScanCache<T>(`test.palette-${n++}`, ttlMs, maxEntries, 1024 * 1024)

describe('PaletteScanCache', () => {
  it('a scan that fails after its budget is heard once, however many asks it outlived', async () => {
    const c = cache<string[]>()
    const scan = deferred<string[]>()
    const heard = vi.fn()
    const opts = { budgetMs: 20, onBackgroundError: heard }
    expect(await c.read('k', () => scan.promise, opts)).toBeNull()
    expect(await c.read('k', () => scan.promise, opts)).toBeNull()
    scan.reject(new Error('link lost'))
    await tick(10)
    expect(heard).toHaveBeenCalledTimes(1)
    expect((heard.mock.calls[0][0] as Error).message).toBe('link lost')
  })

  it('a refresh (fresh) never takes the answer of a scan that began before it: it scans again, after it', async () => {
    const c = cache<string>(0)
    const scans: Array<ReturnType<typeof deferred<string>>> = []
    const scan = vi.fn(() => { const d = deferred<string>(); scans.push(d); return d.promise })
    const opts = { budgetMs: 1_000, onBackgroundError: vi.fn() }
    // A cached value, already expired (ttl 0): the next ask starts a background revalidation.
    const first = c.read('k', scan, opts)
    await tick()
    scans[0].resolve('v0')
    expect(await first).toEqual({ value: 'v0' })
    expect(await c.read('k', scan, opts)).toEqual({ value: 'v0' })
    await tick()
    expect(scan).toHaveBeenCalledTimes(2) // the revalidation, still running

    const refreshed = c.read('k', scan, { ...opts, fresh: true })
    await tick(10)
    // The refresh waits for the running scan to land before it asks the host again.
    expect(scan).toHaveBeenCalledTimes(2)
    scans[1].resolve('before-refresh')
    await tick(10)
    expect(scan).toHaveBeenCalledTimes(3)
    // A second refresh meanwhile joins the refresh's scan, not a third one.
    const again = c.read('k', scan, { ...opts, fresh: true })
    await tick()
    scans[2].resolve('after-refresh')
    expect(await refreshed).toEqual({ value: 'after-refresh' })
    expect(await again).toEqual({ value: 'after-refresh' })
    expect(scan).toHaveBeenCalledTimes(3)
  })

  it('a refresh that is late answers what was cached; its scan still lands for the next ask', async () => {
    const c = cache<string>()
    await c.read('k', async () => 'old', { budgetMs: 1_000, onBackgroundError: vi.fn() })
    const slow = deferred<string>()
    expect(await c.read('k', () => slow.promise, { fresh: true, budgetMs: 20, onBackgroundError: vi.fn() })).toEqual({ value: 'old' })
    slow.resolve('new')
    await tick(10)
    expect(await c.read('k', async () => 'unused', { budgetMs: 20, onBackgroundError: vi.fn() })).toEqual({ value: 'new' })
  })

  it('keeps at most its entry cap, the oldest written going first, and reports itself on the memory ledger', async () => {
    const name = `test.palette-${n}`
    const c = cache<string>(60_000, 2)
    const opts = { budgetMs: 1_000, onBackgroundError: vi.fn() }
    for (const k of ['a', 'b', 'c']) await c.read(k, async () => `v-${k}`, opts)
    expect(readMemoryHolders().find((r) => r.name === name)?.entries).toBe(2)
    const rescan = vi.fn(async () => 'v-a2')
    expect(await c.read('a', rescan, opts)).toEqual({ value: 'v-a2' })
    expect(rescan).toHaveBeenCalledTimes(1)
    expect(await c.read('c', async () => 'unused', opts)).toEqual({ value: 'v-c' })
  })
})
