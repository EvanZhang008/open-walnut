/**
 * scripts/ci-red-range.mjs: for a job red on main, the run where it last passed and the run
 * that turned it red, stepping over runs where it was cancelled or did not run.
 */
import { describe, it, expect } from 'vitest'
// @ts-expect-error plain .mjs without types
import { redRange } from '../../scripts/ci-red-range.mjs'

const runs = (list: (string | null)[]) => list.map((c, i) => ({ id: i, c }))
const of = (r: { c: string | null }) => r.c

describe('redRange', () => {
  it('newest first: the last green run and the oldest red run after it', () => {
    const r = redRange(runs(['failure', 'failure', 'cancelled', 'failure', 'success', 'failure']), of)
    expect(r.lastGreen.id).toBe(4)
    expect(r.firstRed.id).toBe(3)
  })

  it('a job red in every run read has no last green; the oldest red is where the walk ended', () => {
    const r = redRange(runs(['failure', null, 'failure']), of)
    expect(r.lastGreen).toBeNull()
    expect(r.firstRed.id).toBe(2)
  })

  it('green on the newest run: nothing turned it red', () => {
    expect(redRange(runs(['success', 'failure']), of)).toEqual({ lastGreen: { id: 0, c: 'success' }, firstRed: null })
  })
})
