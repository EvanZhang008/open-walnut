/**
 * The standing status check (src/core/status-consistency.ts): each kind of mismatch it finds,
 * and what it leaves alone (a settling task, a transient status, a live prompt on a snoozed task).
 */
import { describe, expect, it } from 'vitest'
import { findStatusMismatches } from '../../src/core/status-consistency.js'
import type { UserStatus } from '../../src/core/user-status.js'
import type { Task } from '../../src/core/types.js'

const NOW = Date.parse('2026-10-31T12:00:00Z')
const OLD = new Date(NOW - 3_600_000).toISOString()

function task(id: string, over: Partial<Task> = {}): Task {
  return {
    id, title: `${id} title`, phase: 'NEED_ACTION', status: 'todo', project: 'Acme',
    updated_at: OLD, phase_changed_at: OLD, ...over,
  } as Task
}

const needs: UserStatus = { state: 'needs', source: 'session', ask: 'Pick a plan' }
const waitingCi: UserStatus = { state: 'waiting', kind: 'outside', waitingOn: 'The CI run' }

async function check(tasks: Task[], derive: (t: Task) => UserStatus = (t) => t.user_status!, outside = false) {
  return findStatusMismatches(tasks, { derive, outside: async () => outside }, NOW)
}

describe('findStatusMismatches', () => {
  it('a task whose stored status matches its facts is clean', async () => {
    expect(await check([task('a', { user_status: needs })])).toEqual([])
  })

  it('an open task with no stored status is missing', async () => {
    expect((await check([task('a')], () => needs)).map((m) => m.kind)).toEqual(['missing'])
  })

  it('a stored state the facts no longer give is drift, and says both sides', async () => {
    const [m] = await check([task('a', { user_status: needs })], () => waitingCi)
    expect(m).toMatchObject({ kind: 'drift', taskId: 'a' })
    expect(m!.detail).toBe('stored needs, the facts say waiting/outside')
  })

  it('a snoozed task stored as Needs you is snoozed-needs, its own date or an ancestor\'s', async () => {
    const own = task('a', { user_status: needs, start_date: '2026-11-13' })
    expect((await check([own])).map((m) => m.kind)).toEqual(['snoozed-needs'])
    const parent = task('p', { user_status: { state: 'waiting', kind: 'time', snoozed: { until: '2026-11-13' } }, start_date: '2026-11-13', phase: 'WAITING' })
    const child = task('c', { user_status: needs, parent_task_id: 'p' })
    expect((await check([parent, child], (t) => t.user_status!, true)).map((m) => [m.kind, m.taskId])).toEqual([['snoozed-needs', 'c']])
  })

  it('a live prompt on a snoozed task and Main are not snoozed-needs', async () => {
    const prompt = task('a', { user_status: { state: 'needs', source: 'prompt' }, start_date: '2026-11-13' })
    const main = task('m', { user_status: needs, start_date: '2026-11-13', org_role: 'main' })
    expect(await check([prompt, main])).toEqual([])
  })

  it('a start date already past is no snooze', async () => {
    expect(await check([task('a', { user_status: needs, start_date: '2026-10-01' })])).toEqual([])
  })

  it('a WAITING task with nothing outside is parked-on-nothing; told only when its own report parked it', async () => {
    const byPerson = task('a', { phase: 'WAITING', user_status: { state: 'waiting', kind: 'stuck' } })
    const byReport = task('b', {
      phase: 'WAITING', user_status: { state: 'waiting', kind: 'stuck' },
      status_report: { state: 'waiting', at: new Date(NOW - 3_000_000).toISOString() } as Task['status_report'],
    })
    const found = await check([byPerson, byReport])
    expect(found.map((m) => [m.kind, m.taskId, !!m.notify])).toEqual([['parked-on-nothing', 'a', false], ['parked-on-nothing', 'b', true]])
    expect(found[1]!.parkedAt).toBe(OLD)
  })

  it('a WAITING task of a team stopped in one step is not told: its triggers are paused on purpose', async () => {
    const root = task('r', { phase: 'WAITING', user_status: waitingCi, team_stop: { at: OLD, members: [{ id: 'w' }] } as unknown as Task['team_stop'] })
    const worker = task('w', { phase: 'WAITING', user_status: { state: 'waiting', kind: 'stuck' } })
    expect(await check([root, worker], (t) => t.user_status!, false).then((m) => m.filter((x) => x.taskId === 'w'))).toEqual([])
  })

  it('a WAITING task with an outside wait, a lead, or a snooze is not parked-on-nothing', async () => {
    const ci = task('a', { phase: 'WAITING', user_status: waitingCi })
    const lead = task('l', { phase: 'WAITING', user_status: waitingCi, org_role: 'lead' })
    expect(await check([ci], (t) => t.user_status!, true)).toEqual([])
    expect(await check([lead])).toEqual([])
    const snoozed = task('s', { phase: 'WAITING', start_date: '2026-11-13', user_status: { state: 'waiting', kind: 'time', snoozed: { until: '2026-11-13' } } })
    expect(await check([snoozed])).toEqual([])
  })

  it('leaves alone a task still settling, a transient status, and a completed one', async () => {
    const fresh = task('a', { updated_at: new Date(NOW - 10_000).toISOString() })
    const transient = task('b', { user_status: { ...needs, transient: true } })
    const done = task('c', { phase: 'COMPLETE', status: 'done' })
    expect(await check([fresh, transient, done], () => waitingCi)).toEqual([])
  })
})
