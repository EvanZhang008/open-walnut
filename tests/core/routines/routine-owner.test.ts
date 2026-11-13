/**
 * The task, and so the project, a routine belongs to (src/core/routines/routine-owner.ts):
 * the Routines page groups by it on every surface. A routine delivering into a task
 * takes that task's project, a moved task is followed once, and everything else
 * (an Inbox task, a missing task, an executor that files its own work) has no
 * project, which every client shows as global. A store that cannot answer leaves
 * the jobs as they were rather than failing the list.
 */
import { describe, it, expect, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-routine-owner'))

import { routineTargetTaskId, withRoutineOwners, withRoutineOwner, type TaskLookup } from '../../../src/core/routines/routine-owner.js'

const tasks = [
  { id: 't-walnut', title: 'Release watch', project: 'Walnut' },
  { id: 't-inbox', title: 'Loose end', project: '' },
  { id: 't-old', title: 'Moved away', project: 'Old', transferred_to: 't-new' },
  { id: 't-new', title: 'Moved here', project: 'Marina' },
]

function lookup(): { fn: TaskLookup; calls: string[][] } {
  const calls: string[][] = []
  return {
    calls,
    fn: async (ids) => { calls.push([...ids]); return tasks.filter((t) => ids.includes(t.id)) },
  }
}

const session = (id: string, target: unknown) => ({ id, executor: { type: 'session', config: { target } } })

describe('routine owner', () => {
  it('names the target task of a session routine only', () => {
    expect(routineTargetTaskId(session('a', ' t-walnut '))).toBe('t-walnut')
    expect(routineTargetTaskId(session('b', ''))).toBeNull()
    expect(routineTargetTaskId(session('c', 42))).toBeNull()
    expect(routineTargetTaskId({ executor: { type: 'claude-code', config: { target: 't-walnut' } } })).toBeNull()
    expect(routineTargetTaskId({})).toBeNull()
  })

  it('gives each routine its task and project, one batch for all of them', async () => {
    const { fn, calls } = lookup()
    const jobs = [
      session('a', 't-walnut'),
      session('b', 't-walnut'),
      session('c', 't-inbox'),
      session('d', 't-gone'),
      { id: 'e', executor: { type: 'claude-code', config: {} } },
    ]
    const out = await withRoutineOwners(jobs, fn)
    expect(out.map((j) => (j as { owner?: unknown }).owner)).toEqual([
      { taskId: 't-walnut', title: 'Release watch', project: 'Walnut' },
      { taskId: 't-walnut', title: 'Release watch', project: 'Walnut' },
      { taskId: 't-inbox', title: 'Loose end', project: '' },
      undefined,
      undefined,
    ])
    expect(calls).toEqual([['t-walnut', 't-inbox', 't-gone']])
    // The stored jobs are never written to.
    expect(jobs.some((j) => 'owner' in j)).toBe(false)
  })

  it('follows a task moved to another host once', async () => {
    const { fn } = lookup()
    const job = await withRoutineOwner(session('a', 't-old'), fn)
    expect((job as { owner?: unknown }).owner).toEqual({ taskId: 't-new', title: 'Moved here', project: 'Marina' })
  })

  it('answers the jobs unchanged when the store cannot', async () => {
    const jobs = [session('a', 't-walnut')]
    const out = await withRoutineOwners(jobs, async () => { throw new Error('no store') })
    expect(out).toEqual(jobs)
  })

  it('asks nothing for a list with no task routines', async () => {
    const { fn, calls } = lookup()
    expect(await withRoutineOwners([{ id: 'x' }], fn)).toEqual([{ id: 'x' }])
    expect(calls).toEqual([])
  })
})
