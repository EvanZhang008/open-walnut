/**
 * The focus-scope rule (src/core/focus-spaces/scope.ts) and how quiet reads it
 * (quietSuppresses): a scope holds its named tasks, their subtasks at any depth and the tasks
 * of its named projects; a quiet hold with a scope lets those through and silences the rest.
 */
import { describe, expect, it } from 'vitest'
import { normalizeScope, scopeIsEmpty, taskInScope, type ScopeTask } from '../../../src/core/focus-spaces/scope.js'
import { quietSuppresses } from '../../../src/core/quiet/quiet-state.js'
import type { QuietState } from '../../../src/core/event-types.js'

const rows: Record<string, ScopeTask> = {
  interview: { id: 'interview', project: 'Personal' },
  mock: { id: 'mock', project: 'Personal', parent_task_id: 'interview' },
  mockDeep: { id: 'mockDeep', project: 'Personal', parent_task_id: 'mock' },
  upgrade: { id: 'upgrade', project: 'Acme Infra' },
  inbox: { id: 'inbox', project: '' },
  loopA: { id: 'loopA', project: 'X', parent_task_id: 'loopB' },
  loopB: { id: 'loopB', project: 'X', parent_task_id: 'loopA' },
}
const lookup = (id: string) => rows[id]

describe('taskInScope', () => {
  it('holds a named task and its subtasks at any depth, nothing else', () => {
    const scope = { tasks: ['interview'] }
    expect(taskInScope(scope, 'interview', lookup)).toBe(true)
    expect(taskInScope(scope, 'mockDeep', lookup)).toBe(true)
    expect(taskInScope(scope, 'upgrade', lookup)).toBe(false)
    expect(taskInScope(scope, undefined, lookup)).toBe(false)
  })

  it('holds the tasks of a named project, case-insensitively, the Inbox included', () => {
    expect(taskInScope({ projects: ['acme infra'] }, 'upgrade', lookup)).toBe(true)
    expect(taskInScope({ projects: [''] }, 'inbox', lookup)).toBe(true)
    expect(taskInScope({ projects: [''] }, 'interview', lookup)).toBe(false)
    // The Inbox is one project whichever way a row spells it.
    expect(taskInScope({ projects: ['Inbox'] }, 'inbox', lookup)).toBe(true)
  })

  it('stops on a parent cycle and on an unknown task', () => {
    expect(taskInScope({ tasks: ['zzz'] }, 'loopA', lookup)).toBe(false)
    expect(taskInScope({ tasks: ['interview'] }, 'missing', lookup)).toBe(false)
  })

  it('normalizes what it stores: trimmed, de-duplicated, capped, junk dropped', () => {
    expect(normalizeScope({ tasks: [' a ', 'a', '', 3], projects: ['P', 'P', ''] })).toEqual({ tasks: ['a'], projects: ['P', ''] })
    expect(normalizeScope({ tasks: Array.from({ length: 80 }, (_, i) => `t${i}`) }).tasks).toHaveLength(50)
    expect(scopeIsEmpty(normalizeScope('junk'))).toBe(true)
  })
})

describe('quietSuppresses with a scope', () => {
  const hold = (extra: object = {}) => ({ source: 'plugin:walnut-rhythm', since: 1, ...extra })
  const state = (...holds: object[]): QuietState => ({ active: true, allowPermissions: true, holds: holds as QuietState['holds'] })

  it('lets a task inside the scope through and holds the rest', () => {
    const q = state(hold({ scope: { tasks: ['interview'] } }))
    expect(quietSuppresses(q, { taskId: 'mock', lookup })).toBe(false)
    expect(quietSuppresses(q, { taskId: 'upgrade', lookup })).toBe(true)
    expect(quietSuppresses(q, {})).toBe(true)
  })

  it('needs every live hold to let it through', () => {
    const q = state(hold({ scope: { tasks: ['interview'] } }), { source: 'user', since: 2 })
    expect(quietSuppresses(q, { taskId: 'interview', lookup })).toBe(true)
  })

  it('keeps permission asks as before: through unless a hold forbids them', () => {
    expect(quietSuppresses(state(hold()), { permission: true })).toBe(false)
    expect(quietSuppresses({ ...state(hold({ allowPermissions: false })), allowPermissions: false }, { permission: true })).toBe(true)
    expect(quietSuppresses({ active: true, allowPermissions: true, holds: [] }, {})).toBe(true)
  })
})

describe('focusAppMode: how a plugin App works in a space', () => {
  it('follows the space\'s own choice, else the manifest; undeclared is hidden until shown, then Main\'s', async () => {
    const { focusAppMode } = await import('../../../src/core/focus-spaces/scope.js')
    expect(focusAppMode(undefined, 'scoped')).toBe('isolated')
    expect(focusAppMode(undefined, 'shared')).toBe('inherit')
    expect(focusAppMode(undefined, undefined)).toBe('off')
    expect(focusAppMode('off', 'scoped')).toBe('off')
    expect(focusAppMode('inherit', 'scoped')).toBe('inherit')
    // A plugin that keeps no state per space cannot start fresh in one.
    expect(focusAppMode('isolated', undefined)).toBe('inherit')
  })
})
