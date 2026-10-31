/**
 * The Board's Status view model (web/src/components/board/board-status-model.ts): the team
 * by the one user status, its order, its counts and its brief, on the shapes of the real
 * Walnut lead board of 2026-10-25 (two tasks needed the user; the old Board said none).
 * The iOS twin is ios-native/WalnutTests/TeamStatusModelTests.swift.
 */
import { describe, expect, it } from 'vitest';
import type { Task } from '@open-walnut/core';
import type { UserStatus } from '@open-walnut/user-status';
import {
  briefCountsLine, buildStatusBoard, filteredRows, statusBrief, userStatusOf, waitingLine,
} from '../../web/src/components/board/board-status-model';

const NOW = Date.parse('2026-10-26T05:35:00.000Z');
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();

function task(id: string, extra: Partial<Task> & { us?: UserStatus } = {}): Task {
  const { us, ...rest } = extra;
  return {
    id, title: `Task ${id}`, status: 'in_progress', phase: 'NEED_ACTION', priority: 'none', project: 'Walnut',
    source: 'local', created_at: ago(5000), updated_at: ago(60), parent_task_id: 'lead',
    ...(us ? { user_status: us } : {}),
    ...rest,
  } as Task;
}

const team = (): Task[] => [
  task('lead', { parent_task_id: undefined, phase: 'IN_PROGRESS', us: { state: 'working', now: 'Coordinating.', at: ago(2) } }),
  task('stt', { us: { state: 'needs', source: 'session', ask: 'Approve a real iPhone test?', at: ago(300) } }),
  task('vm', { us: { state: 'needs', source: 'session', ask: 'Revoke the old token?', at: ago(240) } }),
  task('voice', { phase: 'IN_PROGRESS', us: { state: 'working', now: 'Adding mics to iOS.', at: ago(11) } }),
  task('budget', { us: { state: 'waiting', kind: 'stuck', waitingOn: 'Nobody: it stopped and nothing will wake it', at: ago(270) } }),
  task('npm', { us: { state: 'waiting', kind: 'task', waitingOn: 'The Bun lead to send its commit', at: ago(1500) } }),
  task('todo1', { phase: 'TODO', us: { state: 'waiting', kind: 'not-started', waitingOn: 'Not started yet' } }),
  task('sub', { parent_task_id: 'voice', phase: 'IN_PROGRESS', us: { state: 'working', at: ago(1) } }),
  task('done1', { phase: 'COMPLETE', status: 'done', completed_at: ago(30) }),
  task('done-old', { phase: 'COMPLETE', status: 'done', completed_at: ago(60 * 24 * 30) }),
  task('elsewhere', { parent_task_id: 'other-lead', us: { state: 'needs', ask: 'x' } }),
];

describe('buildStatusBoard', () => {
  it('counts by the stored status, the lead included, done in the window only', () => {
    const b = buildStatusBoard({ ownerId: 'lead', tasks: team(), now: NOW, doneWindowDays: 7 });
    expect(b.counts).toEqual({ needs: 2, working: 3, waiting: 3, done: 1 });
    expect(b.groups.needs.map((r) => r.task.id)).toEqual(['vm', 'stt']); // newest first
    expect(b.groups.waiting.map((r) => r.task.id)).toEqual(['budget', 'npm', 'todo1']); // stuck first, not started last
    expect(b.groups.working.find((r) => r.task.id === 'lead')?.depth).toBe(0);
    expect(b.groups.working.find((r) => r.task.id === 'sub')?.under).toBe('Task voice');
  });

  it('the brief names what needs the user and counts the rest', () => {
    const brief = statusBrief(buildStatusBoard({ ownerId: 'lead', tasks: team(), now: NOW, doneWindowDays: 7 }));
    expect(brief.needs.map((n) => n.ask)).toEqual(['Revoke the old token?', 'Approve a real iPhone test?']);
    expect(briefCountsLine(brief)).toBe('3 Working, 3 Waiting / snoozed (1 with nothing to wake it, 1 not started), 1 Completed in the last 7 days.');
  });

  it('filters: all open in the table order, or one state', () => {
    const b = buildStatusBoard({ ownerId: 'lead', tasks: team(), now: NOW, doneWindowDays: 7 });
    expect(filteredRows(b, 'open').map((r) => r.status.state)).toEqual(['needs', 'needs', 'working', 'working', 'working', 'waiting', 'waiting', 'waiting']);
    expect(filteredRows(b, 'done').map((r) => r.task.id)).toEqual(['done1']);
  });

  it('past or near its due date goes first in its group, the earliest deadline first', () => {
    const tasks = [
      ...team(),
      task('due-later', { us: { state: 'needs', ask: 'b', at: ago(1), due: { at: '2026-10-26T20:00:00.000Z', state: 'soon' } } }),
      task('due-past', { us: { state: 'needs', ask: 'a', at: ago(900), due: { at: '2026-10-25', state: 'overdue' } } }),
      task('wait-due', { phase: 'TODO', us: { state: 'waiting', kind: 'not-started', waitingOn: 'Not started yet', due: { at: '2026-10-26', state: 'soon' } } }),
    ];
    const b = buildStatusBoard({ ownerId: 'lead', tasks, now: NOW, doneWindowDays: 7 });
    expect(b.groups.needs.map((r) => r.task.id)).toEqual(['due-past', 'due-later', 'vm', 'stt']);
    // A not-started task with a deadline comes ahead of a stuck one without.
    expect(b.groups.waiting[0].task.id).toBe('wait-due');
  });

  it('a task not derived yet: the phase alone, as an older server meant it', () => {
    expect(userStatusOf(task('x', { phase: 'NEED_ACTION' }))).toMatchObject({ state: 'needs', ask: expect.stringContaining('handed the task back') });
    expect(userStatusOf(task('x', { phase: 'WAITING' })).state).toBe('waiting');
    expect(userStatusOf(task('x', { phase: 'IN_PROGRESS' })).state).toBe('working');
    expect(userStatusOf(task('x', { phase: 'COMPLETE', status: 'done', us: { state: 'needs', ask: 'stale' } })).state).toBe('done');
  });
});

describe('waitingLine', () => {
  const fmt = () => 'Mon 9:00';
  it('words each kind of wait', () => {
    expect(waitingLine({ state: 'waiting', kind: 'task', waitingOn: 'A reply from Bun lead' }, fmt)).toBe('Waiting on a reply from Bun lead');
    expect(waitingLine({ state: 'waiting', kind: 'stuck', waitingOn: 'Nobody' }, fmt)).toBe('Nothing will wake it. Nobody');
    expect(waitingLine({ state: 'waiting', kind: 'time', waitingOn: 'Its next check', until: ago(-60) }, fmt)).toBe('Waiting until Mon 9:00');
    expect(waitingLine({ state: 'waiting', kind: 'not-started', waitingOn: 'Not started yet' }, fmt)).toBe('Not started yet');
  });
});
