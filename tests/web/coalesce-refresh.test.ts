/**
 * coalesceRefresh: a burst of "reload" signals becomes one reload (N2-10). One Update on
 * the Plugins page used to fetch the registry four times inside a second: the POST's own
 * reload, the plugins-changed event, and a WS runtime-changed per plugin the server
 * reloaded. Each signal here is a `request()`; the reload is the counted `run`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { coalesceRefresh } from '../../web/src/utils/coalesce-refresh'

describe('coalesceRefresh', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('four requests inside the window run once, and every caller resolves when that run ends', async () => {
    const run = vi.fn(async () => undefined)
    const c = coalesceRefresh(run, 250)
    const done = [c.request(), c.request(), c.request(), c.request()]
    expect(run).toHaveBeenCalledTimes(0)
    await vi.advanceTimersByTimeAsync(249)
    expect(run).toHaveBeenCalledTimes(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(run).toHaveBeenCalledTimes(1)
    await expect(Promise.all(done)).resolves.toHaveLength(4)
  })

  it('a request during a run schedules exactly one more run after it, never a parallel one', async () => {
    let release: () => void = () => undefined
    const run = vi.fn(() => new Promise<void>((resolve) => { release = resolve }))
    const c = coalesceRefresh(run, 100)
    void c.request()
    await vi.advanceTimersByTimeAsync(100)
    expect(run).toHaveBeenCalledTimes(1)
    // The list is mid-fetch when two more changes land.
    const late = c.request()
    void c.request()
    await vi.advanceTimersByTimeAsync(500)
    expect(run).toHaveBeenCalledTimes(1)
    release()
    await vi.advanceTimersByTimeAsync(1)
    expect(run).toHaveBeenCalledTimes(2)
    release()
    await expect(late).resolves.toBeUndefined()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('a failing run still resolves its callers and does not poison the next request', async () => {
    const run = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(undefined)
    const c = coalesceRefresh(run, 50)
    const first = c.request()
    await vi.advanceTimersByTimeAsync(50)
    await expect(first).resolves.toBeUndefined()
    const second = c.request()
    await vi.advanceTimersByTimeAsync(50)
    await expect(second).resolves.toBeUndefined()
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('cancel drops a pending timer', async () => {
    const run = vi.fn(async () => undefined)
    const c = coalesceRefresh(run, 50)
    void c.request()
    c.cancel()
    await vi.advanceTimersByTimeAsync(500)
    expect(run).toHaveBeenCalledTimes(0)
  })
})
