/**
 * The token bucket a background upload is paced with (src/lib/upload-pacer.ts):
 * a burst goes at once, then bytes go at the rate, in the order they were taken,
 * a take bigger than the bucket goes once it is full, and drop() fails what waits.
 * Its pace changes while it runs (setLimits, a host's learned pace probing up), null limits
 * let bytes go at once, and it reports demand and the rate it let out (lib/adaptive-pace.ts).
 */
import { describe, expect, it } from 'vitest'
import { createUploadPacer } from '../../src/lib/upload-pacer.js'

function clock() {
  let t = 0
  const timers: Array<{ at: number; fn: () => void; id: number }> = []
  let ids = 0
  return {
    now: () => t,
    pending: () => timers.length,
    setTimer: (fn: () => void, ms: number) => { const id = ++ids; timers.push({ at: t + ms, fn, id }); return id },
    clearTimer: (id: unknown) => { const i = timers.findIndex((x) => x.id === id); if (i >= 0) timers.splice(i, 1) },
    async advance(ms: number) {
      const end = t + ms
      for (;;) {
        timers.sort((a, b) => a.at - b.at)
        const next = timers[0]
        if (!next || next.at > end) break
        timers.shift()
        t = next.at
        next.fn()
        await Promise.resolve()
      }
      t = end
      await Promise.resolve()
    },
  }
}

describe('createUploadPacer', () => {
  it('lets a burst out at once, then the rate, in order', async () => {
    const c = clock()
    const p = createUploadPacer({ bytesPerSec: 1000, burstBytes: 2000, ...c })
    const done: number[] = []
    for (let i = 0; i < 5; i++) void p.take(1000).then(() => done.push(i))
    await Promise.resolve()
    expect(done).toEqual([0, 1])
    expect(p.queuedBytes).toBe(3000)
    await c.advance(999)
    expect(done).toEqual([0, 1])
    await c.advance(1)
    expect(done).toEqual([0, 1, 2])
    await c.advance(2000)
    expect(done).toEqual([0, 1, 2, 3, 4])
    expect(p.sentBytes).toBe(5000)
    expect(p.queuedBytes).toBe(0)
  })

  it('a take bigger than the bucket waits for a full one, and the next waits off its debt', async () => {
    const c = clock()
    const p = createUploadPacer({ bytesPerSec: 1000, burstBytes: 1000, ...c })
    const done: string[] = []
    void p.take(1000).then(() => done.push('a'))
    void p.take(5000).then(() => done.push('big'))
    void p.take(10).then(() => done.push('small'))
    await Promise.resolve()
    expect(done).toEqual(['a'])
    await c.advance(1000)
    expect(done).toEqual(['a', 'big'])
    // The big one left the bucket 4000 short: the small one waits that out.
    await c.advance(3999)
    expect(done).toEqual(['a', 'big'])
    await c.advance(20)
    expect(done).toEqual(['a', 'big', 'small'])
  })

  it('a quiet stretch refills only up to the bucket', async () => {
    const c = clock()
    const p = createUploadPacer({ bytesPerSec: 1000, burstBytes: 1500, ...c })
    await c.advance(60_000)
    const done: number[] = []
    for (let i = 0; i < 3; i++) void p.take(1000).then(() => done.push(i))
    await Promise.resolve()
    expect(done).toEqual([0])
    await c.advance(500)
    expect(done).toEqual([0, 1])
  })

  it('drop() fails every waiting take and stops its timer', async () => {
    const c = clock()
    const p = createUploadPacer({ bytesPerSec: 1000, burstBytes: 1000, ...c })
    await p.take(1000)
    const waiting = p.take(1000)
    p.drop('the lane closed')
    await expect(waiting).rejects.toThrow('the lane closed')
    expect(p.queuedBytes).toBe(0)
  })

  it('unpaced: every take goes at once, and is still counted', async () => {
    const c = clock()
    const p = createUploadPacer({ bytesPerSec: null, ...c })
    const done: number[] = []
    for (let i = 0; i < 5; i++) void p.take(1024 * 1024).then(() => done.push(i))
    await Promise.resolve()
    expect(done).toEqual([0, 1, 2, 3, 4])
    expect(p.sentBytes).toBe(5 * 1024 * 1024)
    expect(p.limits).toBeNull()
    expect(p.lastSentAt).toBe(0)
  })

  it('setLimits changes the pace of the takes already waiting; null lets them all go', async () => {
    const c = clock()
    const p = createUploadPacer({ bytesPerSec: 1000, burstBytes: 1000, ...c })
    const done: number[] = []
    for (let i = 0; i < 4; i++) void p.take(1000).then(() => done.push(i))
    await Promise.resolve()
    expect(done).toEqual([0])
    p.setLimits({ bytesPerSec: 4000, burstBytes: 1000 })
    await c.advance(250)
    expect(done).toEqual([0, 1])
    p.setLimits(null)
    await Promise.resolve()
    expect(done).toEqual([0, 1, 2, 3])
    expect(p.queuedBytes).toBe(0)
  })

  it('reports the time bytes waited behind the pace, and the rate it let out', async () => {
    const c = clock()
    const waited: number[] = []
    const p = createUploadPacer({ bytesPerSec: 1000, burstBytes: 1000, ...c, onDemand: (ms) => waited.push(ms) })
    for (let i = 0; i < 3; i++) void p.take(1000)
    await c.advance(2000)
    // Two seconds of waiting, reported as the pacer let each piece go.
    expect(waited.reduce((a, b) => a + b, 0)).toBe(2000)
    // 3000 bytes in 2 s: over the last few seconds, at least one second counted.
    expect(p.recentBytesPerSec()).toBe(1500)
    await c.advance(10_000)
    expect(p.recentBytesPerSec()).toBe(0)
    expect(waited.reduce((a, b) => a + b, 0)).toBe(2000)
  })

  it('a pace change from its own demand report (a probe) leaves one timer chain and counts each wait once', async () => {
    const c = clock()
    const waited: number[] = []
    let probed = false
    const p = createUploadPacer({
      bytesPerSec: 1000, burstBytes: 1000, ...c,
      onDemand: (ms) => { waited.push(ms); if (!probed) { probed = true; p.setLimits({ bytesPerSec: 2000, burstBytes: 1000 }) } },
    })
    const done: number[] = []
    for (let i = 0; i < 6; i++) void p.take(1000).then(() => done.push(i))
    await Promise.resolve()
    for (let step = 0; step < 40 && done.length < 6; step++) {
      await c.advance(100)
      expect(c.pending()).toBeLessThanOrEqual(1)
    }
    expect(probed).toBe(true)
    expect(done).toEqual([0, 1, 2, 3, 4, 5])
    // 1 s at 1000 B/s for the second take, then 0.5 s each for the last four at 2000 B/s.
    expect(waited.reduce((a, b) => a + b, 0)).toBe(3000)
    expect(c.pending()).toBe(0)
  })
})
