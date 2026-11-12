/**
 * The Task view of an Org node (web/src/components/org/org-task-tabs.ts): four tabs named like
 * the home panel's status sections, each task in the tab of its own user status, the Needs you
 * tab holding the node's asks and its results and answers to look at (no To read tab,
 * 2026-11-03), a snoozed task never there (2026-10-31, the user).
 */
import { describe, it, expect } from 'vitest'
import type { Task } from '../../src/core/types.js'
import { buildOrgTree } from '../../src/core/org/org-tree.js'
import { buildChannels, type AlertProbe } from '../../web/src/components/org/org-channels-model.js'
import { ORG_RAIL_TABS, ORG_TASK_TABS, ORG_TASK_TAB_LABELS, TAB_DOT, allTasksSections, isSectionFlips, orgTaskTabs, sectionFor, sectionOpen, stateTab, taskTabNote } from '../../web/src/components/org/org-task-tabs.js'
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
  // To read: nothing asked, only its result (2026-11-02); an older server stored it as Waiting with toRead.
  t('rd', 'Walnut', 'NEED_ACTION', { user_status: { state: 'read', toRead: 'result', waitingOn: 'The result is ready' } }),
  t('rd-old', 'Walnut', 'NEED_ACTION', { updated_at: at(2), user_status: { state: 'waiting', toRead: 'answer', waitingOn: 'It answered your question' } }),
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
    expect(ORG_TASK_TABS.map((k) => ORG_TASK_TAB_LABELS[k])).toEqual(['Needs you', 'Working', 'Waiting / snoozed', 'Not started', 'Completed'])
    for (const k of ORG_TASK_TABS) expect(ORG_TASK_TAB_LABELS[k]).toBe(STATUS_SECTION_LABELS[k])
    expect(ORG_RAIL_TABS).not.toContain('read')
    expect(Object.keys(TAB_DOT)).not.toContain('read')
  })

  it('All tasks draws every tab as a section in the rail\'s order, empty ones left out', () => {
    const tabs = orgTaskTabs(walnut, rows, tasks, NOW)
    const secs = allTasksSections(tabs, tabs.needs)
    const order = ORG_RAIL_TABS.filter((t) => secs.some((x) => x.tab === t))
    expect(secs.map((x) => x.tab)).toEqual(order)
    for (const x of secs) expect(x.tasks.length + x.alerts.length).toBeGreaterThan(0)
    // Every card is under Needs you, and no task is drawn twice.
    expect(secs.find((x) => x.tab === 'needs')?.alerts.length ?? 0).toBe(tabs.needs.length)
    const ids = secs.flatMap((x) => x.tasks.map((t) => t.id))
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('a Needs you section with only approvals still shows; no work at all shows no section', () => {
    const none = { watching: [], needs: [], working: [], waiting: [], notstarted: [], done: [] }
    expect(allTasksSections(none, [])).toEqual([])
    expect(allTasksSections(none, [], 2).map((x) => x.tab)).toEqual(['needs'])
  })

  it('a watched task shows once: Watching, else its ask\'s card, else Completed this week; an old finished one stays in Watching', () => {
    const mk = (id: string, state: string, extra: Record<string, unknown> = {}) => ({ id, title: id, project: 'P', phase: state === 'done' ? 'COMPLETE' : 'IN_PROGRESS', user_status: { state }, ...extra }) as never
    const w = mk('w', 'working', { watched_at: '2026-11-01T00:00:00Z' })
    const asked = mk('asked', 'needs', { watched_at: '2026-11-01T00:00:00Z' })
    const recent = mk('recent', 'done', { watched_at: '2026-11-01T00:00:00Z' })
    const old = mk('old', 'done', { watched_at: '2026-11-01T00:00:00Z' })
    const tabs = { watching: [w, asked, recent, old], needs: [], working: [w, asked], waiting: [], notstarted: [], done: [recent] }
    const secs = allTasksSections(tabs, [{ taskId: 'asked' } as never])
    const of = (tab: string) => secs.find((x) => x.tab === tab)?.tasks.map((t) => t.id) ?? []
    expect(of('watching')).toEqual(['w', 'old'])
    expect(of('working')).toEqual([])
    expect(of('done')).toEqual(['recent'])
    // A header count whose tasks are all watched leads to Watching; one with nothing drawn leads nowhere.
    expect(sectionFor('working', secs)).toBe('watching')
    expect(sectionFor('done', secs)).toBe('done')
    expect(sectionFor('waiting', allTasksSections({ ...tabs, watching: [] }, []))).toBeNull()
  })

  it('what is in front of the user opens, what waits or is done folds, and a flip turns one over', () => {
    expect(ORG_RAIL_TABS.filter((t) => sectionOpen(t, []))).toEqual(['watching', 'needs', 'working'])
    expect(sectionOpen('done', ['done'])).toBe(true)
    expect(sectionOpen('needs', ['needs'])).toBe(false)
    expect(isSectionFlips(['done', 'waiting'])).toBe(true)
    expect(isSectionFlips(['team'])).toBe(false)
    expect(isSectionFlips('done')).toBe(false)
  })

  it('put each of a VP\'s tasks in the tab of its own status; a snoozed one waits, never needs you', () => {
    const tabs = orgTaskTabs(walnut, rows, tasks, NOW)
    // Needs you holds the asks and the results and answers to look at, each with its line's category.
    expect(tabs.needs.map((a) => [a.taskId, a.category, a.ask])).toEqual([
      ['ask', 'decide', 'Pick a layout'], ['rd', 'close', 'The result is ready'], ['rd-old', 'look', 'It answered your question'],
    ])
    expect(Object.keys(tabs)).not.toContain('read')
    // The VP's own task is its chat (only its ask would be a card), as the org tree counts.
    expect(tabs.working.map((x) => x.id)).toEqual(['run'])
    expect(tabs.waiting.map((x) => x.id)).toEqual(['snz'])
    // A watched To read row wears Needs you and its line.
    const rd = tasks.find((x) => x.id === 'rd')!
    expect(stateTab(rd)).toBe('needs')
    expect(taskTabNote(rd, 'needs')).toBe('Can close: The result is ready')
    expect(taskTabNote(tasks.find((x) => x.id === 'ask')!, 'needs')).toBe('Decide: Pick a layout')
    // Completed within the week only.
    expect(tabs.done.map((x) => x.id)).toEqual(['done1'])
    expect(taskTabNote(tabs.waiting[0]!, 'waiting')).toBe('Snoozed until 2026-11-02')
    expect(taskTabNote(tasks.find((x) => x.id === 'run')!, 'working')).toBe('Writing the parser')
  })

  it('on Main cover every VP', () => {
    const tabs = orgTaskTabs(main, rows, tasks, NOW)
    expect(tabs.needs.map((a) => a.taskId)).toEqual(['ask', 'rd', 'rd-old'])
    expect(tabs.waiting.map((x) => x.id).sort()).toEqual(['snz', 'yard1'])
    expect(tabs.working.map((x) => x.id)).toEqual(['run'])
  })
})
