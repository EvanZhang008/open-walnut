/**
 * The working line of a session whose own turn is over while its task's workers run: it names each
 * worker at work (web/src/components/sessions/workers-working.ts). 2026-11-23: a task parked on its
 * four workers read Working with no working line, and the user could not tell it was at work.
 */
import { describe, expect, it } from 'vitest'
import type { Task } from '@open-walnut/core'
import fs from 'node:fs'
import path from 'node:path'
import { WORKERS_VIEW_ID, workersWorkingLabel, workersWorkingOf } from '../../web/src/components/sessions/workers-working'

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

  it('is drawn from the workers alone: the lead reading Needs you or Waiting on its report keeps it', () => {
    // 2026-11-25, the user: "它刚才显示了之后又突然消失": it went whenever the lead itself read otherwise.
    for (const user_status of [{ state: 'needs', ask: 'Approve it?' }, { state: 'waiting', kind: 'lead' }, undefined]) {
      const lead = [{ ...parent, user_status } as Task, ...tasks.slice(1)]
      expect(workersWorkingOf(lead, 'sid-lead')).toHaveLength(2)
    }
  })

  it('shows nothing for a session no task holds', () => {
    expect(workersWorkingOf(tasks, 'sid-unknown')).toEqual([])
  })

  it('counts in words', () => {
    // His word for them, so the folded line says what they are (2026-11-25).
    expect(workersWorkingLabel(1)).toBe('1 subtask is working…')
    expect(workersWorkingLabel(3)).toBe('3 subtasks are working…')
  })
})

describe('the workers line starts folded at every count', () => {
  // 2026-11-25, the user: "defualt collapes bro." One to three workers were drawn as chips with no
  // toggle, and a list he once opened stayed open under the old view id.
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '../../web/src/components/sessions/SessionWorkingIndicator.tsx'), 'utf-8')
  const row = src.slice(src.indexOf('function WorkersWorkingRow'))
  it('open only once he opened it, and the toggle is always drawn', () => {
    expect(row).toMatch(/const open = picked \?\? false;/)
    expect(row).toMatch(/^\s+<DisclosureButton expanded=\{open\}[^\n]*data-testid="session-workers-toggle"/m)
    // No count decides whether it folds or whether the toggle shows.
    expect(row.slice(0, row.indexOf('</ChipGroup>'))).not.toMatch(/workers\.length\s*[<>]=?|\?\s*<DisclosureButton/)
  })
  it('his choice is kept per session under the id that started with this change', () => {
    expect(WORKERS_VIEW_ID).toBe('workers-shown')
    expect(row).toMatch(/usePageViewOf<boolean \| null>\('session', WORKERS_VIEW_ID, sessionId/)
  })
})

describe('the workers line shows under every shape of the working line', () => {
  // 2026-11-25: it showed only after the lead's own turn, so every turn of the lead (a worker
  // reporting back) took it away and the next turn end brought it back.
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '../../web/src/components/sessions/SessionWorkingIndicator.tsx'), 'utf-8')
  const body = src.slice(src.indexOf('export function SessionWorkingIndicator'), src.indexOf('/** The task\'s workers at work'))
  it('the workers are read whatever the session runs', () => {
    expect(body).toMatch(/useWorkersWorking\(sessionId\)/)
  })
  it('every return that draws a line draws the workers line too', () => {
    const returns = body.split(/\n\s+return /).slice(1).map((r) => r.slice(0, r.indexOf(';\n')))
    expect(returns.length).toBeGreaterThanOrEqual(3)
    for (const r of returns) expect(r, r.slice(0, 120)).toMatch(/workersRow/)
  })
})

