/**
 * An idle reap of a quiet session, and the reconciler's check of an In Progress task whose sessions
 * all ended, keep the task In Progress while its own work runs outside (phase.ts ownWorkWakes, a
 * watches:"own" trigger). Once that watch's check, run after the task's sessions last worked, says
 * nothing is in flight (`"idle": true`), nothing wakes the task, so it is handed back as any other
 * (2026-11-23: a task read Working with its session idle and its Mac queue empty).
 *
 * Also the work-end clock those callers pass (task-wait-wake.ts sessionWorkEndedAtMs, allEndedAtMs).
 */
import { describe, it, expect, vi } from 'vitest'

const watching: { list: Array<Record<string, unknown>> } = { list: [] }
vi.mock('../../src/core/task-wait-until.js', () => ({ triggersWatching: async () => watching.list }))

import { ownWorkWakes } from '../../src/core/phase.js'
import { allEndedAtMs, sessionWorkEndedAtMs } from '../../src/core/task-wait-wake.js'

const T = Date.parse('2026-11-23T10:00:00Z')
const iso = (ms: number) => new Date(ms).toISOString()
const own = (lastCheck?: Record<string, unknown>) => ({ id: 'job-1', name: 'Mac queue results', state: 'armed', fires: 2, ownWork: true, ...(lastCheck ? { lastCheck } : {}) })

describe('ownWorkWakes with an idle own-work watch', () => {
  it('an idle check after the sessions last worked wakes nothing: the reap and the reconciler hand the task back', async () => {
    watching.list = [own({ atMs: T, outcome: 'quiet', idle: true })]
    expect(await ownWorkWakes('t1', T - 60_000)).toBe(false)
  })

  it('still wakes it with no idle mark, an idle mark from before the work ended, or no known work end', async () => {
    watching.list = [own({ atMs: T, outcome: 'quiet' })]
    expect(await ownWorkWakes('t1', T - 60_000)).toBe(true)
    watching.list = [own({ atMs: T - 120_000, outcome: 'quiet', idle: true })]
    expect(await ownWorkWakes('t1', T - 60_000)).toBe(true)
    watching.list = [own({ atMs: T, outcome: 'quiet', idle: true })]
    expect(await ownWorkWakes('t1', undefined)).toBe(true)
    expect(await ownWorkWakes('t1', Number.POSITIVE_INFINITY)).toBe(true)
  })

  it('a paused watch, or one on something outside, never keeps it In Progress', async () => {
    watching.list = [{ ...own({ atMs: T, outcome: 'quiet' }), state: 'paused' }, { id: 'job-2', name: 'CI elsewhere', state: 'armed', fires: 0 }]
    expect(await ownWorkWakes('t1', T - 60_000)).toBe(false)
  })
})

describe('when a session last did work', () => {
  const moves = (...m: Array<[string, number]>) => m.map(([process_status, at]) => ({ process_status, timestamp: iso(at) }))
  it('the move out of its latest turn, even after an idle reap stopped it', () => {
    // Newest first, as session-tracker.ts keeps them.
    expect(sessionWorkEndedAtMs({ process_status: 'idle', status_history: moves(['idle', T - 600_000], ['running', T - 900_000]), lastActiveAt: iso(T) })).toBe(T - 600_000)
    expect(sessionWorkEndedAtMs({ process_status: 'stopped', status_history: moves(['stopped', T], ['idle', T - 600_000], ['running', T - 900_000]) })).toBe(T - 600_000)
  })
  it('Infinity while a turn runs; its last activity with no turn kept; unknown with nothing', () => {
    expect(sessionWorkEndedAtMs({ process_status: 'running' })).toBe(Number.POSITIVE_INFINITY)
    expect(sessionWorkEndedAtMs({ process_status: 'idle', status_history: moves(['idle', T - 5_000]), lastActiveAt: iso(T - 1_000) })).toBe(T - 1_000)
    expect(sessionWorkEndedAtMs({ process_status: 'idle' })).toBeUndefined()
    expect(sessionWorkEndedAtMs(null)).toBeUndefined()
  })
  it('several sessions: the latest, and unknown when any is unknown or there are none', () => {
    expect(allEndedAtMs([T - 5_000, T - 1_000])).toBe(T - 1_000)
    expect(allEndedAtMs([T - 5_000, undefined])).toBeUndefined()
    expect(allEndedAtMs([])).toBeUndefined()
  })
})
