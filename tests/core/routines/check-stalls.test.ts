/**
 * A periodic check trigger that has not reported for more than two periods while its host stayed
 * linked tells its owner once per stall (src/core/routines/check-stalls.ts).
 *
 * 2026-11-25: a trigger's record looked stopped for four hours, and only the reader's own clock
 * noticed. A window in which the host's link or this machine was down never counts: the checks
 * that ran then come with the next configure (providers/trigger-unsent-checks.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  CHECK_STALL_GRACE_MS, checkStallNotice, checkStallOf, noticeCheckStallsOnce, resetCheckStallsForTest, type CheckStallDeps,
} from '../../../src/core/routines/check-stalls.js'
import type { CronJob } from '../../../src/core/cron/types.js'
import { CHECK_ERROR_BACKOFF_MS, MAX_CONSECUTIVE_CHECK_ERRORS } from '../../../src/providers/trigger-check-core.js'

const MIN = 60_000
const EVERY = 30 * MIN
const LAST = Date.UTC(2026, 10, 25, 4, 40, 0)
/** The first moment past two periods and the grace. */
const STALLED = LAST + 2 * EVERY + CHECK_STALL_GRACE_MS + 1_000

function job(over: Partial<CronJob> = {}, state: Partial<CronJob['state']> = {}): CronJob {
  return {
    id: 'trg-stall-1', name: 'Build watch', enabled: true, createdAtMs: LAST - 24 * 60 * MIN, updatedAtMs: 0,
    sessionTarget: 'isolated', wakeMode: 'now', payload: { kind: 'agentTurn', message: 'x' },
    schedule: { kind: 'every', everyMs: EVERY },
    executor: { type: 'session', config: { target: 't-owner', prompt: 'p' } },
    check: { run: 'sh check.sh', host: 'devbox' },
    state: { lastCheck: { atMs: LAST, outcome: 'quiet', durationMs: 100 }, ...state },
    ...over,
  } as CronJob
}

const up = () => true
const down = () => false

describe('checkStallOf', () => {
  it('a check within two periods and the grace is no stall', () => {
    expect(checkStallOf(job(), LAST + EVERY, up)).toBeNull()
    expect(checkStallOf(job(), LAST + 2 * EVERY + CHECK_STALL_GRACE_MS, up)).toBeNull()
  })

  it('past two periods and the grace, with the link up the whole window, is a stall', () => {
    const linkUp = vi.fn(up)
    expect(checkStallOf(job(), STALLED, linkUp)).toEqual({ lastMs: LAST, overdueMs: STALLED - LAST, everyMs: EVERY, host: 'devbox' })
    expect(linkUp).toHaveBeenCalledWith('devbox', LAST, STALLED)
  })

  it('a link down in the window, or never seen, is no stall', () => {
    expect(checkStallOf(job(), STALLED, down)).toBeNull()
    // The ledger has no word for a host it never saw: the injected answer stands for that.
    const unknown = vi.fn((host: string) => host === 'some-other-host')
    expect(checkStallOf(job(), STALLED, unknown)).toBeNull()
    expect(unknown).toHaveBeenCalledOnce()
  })

  it('a paused trigger, a routine with no check, or one on a clock schedule is never a stall', () => {
    expect(checkStallOf(job({ enabled: false }), STALLED, up)).toBeNull()
    expect(checkStallOf(job({ check: undefined }), STALLED, up)).toBeNull()
    expect(checkStallOf(job({ schedule: { kind: 'cron', expr: '*/30 * * * *', tz: 'UTC' } } as Partial<CronJob>), STALLED, up)).toBeNull()
    expect(checkStallOf(job({ schedule: { kind: 'every', everyMs: 0 } } as Partial<CronJob>), STALLED, up)).toBeNull()
  })

  it('with no check yet, it counts from when checks were expected, else from the trigger\'s creation', () => {
    const created = LAST - EVERY
    expect(checkStallOf(job({ createdAtMs: created }, { lastCheck: undefined }), STALLED, up)?.lastMs).toBe(created)
    expect(checkStallOf(job({ createdAtMs: created }, { lastCheck: undefined, expectFromMs: LAST }), STALLED, up)?.lastMs).toBe(LAST)
  })

  it(`after ${MAX_CONSECUTIVE_CHECK_ERRORS} errors in a row, the host's backoff is the period`, () => {
    const every = MIN
    const short = job({ schedule: { kind: 'every', everyMs: every } } as Partial<CronJob>)
    const past = LAST + 2 * every + CHECK_STALL_GRACE_MS + 1_000
    expect(checkStallOf(short, past, up)).toMatchObject({ everyMs: every })
    const failing = job({ schedule: { kind: 'every', everyMs: every } } as Partial<CronJob>, { consecutiveErrors: MAX_CONSECUTIVE_CHECK_ERRORS })
    expect(checkStallOf(failing, past, up), 'within two backoffs').toBeNull()
    const pastBackoff = LAST + 2 * CHECK_ERROR_BACKOFF_MS + CHECK_STALL_GRACE_MS + 1_000
    expect(checkStallOf(failing, pastBackoff, up)).toMatchObject({ everyMs: CHECK_ERROR_BACKOFF_MS })
    // Fewer errors than that: the daemon keeps the trigger's own period.
    const few = job({ schedule: { kind: 'every', everyMs: every } } as Partial<CronJob>, { consecutiveErrors: MAX_CONSECUTIVE_CHECK_ERRORS - 1 })
    expect(checkStallOf(few, past, up)).toMatchObject({ everyMs: every })
  })
})

describe('checkStallNotice', () => {
  it('names the trigger, the overdue time, the host and how to look', () => {
    const j = job()
    const text = checkStallNotice(j, checkStallOf(j, STALLED, up)!)
    expect(text).toContain('"Build watch" (trg-stall-1)')
    expect(text).toContain(`${Math.round((STALLED - LAST) / MIN)} minutes`)
    expect(text).toContain('30-minute periods')
    expect(text).toContain('devbox')
    expect(text).toContain(new Date(LAST).toISOString())
    expect(text).toContain(`trigger_test '{"id":"trg-stall-1"}'`)
  })
})

function deps(jobs: CronJob[], opts: { now: number; linkUp?: CheckStallDeps['linkUp']; reached?: (taskId: string) => boolean; main?: string }) {
  const told: Array<{ taskId: string; jobId: string; lastMs: number }> = []
  const d: CheckStallDeps & { told: typeof told; at: { now: number } } = {
    told,
    at: { now: opts.now },
    jobs: async () => jobs,
    linkUp: opts.linkUp ?? up,
    tellTeam: vi.fn(async ({ taskId, job: j, stall }) => {
      told.push({ taskId, jobId: j.id, lastMs: stall.lastMs })
      return opts.reached ? opts.reached(taskId) : true
    }),
    mainTaskId: async () => opts.main,
    now: () => d.at.now,
  }
  return d
}

describe('noticeCheckStallsOnce', () => {
  beforeEach(() => resetCheckStallsForTest())

  it('tells the owner once per stall', async () => {
    const d = deps([job({ ownerTaskId: 't-lead' })], { now: STALLED })
    expect(await noticeCheckStallsOnce(d)).toBe(1)
    expect(d.told).toEqual([{ taskId: 't-lead', jobId: 'trg-stall-1', lastMs: LAST }])
    // Later sweeps of the same stall tell nothing more.
    d.at.now = STALLED + EVERY
    expect(await noticeCheckStallsOnce(d)).toBe(0)
    expect(d.told).toHaveLength(1)
  })

  it('tells again after a newer check came and the trigger stalled once more', async () => {
    const j = job({ ownerTaskId: 't-lead' })
    const d = deps([j], { now: STALLED })
    expect(await noticeCheckStallsOnce(d)).toBe(1)
    // A newer check: no stall now.
    const later = STALLED + MIN
    j.state.lastCheck = { atMs: later, outcome: 'quiet', durationMs: 100 }
    d.at.now = later + EVERY
    expect(await noticeCheckStallsOnce(d)).toBe(0)
    // It stalls again from that check.
    d.at.now = later + 2 * EVERY + CHECK_STALL_GRACE_MS + 1_000
    expect(await noticeCheckStallsOnce(d)).toBe(1)
    expect(d.told.map((t) => t.lastMs)).toEqual([LAST, later])
  })

  it('a trigger that is not stalled, or whose link was down, is told nothing', async () => {
    const fresh = job({ id: 'trg-fresh' }, { lastCheck: { atMs: STALLED - MIN, outcome: 'quiet', durationMs: 1 } })
    const d = deps([fresh, job()], { now: STALLED, linkUp: down })
    expect(await noticeCheckStallsOnce(d)).toBe(0)
    expect(d.told).toEqual([])
  })

  it('goes down the owner chain until one is reached: the owner, the target, then Main', async () => {
    const d = deps([job({ ownerTaskId: 't-lead' })], { now: STALLED, main: 'main-ceo', reached: (t) => t === 'main-ceo' })
    expect(await noticeCheckStallsOnce(d)).toBe(1)
    expect(d.told.map((t) => t.taskId)).toEqual(['t-lead', 't-owner', 'main-ceo'])
    // Told once even when nobody was reached: the next sweep does not walk the chain again.
    expect(await noticeCheckStallsOnce(d)).toBe(0)
    expect(d.told).toHaveLength(3)
  })

  it('each stalled trigger is told on its own', async () => {
    const d = deps([job({ id: 'trg-a' }), job({ id: 'trg-b' })], { now: STALLED })
    expect(await noticeCheckStallsOnce(d)).toBe(2)
    expect(d.told.map((t) => t.jobId).sort()).toEqual(['trg-a', 'trg-b'])
  })
})
