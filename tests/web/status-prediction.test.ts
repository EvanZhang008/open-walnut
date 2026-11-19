/**
 * The page's prediction of a status the server derives (web/src/hooks/status-prediction.ts).
 * 2026-11-19: the dot, the status pill and every Needs you count read `user_status`, which no
 * optimistic write set, so a click showed on its control at once and on every badge a server
 * pass later (20 to 35 s on a thread acted on in the Org page).
 */
import { describe, expect, it } from 'vitest'
import type { Task } from '../../src/core/types'
import type { UserStatus } from '../../src/core/user-status'
import { overPrediction, predictedForPhase, statusKey, statusWithThreads, type StatusPrediction } from '../../web/src/hooks/status-prediction'

const row = (over: Partial<Task>): Task => ({ id: 't1', title: 'T', phase: 'IN_PROGRESS', status: 'in_progress', ...over } as Task)
const needs: UserStatus = { state: 'needs', ask: 'Pick one', source: 'session' } as UserStatus
const working: UserStatus = { state: 'working' } as UserStatus

describe('overPrediction: who speaks for the status', () => {
  const predictions = new Map<string, StatusPrediction>([['t1', { base: statusKey(needs), predicted: working }]])

  it('a server row that still carries the old status shows the prediction', () => {
    const seen = overPrediction(row({ user_status: needs }), predictions)
    expect(seen.answered).toBe(false)
    expect(seen.task.user_status).toEqual(working)
  })

  it('a server row with a newer status is the answer, agreeing or not', () => {
    const agree = overPrediction(row({ user_status: { ...working, now: 'Reading the diff' } as UserStatus }), predictions)
    expect(agree.answered).toBe(true)
    expect(agree.task.user_status).toMatchObject({ state: 'working', now: 'Reading the diff' })
    const disagree = overPrediction(row({ user_status: { state: 'waiting', kind: 'outside' } as UserStatus }), predictions)
    expect(disagree.answered).toBe(true)
    expect(disagree.task.user_status?.state).toBe('waiting')
  })

  it('a status the server removed is an answer too', () => {
    expect(overPrediction(row({}), predictions).answered).toBe(true)
  })

  it('a row with no prediction is left alone', () => {
    const other = row({ id: 't2', user_status: needs })
    expect(overPrediction(other, predictions)).toEqual({ task: other, answered: false })
  })
})

describe('predictedForPhase: what a phase set by hand reads as', () => {
  it('reads the phase the way the server derives it', () => {
    expect(predictedForPhase(row({ user_status: working }), 'NEED_ACTION')?.state).toBe('needs')
    // Working is a running turn only: In progress set by hand waits (with no session, nobody started it).
    expect(predictedForPhase(row({ phase: 'NEED_ACTION', user_status: needs }), 'IN_PROGRESS')).toEqual({ state: 'waiting', kind: 'not-started' })
    expect(predictedForPhase(row({ phase: 'NEED_ACTION', user_status: needs, session_id: 's1' }), 'IN_PROGRESS')).toEqual({ state: 'waiting' })
    expect(predictedForPhase(row({ phase: 'NEED_ACTION', user_status: needs }), 'TODO')).toEqual({ state: 'waiting', kind: 'not-started' })
  })

  it('a turn running now stays Working whatever phase a hand sets', () => {
    const running = row({ user_status: working, session_id: 's1', session_status: { process_status: 'running' } } as Partial<Task>)
    expect(predictedForPhase(running, 'NEED_ACTION')).toBe(running.user_status)
    expect(predictedForPhase(running, 'WAITING')).toBe(running.user_status)
  })

  it('a not-started row set In progress with no session keeps reading Not started', () => {
    const fresh = row({ phase: 'TODO', user_status: { state: 'waiting', kind: 'not-started', waitingOn: 'Not started yet' } as UserStatus })
    expect(predictedForPhase(fresh, 'IN_PROGRESS')).toBe(fresh.user_status)
  })

  it('drops the ask the old status carried: the phase moved past it', () => {
    const next = predictedForPhase(row({ phase: 'NEED_ACTION', user_status: needs }), 'IN_PROGRESS')
    expect(next).not.toHaveProperty('ask')
    expect(next).not.toHaveProperty('source')
  })

  it('keeps an Org node\'s Threads counts', () => {
    const threads = { shown: 2, needs: 1, title: 'Ship it', id: 'th-1' }
    const next = predictedForPhase(row({ user_status: { ...working, threads } as UserStatus }), 'NEED_ACTION')
    expect(next?.threads).toEqual(threads)
  })

  it('predicts nothing where the server does not follow the phase: a snoozed row, an org node, a prompt waiting', () => {
    const snoozed = { state: 'waiting', snoozed: true } as unknown as UserStatus
    expect(predictedForPhase(row({ phase: 'TODO', user_status: snoozed }), 'NEED_ACTION')).toBe(snoozed)
    expect(predictedForPhase(row({ phase: 'TODO', user_status: needs, org_role: 'lead' } as Partial<Task>), 'IN_PROGRESS')).toBe(needs)
    const prompt = row({ phase: 'NEED_ACTION', user_status: needs, session_status: { process_status: 'stopped', pendingPermissionTool: 'Bash' } } as unknown as Partial<Task>)
    expect(predictedForPhase(prompt, 'IN_PROGRESS')).toBe(needs)
  })

  it('predicts nothing when the phase does not move, or for a completion (done is read off the phase)', () => {
    const same = row({ user_status: working })
    expect(predictedForPhase(same, 'IN_PROGRESS')).toBe(same.user_status)
    expect(predictedForPhase(same, 'COMPLETE')).toBe(same.user_status)
  })

  it('a waiting row whose turn is to read does not stay "to read" under a new phase', () => {
    const toRead = { state: 'waiting', toRead: 'turn', waitingOn: 'its turn' } as unknown as UserStatus
    expect(predictedForPhase(row({ phase: 'NEED_ACTION', user_status: toRead }), 'WAITING')).toEqual({ state: 'waiting' })
  })
})

describe('statusWithThreads: the node row counts the list as drawn', () => {
  const at = '2026-11-19T10:00:00.000Z'
  const thread = (id: string, over: Record<string, unknown> = {}) =>
    ({ id, title: `Thread ${id}`, state: 'needs', updatedAt: at, createdAt: at, messages: [], ...over }) as never
  const status = { state: 'needs', source: 'thread', threads: { shown: 2, needs: 2, title: 'Thread a', id: 'a' } } as unknown as UserStatus

  it('a closed thread leaves the count in the same frame', () => {
    const next = statusWithThreads(status, [thread('a', { closed: { how: 'done', at, by: 'human' } }), thread('b')])
    expect(next?.threads).toMatchObject({ shown: 1, needs: 1, id: 'b' })
  })

  it('the last one closed removes the counts, as the server stores it', () => {
    const next = statusWithThreads(status, [thread('a', { closed: { how: 'done', at, by: 'human' } })])
    expect(next).not.toHaveProperty('threads')
    expect(next?.state).toBe('needs')
  })

  it('a node whose counts a prediction took away is counted up again when told it is counted', () => {
    const none = { state: 'working' } as UserStatus
    expect(statusWithThreads(none, [], true)).toEqual(none)
    expect(statusWithThreads(none, [], false)).toBe(none)
  })

  it('a status that carries no Threads counts is not the page\'s to count', () => {
    expect(statusWithThreads(working, [thread('a')])).toBe(working)
    expect(statusWithThreads(undefined, [thread('a')])).toBeUndefined()
  })
})
