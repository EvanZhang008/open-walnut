/**
 * panelTaskCopy: the task a session panel shows (its title, Locate, the phase
 * controls, the read mark a click sends). The shared task store wins; the
 * panel's REST copy stands in only for the task the session still names. Until
 * 2026-10-11 it stood for any task: after a delete, every click in the panel
 * marked the deleted task read (PATCH, 500, an error card). The browser half:
 * test 11 of tests/e2e/browser/session-header-chips-hold-place.spec.ts (it also
 * pins that the panel passes the resolved record's task, which this cannot see).
 */
import { describe, expect, it } from 'vitest'
import type { Task } from '@open-walnut/core'
import { panelTaskCopy } from '../../web/src/components/sessions/panel-task-copy'

const task = (id: string, extra: Partial<Task> = {}) => ({ id, title: `Task ${id}`, ...extra }) as Task

describe('panelTaskCopy', () => {
  it('the store copy wins, and it is the same object (a store change shows in the same frame)', () => {
    const stored = task('t1', { title: 'Renamed on the board', ext: { k: 1 } as Task['ext'] })
    expect(panelTaskCopy(stored, task('t1', { title: 'Old REST title' }), 't1')).toBe(stored)
    expect(panelTaskCopy(stored, null, 't1')).toBe(stored)
  })

  it('a task the store does not carry: the REST copy, while the session names that task', () => {
    const fetched = task('t1')
    expect(panelTaskCopy(null, fetched, 't1')).toBe(fetched)
  })

  it('the task deleted: the session names none, and the REST copy of the deleted task is dropped', () => {
    expect(panelTaskCopy(null, task('t-deleted'), undefined)).toBeNull()
    expect(panelTaskCopy(null, null, undefined)).toBeNull()
  })

  it('the session re-pointed by a merge: the victim copy stands for nothing, not even its ext', () => {
    expect(panelTaskCopy(null, task('t-victim', { ext: { k: 1 } as Task['ext'] }), 't-survivor')).toBeNull()
    const survivor = task('t-survivor')
    const shown = panelTaskCopy(survivor, task('t-victim', { ext: { k: 1 } as Task['ext'] }), 't-survivor')
    expect(shown).toBe(survivor)
    expect(shown?.ext).toBeUndefined()
  })

  it('the REST copy of the same task gives the store copy the ext the list payload drops', () => {
    const stored = task('t1', { title: 'Store title' })
    const ext = { k: 1 } as Task['ext']
    expect(panelTaskCopy(stored, task('t1', { title: 'REST title', ext }), 't1')).toEqual({ ...stored, ext })
  })
})
