/**
 * The quick bar in a focus space (experiment focus_workspace): its people list keeps the CEO,
 * the VPs and the tasks inside the focus and only counts the rest (quick-people.ts focusPeople),
 * so a line can still be dropped out to a VP without the other tasks showing.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const flags = { focus_workspace: true }
let active: { name: string; scope: { projects?: string[]; tasks?: string[] } } | null = null
const tasks: Record<string, { id: string; project: string; parent_task_id?: string }> = {
  t1: { id: 't1', project: 'Walnut' },
  t2: { id: 't2', project: 'Marina' },
  t3: { id: 't3', project: 'Marina', parent_task_id: 't1' },
}
vi.mock('../../../src/core/config-manager.js', () => ({ getConfig: async () => ({ experimental: { ...flags } }) }))
vi.mock('../../../src/core/focus-spaces/active.js', () => ({ getActiveFocus: async () => active }))
vi.mock('../../../src/core/task-manager.js', () => ({ scopeTaskLookup: async () => (id: string) => tasks[id] }))

const { focusPeople } = await import('../../../src/web/routes/quick-people.js')

const person = (id: string, kind: 'ceo' | 'vp' | 'task') => ({ id, title: id, kind, project: '', state: 'working', stateLabel: 'Working', line: '', needs: 0 })
const PEOPLE = [person('main', 'ceo'), person('vp-marina', 'vp'), person('t1', 'task'), person('t2', 'task'), person('t3', 'task')]

beforeEach(() => { flags.focus_workspace = true; active = null })

describe('focusPeople', () => {
  it('without a focus, the list is as it was', async () => {
    expect(await focusPeople(PEOPLE)).toEqual({ people: PEOPLE })
  })

  it('in a focus: CEO and VPs stay, tasks inside follow, the rest is only counted', async () => {
    active = { name: 'Walnut work', scope: { projects: ['Walnut'] } }
    const out = await focusPeople(PEOPLE)
    // t3 is in Marina but a subtask of t1: inside.
    expect(out.people.map((p) => p.id)).toEqual(['main', 'vp-marina', 't1', 't3'])
    expect(out.focus).toEqual({ name: 'Walnut work', outside: 1 })
  })

  it('with the experiment off, a stale focus changes nothing', async () => {
    flags.focus_workspace = false
    active = { name: 'Walnut work', scope: { projects: ['Walnut'] } }
    expect(await focusPeople(PEOPLE)).toEqual({ people: PEOPLE })
  })
})
