/**
 * A clock routine in a daemon's trigger table (src/providers/trigger-clock-core.ts,
 * clock-routine-v1): the def's validation, the handover mark, the catch-up rule
 * (one run for every slot missed) and what a release hands back.
 */
import { describe, expect, it } from 'vitest'
import {
  clockDueMs, clockFireOwed, clockStateOnArm, dropStaleClockFires, releaseClockFires, validateClockSpec,
} from '../../src/providers/trigger-clock-core.js'
import {
  applyClockFire, claimFires, emptyHostState, triggersSetHash, validateTriggerDef, type PendingFire, type TriggerDef,
} from '../../src/providers/trigger-check-core.js'

const HOUR = 3_600_000
const cronDef = (fromMs: number): Record<string, unknown> => ({
  id: 'r1', name: 'Daily review', clock: { schedule: { kind: 'cron', expr: '0 9 * * *', tz: 'UTC' }, fromMs },
  deliver: { home: '/h', taskId: 't1', prompt: 'Look at the queue' },
})

describe('validating a clock def', () => {
  it('takes a cron with its zone, an every with its anchor, and an at', () => {
    expect(validateClockSpec({ schedule: { kind: 'cron', expr: '0 9 * * *', tz: 'UTC' }, fromMs: 5 }).ok).toBe(true)
    expect(validateClockSpec({ schedule: { kind: 'every', everyMs: HOUR, anchorMs: 0 }, fromMs: 5 }).ok).toBe(true)
    expect(validateClockSpec({ schedule: { kind: 'at', at: '2026-05-01T10:00:00Z' }, fromMs: 5 }).ok).toBe(true)
  })

  it('refuses what a host would have to guess or cannot run', () => {
    expect(validateClockSpec({ schedule: { kind: 'cron', expr: '0 9 * * *' }, fromMs: 5 })).toMatchObject({ ok: false })
    expect(validateClockSpec({ schedule: { kind: 'every', everyMs: HOUR }, fromMs: 5 })).toMatchObject({ ok: false })
    expect(validateClockSpec({ schedule: { kind: 'cron', expr: '0 9 * * 1#2', tz: 'UTC' }, fromMs: 5 })).toMatchObject({ ok: false })
    expect(validateClockSpec({ schedule: { kind: 'cron', expr: '0 9 * * *', tz: 'UTC' } })).toMatchObject({ ok: false })
  })

  it('a trigger def carries a check or a clock, never both, and keeps its delivery', () => {
    const ok = validateTriggerDef(cronDef(10))
    expect(ok.ok).toBe(true)
    if (ok.ok) {
      expect(ok.def.check).toBeUndefined()
      expect(ok.def.clock?.fromMs).toBe(10)
      expect(ok.def.deliver?.taskId).toBe('t1')
    }
    expect(validateTriggerDef({ ...cronDef(10), check: { run: 'true' }, everyMs: 60_000 }).ok).toBe(false)
  })

  it('the set hash moves with the handover mark and leaves a check set alone', () => {
    const a = validateTriggerDef(cronDef(10))
    const b = validateTriggerDef(cronDef(11))
    if (!a.ok || !b.ok) throw new Error('defs did not validate')
    expect(triggersSetHash([a.def])).not.toBe(triggersSetHash([b.def]))
    const check: TriggerDef = { id: 'c', name: 'c', everyMs: 60_000, check: { run: 'true', timeoutSeconds: 60 } }
    expect(triggersSetHash([check])).toBe(triggersSetHash([check]))
  })
})

describe('the handover mark', () => {
  it('the same mark keeps the daemon’s place; a new one starts at the new slot', () => {
    const prev = { fromMs: 100, nextRunAtMs: 900 }
    expect(clockStateOnArm({ schedule: { kind: 'at', at: 'x' }, fromMs: 100 }, prev)).toBe(prev)
    expect(clockStateOnArm({ schedule: { kind: 'at', at: 'x' }, fromMs: 200 }, prev)).toEqual({ fromMs: 200, nextRunAtMs: 200 })
    expect(clockStateOnArm({ schedule: { kind: 'at', at: 'x' }, fromMs: 200 }, undefined)).toEqual({ fromMs: 200, nextRunAtMs: 200 })
  })

  it('a past slot (a catch-up) waits the first-run delay; a future one waits for itself; none never runs', () => {
    expect(clockDueMs({ fromMs: 0, nextRunAtMs: 50 }, 1_000, 5_000)).toBe(6_000)
    expect(clockDueMs({ fromMs: 0, nextRunAtMs: 90_000 }, 1_000, 5_000)).toBe(90_000)
    expect(clockDueMs({ fromMs: 0 }, 1_000, 5_000)).toBe(Number.POSITIVE_INFINITY)
  })
})

describe('owed runs', () => {
  const fire = (seq: number, slotMs: number, extra: Partial<PendingFire> = {}): PendingFire => ({
    seq, atMs: slotMs, items: [], durationMs: 0, arbitrated: true, clock: { slotMs, fromMs: 1 }, ...extra,
  })

  it('a run nobody took is owed; a claimed or host-delivered one is not', () => {
    expect(clockFireOwed([fire(1, 10)])).toBe(true)
    expect(clockFireOwed([fire(1, 10, { claimedAt: 11 })])).toBe(false)
    expect(clockFireOwed([fire(1, 10, { host: { atMs: 12, sessionId: 's', messageId: 'm', seqs: [1] } })])).toBe(false)
    expect(clockFireOwed([{ seq: 1, atMs: 1, items: [], durationMs: 0 }])).toBe(false)
  })

  it('applyClockFire queues a run with no items, stamped with its slot and handover', () => {
    const state = emptyHostState(0)
    const f = applyClockFire(state, 5_000, 4_000, true, 1)
    expect(f).toMatchObject({ seq: 1, atMs: 5_000, items: [], arbitrated: true, clock: { slotMs: 4_000, fromMs: 1 } })
    expect(state.pendingFires).toHaveLength(1)
    expect(state.lastFireAtMs).toBe(5_000)
  })

  it('a release hands back the owed runs (the oldest slot) and keeps what someone took or is delivering', () => {
    const state = { pendingFires: [fire(1, 100), fire(2, 50), fire(3, 30, { claimedAt: 31 }), fire(4, 20)] }
    expect(releaseClockFires(state, new Set([4]))).toBe(50)
    expect(state.pendingFires.map((f) => f.seq)).toEqual([3, 4])
    expect(releaseClockFires({ pendingFires: [fire(5, 9, { claimedAt: 1 })] })).toBeUndefined()
  })

  it('a new handover drops the runs nobody took under an older one', () => {
    const state = { pendingFires: [fire(1, 10), { ...fire(2, 20), clock: { slotMs: 20, fromMs: 7 } }, fire(3, 30, { claimedAt: 31 })] }
    expect(dropStaleClockFires(state, 7)).toBe(true)
    expect(state.pendingFires.map((f) => f.seq)).toEqual([2, 3])
    expect(dropStaleClockFires(state, 7)).toBe(false)
  })

  it('a server claim takes a clock run like any fire, so the host never delivers it too', () => {
    const state = emptyHostState(0)
    applyClockFire(state, 5_000, 4_000, true, 1)
    const { reply } = claimFires(state, [1], 6_000)
    expect(reply.claimed).toEqual([1])
    expect(clockFireOwed(state.pendingFires)).toBe(false)
  })
})
