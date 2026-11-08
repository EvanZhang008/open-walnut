import { describe, expect, it } from 'vitest';
import type { Task } from '@open-walnut/core';
import { ageTags, buildSortProjects, buildSortQueue, DEFAULT_SORT_FILTER, isSnoozed, isSortFilter, projectSnoozeTargets, snoozePresets, snoozeUntilText, taskAges, tierCounts, type SortFilter } from '../../web/src/components/tasks/quick-sort-model';

const NOW = Date.parse('2026-11-07T20:00:00Z');
function task(id: string, fields: Partial<Task> = {}): Task {
  return { id, title: id, project: 'Alpha', phase: 'TODO', status: 'todo', source: 'local', priority: 'none', created_at: '2026-10-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z', ...fields } as Task;
}
const ids = (items: { task: Task }[]) => items.map(i => i.task.id);
const f = (fields: Partial<SortFilter> = {}): SortFilter => ({ tiers: [], project: null, folder: null, idleDays: 0, ...fields });
const unsorted = f({ tiers: ['unpinned'] });

describe('Sort queue', () => {
  it('takes open work the filter keeps, least recently acted on first, and leaves out org nodes, asks, done and snoozed tasks', () => {
    const tasks = [
      task('newer', { created_at: '2026-11-06T00:00:00Z' }),
      task('older', { created_at: '2026-08-10T00:00:00Z' }),
      task('pinned', { pinned: true, focus_tier: 'focus' }),
      task('vp', { org_role: 'lead' } as Partial<Task>),
      task('ask', { project: 'Ask Walnut' }),
      task('agent', { walnut_agent: true }),
      task('done', { phase: 'COMPLETE', status: 'done' }),
      task('snoozed', { start_date: '2026-11-20' }),
      task('started', { start_date: '2026-11-01' }),
    ];
    expect(ids(buildSortQueue(tasks, [], unsorted, { now: NOW }))).toEqual(['older', 'started', 'newer']);
  });

  it('opens on Focus, and keeps only a filter it can read', () => {
    expect(DEFAULT_SORT_FILTER.tiers).toEqual(['focus']);
    expect(isSortFilter(DEFAULT_SORT_FILTER)).toBe(true);
    expect(isSortFilter('unsorted')).toBe(false);
    expect(isSortFilter({ tiers: 'focus', project: null, folder: null, idleDays: 0 })).toBe(false);
    const tasks = [task('loose'), task('focus', { pinned: true, focus_tier: 'focus' })];
    expect(ids(buildSortQueue(tasks, [], DEFAULT_SORT_FILTER, { now: NOW }))).toEqual(['focus']);
  });

  it('makes one card of a leader and its subtasks in the same tier, and a subtask under a pinned leader its own card', () => {
    const tasks = [
      task('lead'),
      task('child', { parent_task_id: 'lead' }),
      task('grandchild', { parent_task_id: 'child' }),
      task('pinnedLead', { pinned: true, focus_tier: 'focus' }),
      task('orphan', { parent_task_id: 'pinnedLead', created_at: '2026-11-05T00:00:00Z' }),
    ];
    const queue = buildSortQueue(tasks, [], unsorted, { now: NOW });
    expect(ids(queue)).toEqual(['lead', 'orphan']);
    expect(queue[0].family.sort()).toEqual(['child', 'grandchild', 'lead']);
  });

  it('a snoozed leader keeps its subtasks out too (they inherit the snooze)', () => {
    const tasks = [task('lead', { start_date: '2026-12-01' }), task('child', { parent_task_id: 'lead', pinned: true, focus_tier: 'focus' })];
    expect(isSnoozed(tasks[1], new Map(tasks.map(t => [t.id, t])), NOW)).toBe(true);
    expect(buildSortQueue(tasks, [], f(), { now: NOW })).toEqual([]);
  });

  it('several tiers, a project, a folder and its subfolders, no action for N days, a query and this round\'s taken cards', () => {
    const tasks = [
      task('parkedOld', { pinned: true, focus_tier: 'wait', created_at: '2026-09-01T00:00:00Z' }),
      task('parkedNew', { pinned: true, focus_tier: 'wait', created_at: '2026-11-06T00:00:00Z' }),
      task('focus', { pinned: true, focus_tier: 'focus', project: 'Beta', group_id: 'g-sub' }),
      task('loose', { title: 'Call the plumber', group_id: 'g-root' }),
    ];
    expect(ids(buildSortQueue(tasks, [], f({ tiers: ['wait', 'focus'] }), { now: NOW })).sort()).toEqual(['focus', 'parkedNew', 'parkedOld']);
    expect(ids(buildSortQueue(tasks, [], f({ tiers: ['wait'], idleDays: 7 }), { now: NOW }))).toEqual(['parkedOld']);
    expect(ids(buildSortQueue(tasks, [], f(), { now: NOW }))).toHaveLength(4);
    expect(ids(buildSortQueue(tasks, [], f({ project: 'beta' }), { now: NOW }))).toEqual(['focus']);
    expect(ids(buildSortQueue(tasks, [], f({ project: '' }), { now: NOW }))).toEqual([]);
    expect(ids(buildSortQueue(tasks, [], f(), { now: NOW, folders: new Set(['g-root', 'g-sub']) })).sort()).toEqual(['focus', 'loose']);
    expect(ids(buildSortQueue(tasks, [], f(), { now: NOW, query: 'plumber' }))).toEqual(['loose']);
    // A kept folder that was deleted matches nothing, never everything.
    expect(ids(buildSortQueue(tasks, [], f(), { now: NOW, folders: new Set() }))).toEqual([]);
    expect(ids(buildSortQueue(tasks, [], unsorted, { now: NOW, exclude: new Set(['loose']) }))).toEqual([]);
    expect(tierCounts(tasks, [], f({ tiers: ['focus'] }), { now: NOW })).toEqual({ wait: 2, focus: 1, unpinned: 1 });
  });

  it('carries the task\'s own words of now', () => {
    const tasks = [task('a', { user_status: { state: 'needs', ask: 'Reply with the number' } } as Partial<Task>)];
    expect(buildSortQueue(tasks, [], unsorted, { now: NOW })[0].line).toBe('Reply with the number');
  });
});

describe('Sort ages', () => {
  it('no action counts from the latest session start, phase move, note, summary or title, never Walnut\'s own status writes', () => {
    const t = task('a', {
      created_at: '2026-09-01T00:00:00Z', updated_at: '2026-11-07T19:00:00Z',
      last_session_update: '2026-10-20T00:00:00Z', phase_changed_at: '2026-10-28T00:00:00Z',
      field_at: { note: '2026-10-25T00:00:00Z', user_status: '2026-11-07T19:00:00Z' },
    } as Partial<Task>);
    expect(taskAges(t, NOW).idle).toBe(10);
    // A tier move today is an action today (review round 2); a read mark or an order drag is not.
    expect(taskAges({ ...t, field_at: { ...t.field_at, focus_tier: '2026-11-07T10:00:00Z' } }, NOW).idle).toBe(0);
    expect(taskAges({ ...t, field_at: { ...t.field_at, unread: '2026-11-07T10:00:00Z', pin_order: '2026-11-07T10:00:00Z' } } as Task, NOW).idle).toBe(10);
  });

  it('time in its tier counts from the last pin or tier write, else from when it was made', () => {
    expect(taskAges(task('a', { created_at: '2026-10-07T20:00:00Z' }), NOW).inTier).toBe(31);
    expect(taskAges(task('b', { pinned: true, focus_tier: 'wait', field_at: { focus_tier: '2026-11-04T00:00:00Z' } } as Partial<Task>), NOW).inTier).toBe(3);
  });

  it('reads as plain words per tier, a day or more only', () => {
    expect(ageTags('unpinned', 'Unpinned', { idle: 12, inTier: 40 }).map(t => t.text)).toEqual(['Unsorted for 40 days', 'No action for 12 days']);
    expect(ageTags('wait', 'Parked', { idle: 1, inTier: 9 }).map(t => t.text)).toEqual(['Parked for 9 days', 'No action for 1 day']);
    expect(ageTags('focus', 'Focus', { idle: 0, inTier: 2 }).map(t => t.text)).toEqual(['In Focus for 2 days']);
    expect(ageTags('focus', 'Focus', { idle: 0, inTier: 0 })).toEqual([]);
    expect(ageTags('unpinned', 'Unpinned', { idle: 237, inTier: 237 }).map(t => t.text)).toEqual(['Unsorted, no action for 237 days']);
  });
});

describe('Sort projects', () => {
  it('one card per project, the most unsorted first, with its tier mix and top-level tasks', () => {
    const tasks = [
      task('a1'), task('a2', { parent_task_id: 'a1' }), task('a3', { pinned: true, focus_tier: 'focus' }),
      task('b1', { project: 'Beta' }), task('b2', { project: 'Beta' }), task('b3', { project: 'Beta' }),
      task('i1', { project: '' }),
    ];
    const projects = buildSortProjects(tasks, [], f(), { now: NOW });
    expect(projects.map(p => p.label)).toEqual(['Beta', 'Alpha', 'Inbox']);
    const alpha = projects.find(p => p.key === 'alpha')!;
    expect(alpha.tiers).toEqual({ unpinned: 2, focus: 1 });
    expect(alpha.roots.map(t => t.id).sort()).toEqual(['a1', 'a3']);
    expect(buildSortProjects(tasks, [], f({ tiers: ['focus'] }), { now: NOW }).map(p => p.label)).toEqual(['Alpha']);
  });

  it('a project snooze writes its top-level tasks and any task whose own start comes earlier', () => {
    const tasks = [task('a1'), task('a2', { parent_task_id: 'a1' }), task('a3', { parent_task_id: 'a1', start_date: '2026-11-08' }), task('a4', { parent_task_id: 'a1', start_date: '2027-01-01' })];
    const [alpha] = buildSortProjects(tasks, [], f(), { now: NOW });
    expect(projectSnoozeTargets(alpha, '2026-12-01').map(t => t.id).sort()).toEqual(['a1', 'a3']);
  });
});

describe('Snooze presets', () => {
  it('run out at 9:00 local: tomorrow, next Monday, next month (clamped), three months', () => {
    const sat = new Date(2026, 0, 31, 15, 0).getTime(); // Saturday Jan 31
    const [tomorrow, week, month, quarter] = snoozePresets(sat).map(p => new Date(p.date));
    expect([tomorrow.getDate(), tomorrow.getHours()]).toEqual([1, 9]);
    expect([week.getDay(), week.getDate(), week.getMonth()]).toEqual([1, 2, 1]);
    expect([month.getMonth(), month.getDate()]).toEqual([1, 28]);
    expect([quarter.getMonth(), quarter.getDate()]).toEqual([3, 30]);
    const mon = new Date(2026, 10, 9, 8, 0).getTime();
    expect(new Date(snoozePresets(mon)[1].date).getDate()).toBe(16);
  });
});

describe('Snooze words', () => {
  it('reads a day the way a person says it', () => {
    const now = new Date(2026, 10, 7, 15, 0).getTime();
    expect(snoozeUntilText(new Date(2026, 10, 8, 9, 0).toISOString(), now)).toBe('tomorrow 9:00');
    expect(snoozeUntilText('2026-11-10', now)).toBe('Tue Nov 10');
    expect(snoozeUntilText('2027-02-09', now)).toBe('Tue Feb 9 2027');
  });
});
