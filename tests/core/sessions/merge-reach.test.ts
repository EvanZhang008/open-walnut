/**
 * How far a session on another host reaches with task_merge
 * (src/core/sessions/merge-reach.ts): its own task, its descendants, and the
 * tasks in its own folder. Pure: the parent chain is read through a fake.
 */
import { describe, it, expect } from 'vitest'
import { mergeOutOfReach } from '../../../src/core/sessions/merge-reach.js'
import type { CallerPlacement } from '../../../src/core/sessions/caller-placement.js'

interface T { id: string; title: string; project: string; group_id?: string; parent_task_id?: string }
const SESSION = { id: 's-1', host: 'devbox', cwd: '/repo' }
const worker = (group_id?: string): CallerPlacement => ({
  kind: 'worker', task: { id: 'leader', title: 'Triage board', project: 'Marina', ...(group_id ? { group_id } : {}) }, session: SESSION,
})
const store = (rows: T[]) => async (id: string) => rows.find((r) => r.id === id)
const t = (id: string, over: Partial<T> = {}): T => ({ id, title: id, project: 'Marina', ...over })

describe('mergeOutOfReach', () => {
  it('its own task and its subtasks, at any depth, are within reach', async () => {
    const rows = [t('leader'), t('child', { parent_task_id: 'leader' }), t('grandchild', { parent_task_id: 'child' })]
    expect(await mergeOutOfReach(worker(), rows, store(rows))).toBeUndefined()
  })

  it('tasks in its own folder are within reach; the same folder id in another project is not', async () => {
    const rows = [t('a', { group_id: 'g_1' }), t('b', { group_id: 'g_1' }), t('c', { group_id: 'g_1', project: 'Other' })]
    expect(await mergeOutOfReach(worker('g_1'), rows.slice(0, 2), store(rows))).toBeUndefined()
    const out = await mergeOutOfReach(worker('g_1'), rows, store(rows))
    expect(out?.ids).toEqual(['c'])
    expect(out?.message).toContain('in its folder (g_1)')
  })

  it('a task that is neither is named, and the message says what is reachable', async () => {
    const rows = [t('own', { parent_task_id: 'leader' }), t('stranger'), t('other-folder', { group_id: 'g_2' })]
    const out = await mergeOutOfReach(worker(), rows, store(rows))
    expect(out?.ids).toEqual(['stranger', 'other-folder'])
    expect(out?.message).toContain('stranger, other-folder are not a subtask of "Triage board" (leader)')
    expect(out?.message).not.toContain('in its folder')
  })

  it('a caller with no task of its own reaches nothing', async () => {
    const rows = [t('a'), t('b')]
    for (const caller of [
      { kind: 'human' }, { kind: 'external' }, { kind: 'unknown' }, { kind: 'untracked', session: SESSION },
    ] as CallerPlacement[]) {
      const out = await mergeOutOfReach(caller, rows, store(rows))
      expect(out?.ids, caller.kind).toEqual(['a', 'b'])
      expect(out?.message).toContain('needs a session with a task of its own')
    }
  })

  it('a Personal AI ask is placed from its task like a worker', async () => {
    const ask: CallerPlacement = { kind: 'ask', task: { id: 'ask', title: 'Ask', project: 'Ask Walnut' }, session: SESSION }
    const rows = [t('x', { parent_task_id: 'ask' })]
    expect(await mergeOutOfReach(ask, rows, store(rows))).toBeUndefined()
  })

  it('a missing parent or a cycle ends the walk as out of reach, never hangs', async () => {
    const rows = [t('orphan', { parent_task_id: 'gone' }), t('p', { parent_task_id: 'q' }), t('q', { parent_task_id: 'p' })]
    const out = await mergeOutOfReach(worker(), rows, store(rows))
    expect(out?.ids).toEqual(['orphan', 'p', 'q'])
  })
})
