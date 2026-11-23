/**
 * The working line of a session whose own turn is over while its task's workers run: it names each
 * worker at work (web/src/components/sessions/workers-working.ts). 2026-11-23: a task parked on its
 * four workers read Working with no working line, and the user could not tell it was at work.
 */
import { describe, expect, it } from 'vitest'
import type { Task } from '@open-walnut/core'
import { workersWorkingLabel, workersWorkingOf } from '../../web/src/components/sessions/workers-working'

const row = (id: string, extra: Partial<Task>): Task => ({ id, title: `Task ${id}`, phase: 'IN_PROGRESS', status: 'todo', session_ids: [], ...extra }) as Task

describe('workersWorkingOf', () => {
  const parent = row('lead', { phase: 'WAITING', session_id: 'sid-lead', user_status: { state: 'working', waitingOn: 'Its workers are working' } as never })
  const tasks = [
    parent,
    row('b', { parent_task_id: 'lead', user_status: { state: 'working' } as never }),
    row('c', { parent_task_id: 'lead', user_status: { state: 'working' } as never }),
    row('a1', { parent_task_id: 'lead', user_status: { state: 'waiting', kind: 'lead' } as never }),
    row('done', { parent_task_id: 'lead', phase: 'COMPLETE', status: 'done' }),
    row('other', { parent_task_id: 'someone-else', user_status: { state: 'working' } as never }),
  ]

  it('names the workers at work, and only those', () => {
    expect(workersWorkingOf(tasks, 'sid-lead')).toEqual([{ id: 'b', title: 'Task b' }, { id: 'c', title: 'Task c' }])
  })

  it('shows nothing under an earlier session of the task', () => {
    const moved = [{ ...parent, session_id: 'sid-new', session_ids: ['sid-lead'] } as Task, ...tasks.slice(1)]
    expect(workersWorkingOf(moved, 'sid-lead')).toEqual([])
    expect(workersWorkingOf(moved, 'sid-new')).toHaveLength(2)
  })

  it('shows nothing while the task itself does not read Working', () => {
    const needs = [{ ...parent, user_status: { state: 'needs', ask: 'Approve it?' } } as Task, ...tasks.slice(1)]
    expect(workersWorkingOf(needs, 'sid-lead')).toEqual([])
  })

  it('shows nothing for a session no task holds', () => {
    expect(workersWorkingOf(tasks, 'sid-unknown')).toEqual([])
  })

  it('counts in words', () => {
    expect(workersWorkingLabel(1)).toBe('1 worker is working…')
    expect(workersWorkingLabel(3)).toBe('3 workers are working…')
  })
})
