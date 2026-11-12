/**
 * The token bucket a background upload is paced with (src/lib/upload-pacer.ts):
 * a burst goes at once, then bytes go at the rate, in the order they were taken,
 * a take bigger than the bucket goes once it is full, and drop() fails what waits.
 */
import { describe, expect, it } from 'vitest'
import { createUploadPacer } from '../../src/lib/upload-pacer.js'

function clock() {
  let t = 0
  const timers: Array<{ at: number; fn: () => void; id: number }> = []
  let ids = 0
  return {
    now: () => t,
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
})
