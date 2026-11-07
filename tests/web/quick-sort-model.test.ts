import { describe, expect, it } from 'vitest';
import type { Task } from '@open-walnut/core';
import { buildSortProjects, buildSortQueue, idleText, isSnoozed, projectSnoozeTargets, snoozePresets, snoozeUntilText } from '../../web/src/components/tasks/quick-sort-model';

const NOW = Date.parse('2026-11-07T20:00:00Z');
function task(id: string, fields: Partial<Task> = {}): Task {
  return { id, title: id, project: 'Alpha', phase: 'TODO', status: 'todo', source: 'local', priority: 'none', created_at: '2026-10-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z', ...fields } as Task;
}
const ids = (items: { task: Task }[]) => items.map(i => i.task.id);

describe('Sort queue', () => {
  it('takes unpinned open work, oldest first, and leaves out org nodes, asks, done and snoozed tasks', () => {
    const tasks = [
      task('newer', { updated_at: '2026-11-06T00:00:00Z' }),
      task('older', { updated_at: '2026-08-10T00:00:00Z' }),
      task('pinned', { pinned: true, focus_tier: 'focus' }),
      task('vp', { org_role: 'lead' } as Partial<Task>),
      task('ask', { project: 'Ask Walnut' }),
      task('agent', { walnut_agent: true }),
      task('done', { phase: 'COMPLETE', status: 'done' }),
      task('snoozed', { start_date: '2026-11-20' }),
      task('started', { start_date: '2026-11-01' }),
    ];
    expect(ids(buildSortQueue(tasks, [], 'unsorted', { now: NOW }))).toEqual(['older', 'started', 'newer']);
  });

  it('makes one card of a leader and its subtasks in the same tier, and a subtask under a pinned leader its own card', () => {
    const tasks = [
      task('lead'),
      task('child', { parent_task_id: 'lead' }),
      task('grandchild', { parent_task_id: 'child' }),
      task('pinnedLead', { pinned: true, focus_tier: 'focus' }),
      task('orphan', { parent_task_id: 'pinnedLead', updated_at: '2026-11-05T00:00:00Z' }),
    ];
    const queue = buildSortQueue(tasks, [], 'unsorted', { now: NOW });
    expect(ids(queue)).toEqual(['lead', 'orphan']);
    expect(queue[0].family.sort()).toEqual(['child', 'grandchild', 'lead']);
  });

  it('a snoozed leader keeps its subtasks out too (they inherit the snooze)', () => {
    const tasks = [task('lead', { start_date: '2026-12-01' }), task('child', { parent_task_id: 'lead', pinned: true, focus_tier: 'focus' })];
    expect(isSnoozed(tasks[1], new Map(tasks.map(t => [t.id, t])), NOW)).toBe(true);
    expect(buildSortQueue(tasks, [], 'all', { now: NOW })).toEqual([]);
  });

  it('parked over 7 days, everything, a project, a query and this round\'s taken cards', () => {
    const tasks = [
      task('parkedOld', { pinned: true, focus_tier: 'wait', updated_at: '2026-10-01T00:00:00Z' }),
      task('parkedNew', { pinned: true, focus_tier: 'wait', updated_at: '2026-11-06T00:00:00Z' }),
      task('focus', { pinned: true, focus_tier: 'focus', project: 'Beta' }),
      task('loose', { title: 'Call the plumber' }),
    ];
    expect(ids(buildSortQueue(tasks, [], 'parked', { now: NOW }))).toEqual(['parkedOld']);
    expect(ids(buildSortQueue(tasks, [], 'all', { now: NOW }))).toHaveLength(4);
    expect(ids(buildSortQueue(tasks, [], 'all', { now: NOW, project: 'beta' }))).toEqual(['focus']);
    expect(ids(buildSortQueue(tasks, [], 'all', { now: NOW, query: 'plumber' }))).toEqual(['loose']);
    expect(ids(buildSortQueue(tasks, [], 'unsorted', { now: NOW, exclude: new Set(['loose']) }))).toEqual([]);
  });

  it('carries the task\'s own words of now', () => {
    const tasks = [task('a', { user_status: { state: 'needs', ask: 'Reply with the number' } } as Partial<Task>)];
    expect(buildSortQueue(tasks, [], 'unsorted', { now: NOW })[0].line).toBe('Reply with the number');
    expect(idleText(0)).toBe('touched today');
    expect(idleText(89)).toBe('2 months untouched');
  });
});

describe('Sort projects', () => {
  it('one card per project, the most unsorted first, with its tier mix and top-level tasks', () => {
    const tasks = [
      task('a1'), task('a2', { parent_task_id: 'a1' }), task('a3', { pinned: true, focus_tier: 'focus' }),
      task('b1', { project: 'Beta' }), task('b2', { project: 'Beta' }), task('b3', { project: 'Beta' }),
      task('i1', { project: '' }),
    ];
    const projects = buildSortProjects(tasks, [], { now: NOW });
    expect(projects.map(p => p.label)).toEqual(['Beta', 'Alpha', 'Inbox']);
    const alpha = projects.find(p => p.key === 'alpha')!;
    expect(alpha.tiers).toEqual({ unpinned: 2, focus: 1 });
    expect(alpha.roots.map(t => t.id).sort()).toEqual(['a1', 'a3']);
  });

  it('a project snooze writes its top-level tasks and any task whose own start comes earlier', () => {
    const tasks = [task('a1'), task('a2', { parent_task_id: 'a1' }), task('a3', { parent_task_id: 'a1', start_date: '2026-11-08' }), task('a4', { parent_task_id: 'a1', start_date: '2027-01-01' })];
    const [alpha] = buildSortProjects(tasks, [], { now: NOW });
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
