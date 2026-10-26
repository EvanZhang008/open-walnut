/**
 * GET /api/system/desktop-update answers from the last daemon reply
 * (src/web/routes/desktop-update-cache.ts): the daemon runs the status on its
 * one thread behind transcript parses, and waiting for it each poll gave the
 * route a 3.1 s p99 and 7 to 8 s worst cases (2026-10-22 to 25).
 */
import { describe, expect, it, vi } from 'vitest'
import {
  COLD_WAIT_MS, createDesktopUpdateCache, EMPTY_DESKTOP_UPDATE, REFRESH_AFTER_MS, RESTART_LIVE_MS,
  type DesktopUpdateAnswer,
} from '../../../src/web/routes/desktop-update-cache.js'

const answer = (version: string): DesktopUpdateAnswer => ({ available: true, token: `t:${version}`, version })

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

describe('desktop update answer cache', () => {
  it('serves the last answer at once and refreshes it behind the request, one ask at a time', async () => {
    let t = 0
    const cache = createDesktopUpdateCache(() => t)
    const owner = {}
    const ask = vi.fn(async () => answer('1'))
    expect(await cache.get(owner, ask)).toEqual(answer('1'))
    expect(ask).toHaveBeenCalledTimes(1)

    // Fresh: no ask at all.
    t += REFRESH_AFTER_MS - 1
    expect(await cache.get(owner, ask)).toEqual(answer('1'))
    expect(ask).toHaveBeenCalledTimes(1)

    // Stale: the old answer now, one background ask however many requests come.
    t += 2
    const slow = deferred<DesktopUpdateAnswer>()
    ask.mockImplementation(() => slow.promise)
    expect(await cache.get(owner, ask)).toEqual(answer('1'))
    expect(await cache.get(owner, ask)).toEqual(answer('1'))
    expect(ask).toHaveBeenCalledTimes(2)
    slow.resolve(answer('2'))
    await slow.promise
    await Promise.resolve()
    expect(await cache.get(owner, ask)).toEqual(answer('2'))
  })

  it('a fresh server waits briefly for its first answer, then answers empty and keeps the late one', async () => {
    vi.useFakeTimers()
    try {
      const cache = createDesktopUpdateCache()
      const owner = {}
      const slow = deferred<DesktopUpdateAnswer>()
      const first = cache.get(owner, () => slow.promise)
      await vi.advanceTimersByTimeAsync(COLD_WAIT_MS)
      expect(await first).toEqual(EMPTY_DESKTOP_UPDATE)
      slow.resolve(answer('1'))
      await vi.advanceTimersByTimeAsync(0)
      expect(await cache.get(owner, async () => answer('never'))).toEqual(answer('1'))
    } finally {
      vi.useRealTimers()
    }
  })

  it('another daemon connection never gets the old one\'s answer', async () => {
    const cache = createDesktopUpdateCache(() => 0)
    await cache.get({}, async () => answer('old daemon'))
    expect(await cache.get({}, async () => answer('new daemon'))).toEqual(answer('new daemon'))
  })

  it('after a restart request every poll waits for a live answer, then caching resumes', async () => {
    let t = 0
    const cache = createDesktopUpdateCache(() => t)
    const owner = {}
    await cache.get(owner, async () => answer('1'))
    cache.noteRestart()
    const ask = vi.fn(async () => ({ ...answer('1'), restarting: true }))
    expect((await cache.get(owner, ask)).restarting).toBe(true)
    expect((await cache.get(owner, ask)).restarting).toBe(true)
    expect(ask).toHaveBeenCalledTimes(2)
    // Past the window: the kept answer at once (stale, so one ask behind it).
    t += RESTART_LIVE_MS
    const slow = deferred<DesktopUpdateAnswer>()
    ask.mockImplementation(() => slow.promise)
    expect((await cache.get(owner, ask)).restarting).toBe(true)
    expect(ask).toHaveBeenCalledTimes(3)
    slow.resolve(answer('1'))
  })

  it('a failed ask answers empty and is not kept', async () => {
    const cache = createDesktopUpdateCache(() => 0)
    const owner = {}
    expect(await cache.get(owner, async () => { throw new Error('daemon gone') })).toEqual(EMPTY_DESKTOP_UPDATE)
    expect(await cache.get(owner, async () => answer('1'))).toEqual(answer('1'))
  })
})
