/**
 * The Inbox's per-project strip (web/src/components/inbox/InboxProjectStrip.tsx `projectLines`):
 * each open task counted by its one user status; a start date to come only for a task the
 * server has not derived yet.
 */
import { describe, expect, it } from 'vitest';
import type { Task } from '../../src/core/types';
import { projectLines } from '../../web/src/components/inbox/InboxProjectStrip';

let n = 0;
const task = (patch: Partial<Task> = {}): Task => ({
  id: `t${++n}`,
  title: `Task ${n}`,
  status: 'todo',
  phase: 'TODO',
  priority: 'none',
  project: 'Garden',
  created_at: '2026-10-01T00:00:00.000Z',
  updated_at: '2026-10-01T00:00:00.000Z',
  ...patch,
} as Task);

const SNOOZED = { state: 'waiting', kind: 'time', waitingOn: 'Snoozed until 2026-11-13', snoozed: { until: '2026-11-13' } } as Task['user_status'];

const summary = (tasks: Task[]) => projectLines(tasks).map((l) => [l.project, l.needs.map((t) => t.id), l.working.map((t) => t.id), l.waiting]);

describe('projectLines', () => {
  it('a snoozed NEED_ACTION task waits; one with no status still needs the user', () => {
    const snoozed = task({ id: 's', phase: 'NEED_ACTION', user_status: SNOOZED });
    const plain = task({ id: 'p', phase: 'NEED_ACTION' });
    expect(summary([snoozed, plain])).toEqual([['Garden', ['p'], [], 1]]);
  });

  it('the user status sorts each task, over its phase', () => {
    const tasks = [
      task({ id: 'w', phase: 'IN_PROGRESS', user_status: { state: 'working' } as Task['user_status'] }),
      task({ id: 'idle', phase: 'IN_PROGRESS', user_status: { state: 'waiting', kind: 'stuck' } as Task['user_status'] }),
      task({ id: 'l', phase: 'WAITING', user_status: { state: 'needs', source: 'letter', ask: 'Pick a date' } as Task['user_status'] }),
      task({ id: 'd', phase: 'COMPLETE', status: 'done' }),
      task({ id: 'o', project: 'Orchard', phase: 'IN_PROGRESS' }),
    ];
    expect(summary(tasks)).toEqual([['Garden', ['l'], ['w'], 1], ['Orchard', [], ['o'], 0]]);
  });

  it('a task not derived yet reads its start date, inherited from its parent', () => {
    const later = new Date(Date.now() + 3 * 86_400_000);
    const day = `${later.getFullYear()}-${String(later.getMonth() + 1).padStart(2, '0')}-${String(later.getDate()).padStart(2, '0')}`;
    const parent = task({ id: 'par', phase: 'TODO', start_date: day });
    const child = task({ id: 'kid', phase: 'NEED_ACTION', parent_task_id: 'par' });
    expect(summary([parent, child])).toEqual([['Garden', [], [], 2]]);
  });
});
