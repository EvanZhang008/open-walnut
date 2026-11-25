/**
 * The standby caught up before the handover (catch-up.ts), and the waits for the leader's own batch applying there.
 *
 * Found by a 20 GB rehearsal between machines (2026-11-24): the batch before the handover had sent 1.35 GB in 45 s,
 * the copy link was then 20 Mbit/s (about 2.5 MB/s, so about 540 s for as much), and the preflight still passed;
 * the final batch could not finish in the 300 s commit window, and the switch rolled back after 6 min with no
 * leader. Here the batches come from a fake runner with the shapes the real one answers (BatchOutcome stats).
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { FINAL_PASSES, HANDOVER_SEEN_MS, PROMOTE_TRIAL_MS, STOP_TEARDOWN_MS, SWITCH_SETTLE_MS, catchUpBudgetMs, catchUpStandby, standbyBusy, switchSettleMs, whenStandbyIdle } from '../../../../src/core/leader/switch/catch-up.js'
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
  it('the budget is what the switch\'s timeline leaves a batch: 50 s of the default 300 s', () => {
    const b = catchUpBudgetMs(WINDOW)
    expect(b).toBe(50_000)
    // The whole timeline fits the window: the handover seen, the last look, the teardown, the settle, three final
    // passes (with what came, a late writer's, the unchanged one), the new leader's promote, trial and commit.
    expect(HANDOVER_SEEN_MS + b + STOP_TEARDOWN_MS + switchSettleMs(WINDOW) + FINAL_PASSES * b + PROMOTE_TRIAL_MS).toBeLessThanOrEqual(WINDOW)
    // A window too short for the fixed terms leaves no batch any time: every switch is refused before the handover.
    expect(catchUpBudgetMs(60_000)).toBe(0)
  })

  it('the timeline\'s terms are the ones the code uses (the settle in server.ts, the handover wait in source-job.ts)', () => {
    const src = (rel: string) => fs.readFileSync(path.join(__dirname, '../../../..', rel), 'utf8')
    expect(src('src/web/server.ts')).toContain(`const SWITCH_STOP_SETTLE_MS = ${SWITCH_SETTLE_MS.toLocaleString('en-US').replace(/,/g, '_')}`)
    expect(src('src/web/server.ts')).toMatch(/Math\.min\(SWITCH_STOP_SETTLE_MS, Math\.floor\(finalStop\.windowMs \/ 10\)\)/)
    expect(src('src/core/leader/switch/source-job.ts')).toContain(`o.targetReadyMs ?? ${HANDOVER_SEEN_MS.toLocaleString('en-US').replace(/,/g, '_')}`)
  })

  it('near the budget, a second batch about as long is not refused: it may come down in the next', async () => {
    const r = runner([batch(56_000, 1), batch(57_000, 1), batch(40_000, 1)])
    const out = await catchUpStandby({ runOnce: r.runOnce, commitWindowMs: WINDOW, now: r.now })
    expect(out.ok).toBe(true)
    expect(r.calls()).toBe(3)
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

  it('the words it waits on are the ones the target says (apply-status.ts): a change there turns this red, not the wait silently off', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../../../src/core/standby/apply-status.ts'), 'utf8')
    const said = /throw new Error\(`(the target is busy: an apply)\$\{/.exec(src)
    expect(said?.[1]).toBe('the target is busy: an apply')
    expect(standbyBusy(`standby receive init on the host: ${said![1]} of batch 3 runs there since x`)).toBe(true)
  })

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
