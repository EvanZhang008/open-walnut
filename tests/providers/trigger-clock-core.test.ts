/**
 * A clock routine in a daemon's trigger table (src/providers/trigger-clock-core.ts,
 * clock-routine-v1): the def's validation, the handover mark and the last-run
 * floor, the catch-up rule (one run for every slot missed), and a whole pushed
 * set where one bad def is refused alone.
 */
import { describe, expect, it } from 'vitest'
import {
  clockDueMs, clockFireOwed, clockStateOnArm, dropStaleClockFires, validateClockSpec,
} from '../../src/providers/trigger-clock-core.js'
import {
  applyClockFire, claimFires, emptyHostState, triggersSetHash, validateTriggerDef, validateTriggerSet,
  type PendingFire, type TriggerDef,
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
    expect(validateClockSpec({ schedule: { kind: 'cron', expr: '0 9 * * *', tz: 'UTC' }, fromMs: 5, notBeforeMs: 'x' })).toMatchObject({ ok: false })
  })

  it('keeps the last-run floor, and the set hash moves with it', () => {
    const v = validateClockSpec({ schedule: { kind: 'cron', expr: '0 9 * * *', tz: 'UTC' }, fromMs: 5, notBeforeMs: 7.6 })
    expect(v).toMatchObject({ ok: true, spec: { fromMs: 5, notBeforeMs: 7 } })
    const a = validateTriggerDef(cronDef(10))
    const b = validateTriggerDef({ ...cronDef(10), clock: { ...(cronDef(10).clock as object), notBeforeMs: 9 } })
    if (!a.ok || !b.ok) throw new Error('defs did not validate')
    expect(triggersSetHash([a.def])).not.toBe(triggersSetHash([b.def]))
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

  it('never runs a slot at or before the routine’s last run, wherever that run happened', () => {
    const hourly = { kind: 'every' as const, everyMs: HOUR, anchorMs: 0 }
    // An older Mac ran the routine itself at 5.5h while the daemon kept its place at 3h.
    const prev = { fromMs: HOUR, nextRunAtMs: 3 * HOUR }
    expect(clockStateOnArm({ schedule: hourly, fromMs: HOUR, notBeforeMs: 5.5 * HOUR }, prev)).toEqual({ fromMs: HOUR, nextRunAtMs: 6 * HOUR })
    // A run exactly on the slot covers it.
    expect(clockStateOnArm({ schedule: hourly, fromMs: HOUR, notBeforeMs: 3 * HOUR }, prev)).toEqual({ fromMs: HOUR, nextRunAtMs: 4 * HOUR })
    // A floor behind the place changes nothing (the same object comes back).
    expect(clockStateOnArm({ schedule: hourly, fromMs: HOUR, notBeforeMs: 2 * HOUR }, prev)).toBe(prev)
    // A new handover starts past it too, and a one-shot that ran has no slot left.
    expect(clockStateOnArm({ schedule: hourly, fromMs: 2 * HOUR, notBeforeMs: 2.5 * HOUR }, prev)).toEqual({ fromMs: 2 * HOUR, nextRunAtMs: 3 * HOUR })
    const at = { kind: 'at' as const, at: new Date(4 * HOUR).toISOString() }
    expect(clockStateOnArm({ schedule: at, fromMs: 4 * HOUR, notBeforeMs: 4 * HOUR + 1 }, undefined)).toEqual({ fromMs: 4 * HOUR })
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

describe('a pushed set', () => {
  it('refuses a bad def alone and arms the rest, a repeated id keeping its first def', () => {
    const good = cronDef(10)
    const other = { ...cronDef(20), id: 'r2' }
    const bad = { ...cronDef(30), id: 'r3', clock: { schedule: { kind: 'cron', expr: '0 9 * * 1#2', tz: 'UTC' }, fromMs: 30 } }
    const { defs, refused } = validateTriggerSet([good, bad, { id: 7 }, other, { ...cronDef(40) }])
    expect(defs.map((d) => [d.id, d.clock?.fromMs])).toEqual([['r1', 10], ['r2', 20]])
    expect(refused).toHaveLength(3)
    expect(refused[0]).toMatchObject({ id: 'r3' })
    expect(refused[1].id).toBeUndefined()
    expect(refused[2]).toEqual({ id: 'r1', error: 'duplicate trigger id r1' })
  })
})
