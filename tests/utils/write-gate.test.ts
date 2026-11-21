/**
 * The write gate (src/utils/write-gate.ts): off it changes nothing; on, a hold waits for the
 * gated writes under way, holds new ones until it ends, lets nested ones through, and gives
 * up when the writes under way do not end in time.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { gated, holdWrites, setWriteGateEnabled, writesInFlight } from '../../src/utils/write-gate.js'

afterEach(() => setWriteGateEnabled(false))
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('write gate', () => {
  it('off: a gated call runs at once, even during a hold', async () => {
    const order: string[] = []
    await holdWrites(async () => {
      await gated(async () => { order.push('write') })
      order.push('hold')
    }, { drainMs: 50 })
    expect(order).toEqual(['write', 'hold'])
  })

  it('on: the hold waits for writes under way and holds new ones until it ends', async () => {
    setWriteGateEnabled(true)
    const order: string[] = []
    const slow = gated(async () => { await tick(40); order.push('slow write done') })
    expect(writesInFlight()).toBe(1)
    let late: Promise<void> | undefined
    // An outside write (its timer made outside the hold) that comes while the hold drains.
    let outside: Promise<void> | undefined
    setTimeout(() => { outside = gated(async () => { order.push('outside write') }) }, 10)
    const hold = holdWrites(async () => {
      order.push('hold runs')
      late = gated(async () => { order.push('new write') })
      await tick(30)
      order.push('hold ends')
    }, { drainMs: 500 })
    const res = await hold
    await slow
    await late
    await outside
    expect(res.drained).toBe(true)
    // `late` was started inside the hold's own context, so it is nested and passes through.
    expect(order).toEqual(['slow write done', 'hold runs', 'new write', 'hold ends', 'outside write'])
  })

  it('on: a write started while the hold waits runs only after it', async () => {
    setWriteGateEnabled(true)
    const order: string[] = []
    const hold = holdWrites(async () => { order.push('hold'); await tick(20) }, { drainMs: 100 })
    const w = gated(async () => { order.push('write') })
    await Promise.all([hold, w])
    expect(order).toEqual(['hold', 'write'])
  })

  it('on: nested gated sections never wait on the hold (no deadlock)', async () => {
    setWriteGateEnabled(true)
    const order: string[] = []
    const outer = gated(async () => {
      await tick(20)
      await gated(async () => { order.push('inner') })
      order.push('outer')
    })
    const hold = holdWrites(async () => { order.push('hold') }, { drainMs: 1000 })
    await Promise.all([outer, hold])
    expect(order).toEqual(['inner', 'outer', 'hold'])
  })

  it('on: writes that do not end in time make the hold give up without running', async () => {
    setWriteGateEnabled(true)
    let ran = false
    const stuck = gated(() => tick(200))
    const res = await holdWrites(async () => { ran = true }, { drainMs: 30 })
    expect(res.drained).toBe(false)
    expect(ran).toBe(false)
    // New writes are let go at once.
    let after = false
    await gated(async () => { after = true })
    expect(after).toBe(true)
    await stuck
  })
})
