/**
 * The upload step's numbers (src/providers/connect-transfer.ts): what a host's status
 * frame carries while the daemon's file goes onto the host, and how often a frame is
 * pushed for it (every open window gets each one).
 */
import { describe, expect, it } from 'vitest'
import { createTransferMeter, TRANSFER_NOTIFY_GAP_MS } from '../../src/providers/connect-transfer.js'

function meter(active = true) {
  let t = 1_000_000
  const pushes: string[] = []
  let on = active
  const m = createTransferMeter({ active: () => on, notify: () => pushes.push(JSON.stringify(m.current)), now: () => t })
  return { m, pushes, tick: (ms: number) => { t += ms }, setActive: (v: boolean) => { on = v } }
}

describe('the transfer meter', () => {
  it('a chunked upload: the first count and the last always push, the ones between at most once a second', () => {
    const { m, pushes, tick } = meter()
    const total = 267 * 262_144
    m.report('upload', 0, total)
    for (let i = 1; i <= 267; i++) { tick(300); m.report('upload', i * 262_144, total) }
    expect(m.current).toEqual({ via: 'upload', done: total, total })
    // 267 chunks over 80 s: about one push a second, plus the first and the last.
    expect(pushes.length).toBeGreaterThan(60)
    expect(pushes.length).toBeLessThan(90)
    expect(JSON.parse(pushes[0]!)).toEqual({ via: 'upload', done: 0, total })
    expect(JSON.parse(pushes.at(-1)!)).toEqual({ via: 'upload', done: total, total })
  })

  it('counts close together push once; the same count again pushes nothing', () => {
    const { m, pushes, tick } = meter()
    m.report('download', 0, 1000)
    m.report('download', 10, 1000)
    m.report('download', 20, 1000)
    expect(pushes).toHaveLength(1)
    // Held back, but the frame built next reads the newest count.
    expect(m.current).toEqual({ via: 'download', done: 20, total: 1000 })
    tick(TRANSFER_NOTIFY_GAP_MS)
    m.report('download', 20, 1000)
    expect(pushes).toHaveLength(1)
    m.report('download', 30, 1000)
    expect(pushes).toHaveLength(2)
  })

  it('a download that gives way to an upload starts a new bar at once', () => {
    const { m, pushes } = meter()
    m.report('download', 400, 1000)
    m.report('upload', 0, 1200)
    expect(pushes.map((p) => JSON.parse(p).via)).toEqual(['download', 'upload'])
    expect(m.current).toEqual({ via: 'upload', done: 0, total: 1200 })
  })

  it('clamps a count to 0 and its total, and ignores a total that is no size', () => {
    const { m } = meter()
    m.report('upload', -5, 100)
    expect(m.current).toEqual({ via: 'upload', done: 0, total: 100 })
    m.report('upload', 150, 100)
    expect(m.current).toEqual({ via: 'upload', done: 100, total: 100 })
    m.report('upload', 10, 0)
    m.report('upload', 10, Number.NaN)
    expect(m.current).toEqual({ via: 'upload', done: 100, total: 100 })
  })

  it('outside the upload step it neither keeps nor pushes anything, and clear forgets quietly', () => {
    const { m, pushes, setActive } = meter(false)
    m.report('upload', 10, 100)
    expect(m.current).toBeNull()
    expect(pushes).toEqual([])
    setActive(true)
    m.report('upload', 10, 100)
    m.clear()
    expect(m.current).toBeNull()
    expect(pushes).toHaveLength(1)
  })
})
