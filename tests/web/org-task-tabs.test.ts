/**
 * The Task view of an Org node (web/src/components/org/org-task-tabs.ts): four tabs named like
 * the home panel's status sections, each task in the tab of its own user status, the Needs you
 * tab holding the node's asks, a snoozed task never there (2026-10-31, the user).
 */
import { describe, it, expect } from 'vitest'
import type { Task } from '../../src/core/types.js'
import { buildOrgTree } from '../../src/core/org/org-tree.js'
import { buildChannels, type AlertProbe } from '../../web/src/components/org/org-channels-model.js'
import { ORG_TASK_TABS, ORG_TASK_TAB_LABELS, orgTaskTabs, taskTabNote } from '../../web/src/components/org/org-task-tabs.js'
import { STATUS_SECTION_LABELS } from '../../web/src/components/tasks/status-sections.js'

const NOW = Date.UTC(2026, 9, 31, 12, 0)
const at = (h: number) => new Date(NOW - h * 3_600_000).toISOString()
const t = (id: string, project: string, phase: Task['phase'], extra: Partial<Task> = {}): Task => ({
  id, title: `${id} title`, project, phase, status: phase === 'COMPLETE' ? 'done' : 'todo', priority: 'none',
  created_at: at(48), updated_at: at(1), ...extra,
}) as Task
const noAlerts: AlertProbe = () => null

const tasks: Task[] = [
  t('main', 'Ask Walnut', 'IN_PROGRESS', { org_role: 'main', walnut_agent: true }),
  t('wl', 'Walnut', 'IN_PROGRESS', { org_role: 'lead', title: 'Walnut lead', user_status: { state: 'working', now: 'Planning' } }),
  t('ask', 'Walnut', 'NEED_ACTION', { user_status: { state: 'needs', source: 'session', ask: 'Pick a layout' } }),
  t('run', 'Walnut', 'IN_PROGRESS', { user_status: { state: 'working', now: 'Writing the parser' } }),
  // Snoozed: the status says Waiting with its date (the one place, src/core/user-status.ts).
  t('snz', 'Walnut', 'NEED_ACTION', { start_date: '2026-11-02', user_status: { state: 'waiting', kind: 'time', waitingOn: 'Snoozed until 2026-11-02' } }),
  t('done1', 'Walnut', 'COMPLETE', { completed_at: at(3) }),
  t('old', 'Walnut', 'COMPLETE', { completed_at: at(24 * 9) }),
  t('tl', 'Garden', 'IN_PROGRESS', { org_role: 'lead', title: 'Garden lead', user_status: { state: 'working' } }),
  t('yard1', 'Garden', 'WAITING', { user_status: { state: 'waiting', waitingOn: 'the nursery' } }),
]

describe('the Task view tabs', () => {
  const { main, rows } = buildChannels(buildOrgTree(tasks), tasks, noAlerts)
  const walnut = rows.find((r) => r.project === 'Walnut')!

  it('carry the home panel\'s names, in its order', () => {
    expect(ORG_TASK_TABS.map((k) => ORG_TASK_TAB_LABELS[k])).toEqual(['Needs you', 'Working', 'Waiting / snoozed', 'Completed'])
    for (const k of ORG_TASK_TABS) expect(ORG_TASK_TAB_LABELS[k]).toBe(STATUS_SECTION_LABELS[k])
  })

  it('put each of a VP\'s tasks in the tab of its own status; a snoozed one waits, never needs you', () => {
    const tabs = orgTaskTabs(walnut, rows, tasks, NOW)
    expect(tabs.needs.map((a) => a.taskId)).toEqual(['ask'])
    // The VP's own task is its chat (only its ask would be a card), as the org tree counts.
    expect(tabs.working.map((x) => x.id)).toEqual(['run'])
    expect(tabs.waiting.map((x) => x.id)).toEqual(['snz'])
    // Completed within the week only.
    expect(tabs.done.map((x) => x.id)).toEqual(['done1'])
    expect(taskTabNote(tabs.waiting[0]!, 'waiting')).toBe('Snoozed until 2026-11-02')
    expect(taskTabNote(tasks.find((x) => x.id === 'run')!, 'working')).toBe('Writing the parser')
  })

  it('on Main cover every VP', () => {
    const tabs = orgTaskTabs(main, rows, tasks, NOW)
    expect(tabs.needs.map((a) => a.taskId)).toEqual(['ask'])
    expect(tabs.waiting.map((x) => x.id).sort()).toEqual(['snz', 'yard1'])
    expect(tabs.working.map((x) => x.id)).toEqual(['run'])
  })
})
