/**
 * The standby caught up before the handover (catch-up.ts), and the waits for the leader's own batch applying there.
 *
 * Found by a 20 GB rehearsal between machines (2026-11-24): the batch before the handover had sent 1.35 GB in 45 s,
 * the copy link was then 20 Mbit/s (about 2.5 MB/s, so about 540 s for as much), and the preflight still passed;
 * the final batch could not finish in the 300 s commit window, and the switch rolled back after 6 min with no
 * leader. Here the batches come from a fake runner with the shapes the real one answers (BatchOutcome stats).
 */
import { describe, expect, it } from 'vitest'
import { catchUpBudgetMs, catchUpStandby, standbyBusy, whenStandbyIdle } from '../../../../src/core/leader/switch/catch-up.js'
import type { BatchOutcome } from '../../../../src/core/standby/index.js'

const WINDOW = 300_000
/** A batch of the runner's shape that took `ms` and sent `bytes` (unchanged: it found nothing to send). */
const batch = (ms: number, bytes: number, unchanged = false): BatchOutcome => ({ ok: true, manifest: {} as never, commit: { batch: 1, unchanged, written: unchanged ? 0 : 1, deleted: 0 } as never, stats: { totalMs: ms, sentBytes: bytes } as never })
const voidBatch = (ms: number): BatchOutcome => ({ ok: false, reason: 'a write at the wrong instant', stats: { totalMs: ms } as never })

/** A runner answering these outcomes in turn, each after its time on a fake clock. */
function runner(list: Array<BatchOutcome | null>) {
  let t = 0
  let i = 0
  return {
    calls: () => i,
    now: () => t,
    runOnce: async () => {
      const o = list[Math.min(i, list.length - 1)]!
      i++
      t += o && 'stats' in o ? Number((o.stats as { totalMs?: number }).totalMs ?? 0) : 0
      return o
    },
  }
}

describe('the standby caught up before the handover', () => {
  it('the budget is a quarter of the commit window (75 s of the default 300 s)', () => {
    expect(catchUpBudgetMs(WINDOW)).toBe(75_000)
  })

  it('a batch within the budget is caught up at once; one that found nothing changed only when it is within it too', async () => {
    const r1 = runner([batch(12_000, 40 << 20)])
    expect((await catchUpStandby({ runOnce: r1.runOnce, commitWindowMs: WINDOW, now: r1.now })).ok).toBe(true)
    const r2 = runner([batch(5_000, 0, true)])
    expect((await catchUpStandby({ runOnce: r2.runOnce, commitWindowMs: WINDOW, now: r2.now })).ok).toBe(true)
    // A walk of the home alone over the budget: the final batch ends on such a pass, so it would not fit either.
    const r3 = runner([batch(200_000, 0, true)])
    expect((await catchUpStandby({ runOnce: r3.runOnce, commitWindowMs: WINDOW, now: r3.now })).ok).toBe(false)
  })

  it('behind, it catches up while the leader serves: a long batch, then a short one that carried only what came meanwhile', async () => {
    // 400 MB at 2.5 MB/s, then what was written during those 160 s.
    const r = runner([batch(160_000, 400 << 20), batch(20_000, 50 << 20)])
    const out = await catchUpStandby({ runOnce: r.runOnce, commitWindowMs: WINDOW, now: r.now })
    expect(out.ok).toBe(true)
    expect(out.batches.map((b) => b.ms)).toEqual([160_000, 20_000])
  })

  it('the rehearsal\'s case: a 540 s batch is not waited for past the catch-up\'s time, the switch is refused before any handover', async () => {
    const out = await catchUpStandby({ runOnce: () => new Promise(() => {}), commitWindowMs: 3_000, maxMs: 200 })
    expect(out.ok).toBe(false)
    expect(!out.ok && out.why).toMatch(/still ran after 0\.2 s of catching up/)
  })

  it('writes that outpace the link: two batches over the budget, the later not shorter, refuse at once', async () => {
    const r = runner([batch(80_000, 200 << 20), batch(100_000, 250 << 20), batch(10_000, 1)])
    const out = await catchUpStandby({ runOnce: r.runOnce, commitWindowMs: WINDOW, now: r.now })
    expect(out.ok).toBe(false)
    expect(!out.ok && out.why).toMatch(/falls further behind/)
    expect(r.calls()).toBe(2)
    // Nothing to send, and still too slow: the walk itself is named.
    const walk = runner([batch(80_000, 0, true), batch(90_000, 0, true)])
    const slow = await catchUpStandby({ runOnce: walk.runOnce, commitWindowMs: WINDOW, now: walk.now })
    expect(!slow.ok && slow.why).toMatch(/a walk of the home alone takes 90\.0 s/)
  })

  it('void batches: refused after three rounds in a row, a second apart, with the last reason; one that stands in between resets the count', async () => {
    const r = runner([voidBatch(2_000)])
    const t0 = Date.now()
    const out = await catchUpStandby({ runOnce: r.runOnce, commitWindowMs: WINDOW, now: r.now, voidPauseMs: 100 })
    expect(out.ok).toBe(false)
    expect(!out.ok && out.why).toMatch(/3 standby batches in a row were void; the last: void after 2\.0 s \(a write at the wrong instant\)/)
    expect(r.calls()).toBe(3)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(190)
    const mixed = runner([voidBatch(1_000), voidBatch(1_000), batch(90_000, 1), voidBatch(1_000), batch(10_000, 1)])
    expect((await catchUpStandby({ runOnce: mixed.runOnce, commitWindowMs: WINDOW, now: mixed.now, voidPauseMs: 1 })).ok).toBe(true)
  })

  it('void batches within the catch-up\'s time: refused once it is over', async () => {
    const r = runner([voidBatch(150_000), batch(100_000, 1), voidBatch(150_000)])
    const out = await catchUpStandby({ runOnce: r.runOnce, commitWindowMs: WINDOW, now: r.now, voidPauseMs: 1 })
    expect(out.ok).toBe(false)
    expect(!out.ok && out.why).toMatch(/within 300\.0 s; the last: void after 150\.0 s/)
  })

  it('no standby batches on this leader: refused, never a pass', async () => {
    const out = await catchUpStandby({ runOnce: async () => null, commitWindowMs: WINDOW })
    expect(out.ok).toBe(false)
    expect(!out.ok && out.why).toMatch(/takes no standby batches/)
  })
})

describe('the leader\'s own batch applying on the standby', () => {
  const busy = new Error('standby receive verify on the host: the target is busy: an apply of batch 5 runs there since 2026-11-24T20:22:13.908Z')

  it('the rehearsal\'s refusal is the target applying a batch', () => {
    expect(standbyBusy(busy.message)).toBe(true)
    expect(standbyBusy('the copy link was closed')).toBe(false)
  })

  it('a verify waits it out, within its time; any other error is thrown at once', async () => {
    let n = 0
    const r = await whenStandbyIdle(async () => { if (++n < 3) throw busy; return { drift: 0 } }, { untilMs: Date.now() + 5_000, everyMs: 10 })
    expect(r).toEqual({ drift: 0 })
    expect(n).toBe(3)
    let m = 0
    await expect(whenStandbyIdle(async () => { m++; throw new Error('the copy link was closed') }, { untilMs: Date.now() + 5_000, everyMs: 10 })).rejects.toThrow(/closed/)
    expect(m).toBe(1)
    await expect(whenStandbyIdle(async () => { throw busy }, { untilMs: Date.now() + 50, everyMs: 10 })).rejects.toThrow(/busy/)
  })
})
