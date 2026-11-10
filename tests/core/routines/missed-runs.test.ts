/**
 * A missed routine run is told to the routine's owner once (src/core/routines/missed-runs.ts).
 * 2026-11-08: the daily org reflection did not run and nobody heard.
 */
import { describe, it, expect, vi } from 'vitest'
import { noticeMissedRunsOnce, missedRunNotice, type MissedRunDeps } from '../../../src/core/routines/missed-runs.js'
import type { CronJob } from '../../../src/core/cron/types.js'

const HOUR = 3_600_000
const SLOT = Date.UTC(2026, 10, 8, 16, 0, 0)

function job(over: Partial<CronJob> = {}): CronJob {
  return {
    id: 'mvmrfw2l-4dad', name: 'Org reflection', enabled: true, createdAtMs: SLOT - 10 * 24 * HOUR, updatedAtMs: 0,
    sessionTarget: 'isolated', wakeMode: 'now', payload: { kind: 'agentTurn', message: 'x' },
    schedule: { kind: 'cron', expr: '0 8 * * *', tz: 'America/Los_Angeles' },
    executor: { type: 'claude-code', config: { instructions: 'x', cwd: '/x' } },
    state: {
      runLogSinceMs: SLOT - HOUR,
      runLog: [{ atMs: SLOT + 1, slotMs: SLOT, status: 'error', durationMs: 48_000, error: 'Not started: this Mac had no room for 1 minute' }],
    },
    ...over,
  } as CronJob
}

function deps(jobs: CronJob[], reached = true, main?: string): MissedRunDeps & { told: unknown[]; bells: unknown[]; marked: unknown[] } {
  const told: unknown[] = []
  const bells: unknown[] = []
  const marked: unknown[] = []
  return {
    told, bells, marked,
    service: async () => ({
      list: async () => jobs,
      markMissed: async (id: string, mark: { told?: number[] }) => {
        marked.push({ id, ...mark })
        const j = jobs.find((x) => x.id === id)!
        j.state.missedToldMs = [...(mark.told ?? []), ...(j.state.missedToldMs ?? [])]
        return j
      },
    }),
    tellTeam: vi.fn(async (input) => { told.push(input); return reached }),
    bell: vi.fn(async (input) => { bells.push(input) }),
    mainTaskId: async () => main,
    now: () => SLOT + 2 * HOUR,
  }
}

describe('telling a missed run', () => {
  it('goes to the owner once per missed slot', async () => {
    const j = job({ ownerTaskId: 'main-task' })
    const d = deps([j])
    expect(await noticeMissedRunsOnce(d)).toBe(1)
    expect(d.told).toEqual([{ taskId: 'main-task', job: j, missed: [expect.objectContaining({ slotMs: SLOT })] }])
    expect(d.bells).toEqual([])
    expect(await noticeMissedRunsOnce(d)).toBe(0)
    expect(d.told).toHaveLength(1)
  })

  it('a routine with no owner and no task of its own goes to Main, never the user’s notifications', async () => {
    const d = deps([job()], true, 'main-ceo')
    await noticeMissedRunsOnce(d)
    expect(d.told).toEqual([expect.objectContaining({ taskId: 'main-ceo' })])
    expect(d.bells).toEqual([])
    // A routine that delivers into a task tells that task, not Main.
    const t = deps([job({ executor: { type: 'session', config: { target: 'lead-task' } } } as Partial<CronJob>)], true, 'main-ceo')
    await noticeMissedRunsOnce(t)
    expect(t.told).toEqual([expect.objectContaining({ taskId: 'lead-task' })])
  })

  it('goes to the user’s notifications only with no owner, no task and no Main (a Walnut whose org was never used)', async () => {
    const d = deps([job()])
    await noticeMissedRunsOnce(d)
    expect(d.told).toEqual([])
    expect(d.bells).toHaveLength(1)
    // A session's routine whose team cannot be told never reaches the user (trigger-user-notice-ratchet).
    const e = deps([job({ ownerTaskId: 'gone' })], false)
    await noticeMissedRunsOnce(e)
    expect(e.told).toHaveLength(1)
    expect(e.bells).toEqual([])
  })

  it('a routine with nothing missed is left alone', async () => {
    const ok = job({ state: { runLogSinceMs: SLOT - HOUR, runLog: [{ atMs: SLOT + 1, slotMs: SLOT, status: 'ok', durationMs: 1 }] } })
    const d = deps([ok])
    expect(await noticeMissedRunsOnce(d)).toBe(0)
    expect(d.marked).toEqual([])
  })

  it('says what was missed, why, and how to run it now or set it aside', () => {
    const text = missedRunNotice(job(), [{ slotMs: SLOT, reason: 'Not started: no room' }], 'owner')
    expect(text).toContain('Your routine "Org reflection" (mvmrfw2l-4dad) missed a run')
    expect(text).toContain('Sun, Nov 8, 8:00 AM PST')
    expect(text).toContain('Not started: no room')
    expect(text).toContain(`"path":"/api/routines/mvmrfw2l-4dad/run","body":{"catchUpMs":${SLOT}}`)
    expect(text).toContain(`"path":"/api/routines/mvmrfw2l-4dad/missed/dismiss","body":{"slotMs":${SLOT}}`)
  })
})

describe('the notice reads as sentences', () => {
  it('a reason ending in a full stop gets no second one', async () => {
    const { sentence } = await import('../../../src/core/routines/missed-runs.js')
    expect(sentence('Not started: no room (all 7 slots taken).')).toBe('Not started: no room (all 7 slots taken).')
    expect(sentence('no run was recorded for this time')).toBe('no run was recorded for this time.')
  })
})

describe('the owner chain is read from the routine as it is now (review 2026-11-10)', () => {
  const tellsOnly = (reachable: string[]) => vi.fn(async (input: { taskId: string }) => reachable.includes(input.taskId))

  it('an owner that cannot be told falls to the task it delivers into, then Main', async () => {
    const j = job({ ownerTaskId: 'gone-task', executor: { type: 'session', config: { target: 'sid-not-a-task' } } } as Partial<CronJob>)
    const d = deps([j], true, 'main-ceo')
    d.tellTeam = tellsOnly(['main-ceo'])
    await noticeMissedRunsOnce(d)
    expect((d.tellTeam as ReturnType<typeof vi.fn>).mock.calls.map(([i]) => i.taskId)).toEqual(['gone-task', 'sid-not-a-task', 'main-ceo'])
    expect(d.bells).toEqual([])
  })

  it('a target edited after the routine was made is the one told, never the old one', async () => {
    const j = job({ executor: { type: 'session', config: { target: 'task-old' } } } as Partial<CronJob>)
    j.executor = { type: 'session', config: { target: 'task-new' } } as CronJob['executor']
    const d = deps([j], true, 'main-ceo')
    await noticeMissedRunsOnce(d)
    expect(d.told).toEqual([expect.objectContaining({ taskId: 'task-new' })])
  })

  it('nothing is stored: a routine made with no owner keeps none, and still reaches Main', async () => {
    const j = job()
    const d = deps([j], true, 'main-ceo')
    await noticeMissedRunsOnce(d)
    expect(j.ownerTaskId).toBeUndefined()
    expect(d.told).toEqual([expect.objectContaining({ taskId: 'main-ceo' })])
  })
})
