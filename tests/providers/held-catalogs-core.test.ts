/**
 * The gateway's held op catalogs (held-catalogs-core.ts, tools-list-held-v1), as a unit: held
 * per Walnut, only for a schemas tools.list. The relay itself is covered on the real twins in
 * tests/providers/daemon-gateway-held-catalog-twins-e2e.test.ts.
 */
import { describe, it, expect } from 'vitest'
import { createHeldCatalogs } from '../../src/providers/held-catalogs-core.js'

const full = (hash: string) => ({ ops: [{ name: `op_${hash}` }], catalogHash: hash })

describe('held catalogs', () => {
  it('are held per Walnut: one Walnut\'s catalog is never named for another', () => {
    const held = createHeldCatalogs()
    held.settle('/home/a/.open-walnut', 'tools.list', { schemas: true }, full('aaaa'))
    expect(held.ask('/home/a/.open-walnut', 'tools.list', { schemas: true })).toEqual({ schemas: true, have: ['aaaa'] })
    expect(held.ask('/home/b/.open-walnut', 'tools.list', { schemas: true })).toEqual({ schemas: true })
    expect(held.ask(undefined, 'tools.list', { schemas: true })).toEqual({ schemas: true })
    // Another Walnut's server naming that hash gets the call again in full, not A's catalog.
    expect(held.settle('/home/b/.open-walnut', 'tools.list', { schemas: true, have: [] }, { sameAs: 'aaaa' })).toEqual({ again: { schemas: true } })
  })

  it('touch only a schemas tools.list', () => {
    const held = createHeldCatalogs()
    const r = full('aaaa')
    expect(held.settle('w', 'tools.list', {}, r)).toEqual({ result: r })
    expect(held.settle('w', 'tools.call', { schemas: true }, r)).toEqual({ result: r })
    expect(held.held('w')).toEqual([])
    const payload = { name: 'task_get', args: {}, have: ['x'] }
    expect(held.ask('w', 'tools.call', payload)).toBe(payload)
    expect(held.settle('w', 'tools.call', payload, { sameAs: 'aaaa' })).toEqual({ result: { sameAs: 'aaaa' } })
  })

  it('a cold Walnut asks once at a time; the rest go when it is held, or all at once when it failed', () => {
    const held = createHeldCatalogs({ waitMs: 60_000 })
    const resumed: number[] = []
    expect(held.wait('w', 'tools.list', { schemas: true }, () => resumed.push(0))).toBe(false)
    expect(held.wait('w', 'tools.list', { schemas: true }, () => resumed.push(1))).toBe(true)
    expect(held.wait('w', 'tools.list', { schemas: true }, () => resumed.push(2))).toBe(true)
    // Another Walnut and another op are not held back.
    expect(held.wait('v', 'tools.list', { schemas: true }, () => resumed.push(9))).toBe(false)
    expect(held.wait('w', 'tools.call', { schemas: true }, () => resumed.push(9))).toBe(false)
    held.settle('w', 'tools.list', { schemas: true }, full('aaaa'))
    expect(resumed).toEqual([1, 2])
    expect(held.wait('w', 'tools.list', { schemas: true }, () => resumed.push(3))).toBe(false)
    // A first ask that fails lets every waiter go, none waiting on another.
    expect(held.wait('x', 'tools.list', { schemas: true }, () => {})).toBe(false)
    const again: boolean[] = []
    for (let i = 0; i < 3; i++) held.wait('x', 'tools.list', { schemas: true }, () => { again.push(held.wait('x', 'tools.list', { schemas: true }, () => {})) })
    held.failed('x', 'tools.list', { schemas: true })
    expect(again).toEqual([false, false, false])
  })

  it('holds at most maxTotal catalogs across Walnuts, least recently used out first', () => {
    const held = createHeldCatalogs({ maxTotal: 3 })
    for (const [home, hash] of [['a', 'h1'], ['b', 'h2'], ['c', 'h3'], ['d', 'h4']]) held.settle(home, 'tools.list', { schemas: true }, full(hash))
    expect(held.held('a')).toEqual([])
    expect(held.held('d')).toEqual(['h4'])
  })

  it('a full answer without its ops is not held', () => {
    const held = createHeldCatalogs()
    held.settle('w', 'tools.list', { schemas: true }, { catalogHash: 'aaaa' })
    expect(held.held('w')).toEqual([])
  })
  it('a full catalog that comes after its relay timed out is held, so the next ask names it (2026-11-21)', () => {
    let t = 0
    const held = createHeldCatalogs({ lateMs: 60_000, now: () => t })
    held.timedOut(7, 'w', 'tools.list', { schemas: true })
    t = 30_000
    expect(held.late(7, full('aaaa'), () => true)).toBe(true)
    expect(held.ask('w', 'tools.list', { schemas: true })).toEqual({ schemas: true, have: ['aaaa'] })
    // Once only: the same relay's second late answer is nobody's.
    expect(held.late(7, full('bbbb'), () => true)).toBe(false)
    expect(held.held('w')).toEqual(['aaaa'])
  })

  it('a late answer is held only for a timed-out schemas list, in time, in full, from a sender of its Walnut', () => {
    let t = 0
    const held = createHeldCatalogs({ lateMs: 60_000, now: () => t })
    // Never timed out here.
    expect(held.late(1, full('aaaa'), () => true)).toBe(false)
    // Not a schemas list.
    held.timedOut(2, 'w', 'tools.list', {})
    held.timedOut(3, 'w', 'tools.call', { schemas: true })
    expect(held.late(2, full('aaaa'), () => true)).toBe(false)
    expect(held.late(3, full('aaaa'), () => true)).toBe(false)
    // A late sameAs, an error answer or an older server's catalog without a hash holds nothing.
    for (const [id, r] of [[4, { sameAs: 'aaaa' }], [5, undefined], [6, { ops: [] }]] as const) {
      held.timedOut(id, 'w', 'tools.list', { schemas: true })
      expect(held.late(id, r as Record<string, unknown> | undefined, () => true)).toBe(false)
    }
    // Too late.
    held.timedOut(9, 'w', 'tools.list', { schemas: true })
    t = 60_000
    expect(held.late(9, full('aaaa'), () => true)).toBe(false)
    expect(held.held('w')).toEqual([])
    // Another Walnut's server: refused, told the pin the relay went with, and the ask stays for the right one.
    held.timedOut(8, 'w', 'tools.list', { schemas: true }, true)
    const asked: Array<[string | undefined, boolean]> = []
    expect(held.late(8, full('ffff'), (home, pinned) => { asked.push([home, pinned]); return false })).toBe(false)
    expect(asked).toEqual([['w', true]])
    expect(held.held('w')).toEqual([])
    expect(held.late(8, full('aaaa'), () => true)).toBe(true)
    expect(held.held('w')).toEqual(['aaaa'])
  })

  it('remembers a bounded number of timed-out asks, the oldest out first', () => {
    const held = createHeldCatalogs({ now: () => 0 })
    for (let id = 1; id <= 200; id++) held.timedOut(id, 'w', 'tools.list', { schemas: true })
    // The newest 64 are kept: 137..200.
    expect(held.late(136, full('aaaa'), () => true)).toBe(false)
    expect(held.late(137, full('aaaa'), () => true)).toBe(true)
    expect(held.late(200, full('bbbb'), () => true)).toBe(true)
  })

  it('an expired ask is swept by the next timed-out one', () => {
    let t = 0
    const held = createHeldCatalogs({ lateMs: 1_000, now: () => t })
    held.timedOut(1, 'w', 'tools.list', { schemas: true })
    t = 5_000
    held.timedOut(2, 'w', 'tools.list', { schemas: true })
    t = 0
    // Swept, not only refused for its age: with the clock back it is still gone.
    expect(held.late(1, full('aaaa'), () => true)).toBe(false)
    t = 5_000
    expect(held.late(2, full('aaaa'), () => true)).toBe(true)
  })
})
