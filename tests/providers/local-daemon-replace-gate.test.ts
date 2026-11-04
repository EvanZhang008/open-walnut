/**
 * When a new build may replace this machine's daemon (src/providers/local-daemon-replace.ts
 * ReplacementGate): a trial beside the old daemon first, a refusal after a failed one, and a
 * day off for a build that passed it and then did not start on the real dir.
 *
 * MACHINE SAFETY: pure; the trial is a fake and the clock is this file's.
 */
import { describe, expect, it } from 'vitest'
import { LOCAL_REPLACE_RETRY_MS, REAL_DIR_BACKOFF_MS, ReplacementGate } from '../../src/providers/local-daemon-replace.js'

describe('ReplacementGate', () => {
  function gate() {
    let now = 1_000_000
    const g = new ReplacementGate(() => now)
    let trials = 0
    let verdict: string | null = null
    const run = async () => { trials += 1; return verdict }
    return {
      g, run, trials: () => trials, fail: (why: string | null) => { verdict = why },
      later: (ms: number) => { now += ms },
    }
  }

  it('goes once its trial passed', async () => {
    const t = gate()
    expect(t.g.check('b1', t.run, () => {})).toBe('wait')
    await t.g.pending
    expect(t.g.check('b1', t.run, () => {})).toBe('go')
    expect(t.trials()).toBe(1)
  })

  it('a failed trial refuses, and is tried again after its retry time', async () => {
    const t = gate()
    t.fail('it exited with 1')
    t.g.check('b1', t.run, () => {})
    await t.g.pending
    expect(t.g.check('b1', t.run, () => {})).toEqual({ refused: 'it exited with 1' })
    t.later(LOCAL_REPLACE_RETRY_MS + 1)
    expect(t.g.check('b1', t.run, () => {})).toBe('wait')
  })

  // 2026-11-04 review: after the day off, the build went straight through on the trial it passed
  // a day before, with no new trial of its own.
  it('a build that passed and did not start on the real dir waits a day, then gets a trial of its own again', async () => {
    const t = gate()
    t.g.check('b1', t.run, () => {})
    await t.g.pending
    expect(t.g.check('b1', t.run, () => {})).toBe('go')
    t.g.refuse('b1', 'it did not start on the real dir', true)
    t.later(LOCAL_REPLACE_RETRY_MS + 1)
    expect(t.g.check('b1', t.run, () => {})).toEqual({ refused: 'it did not start on the real dir' })
    t.later(REAL_DIR_BACKOFF_MS)
    t.fail('it exited with 1')
    expect(t.g.check('b1', t.run, () => {})).toBe('wait')
    await t.g.pending
    expect(t.trials()).toBe(2)
    expect(t.g.check('b1', t.run, () => {})).toEqual({ refused: 'it exited with 1' })
  })

  // 2026-11-04 review: the refusal lived in memory, so a server restart (every deploy) stopped
  // the healthy daemon for the same build again.
  it('a real-dir refusal is kept in its store and read back by a gate of a restarted server', async () => {
    let kept: { expected: string; at: number; reason: string } | null = null
    const store = { read: async () => kept, write: async (e: { expected: string; at: number; reason: string }) => { kept = e } }
    const first = new ReplacementGate(Date.now, store)
    first.refuse('b1', 'it did not start on the real dir', true)
    await Promise.resolve()
    expect(kept).toMatchObject({ expected: 'b1', reason: 'it did not start on the real dir' })
    // A failed trial is not kept: it is asked again in minutes anyway.
    first.refuse('b2', 'it exited with 1', false)
    expect(kept).toMatchObject({ expected: 'b1' })
    const restarted = new ReplacementGate(Date.now, store)
    await restarted.load()
    expect(restarted.refusedNow('b1')).toBe('it did not start on the real dir')
    expect(restarted.check('b1', async () => null, () => {})).toEqual({ refused: 'it did not start on the real dir' })
    expect(restarted.refusedNow('b3')).toBeNull()
  })
})
