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
  briefCountsLine, buildStatusBoard, filteredRows, isStatusFilter, needsRowLine, statusBrief, statusFilterShown,
  userStatusOf, waitingLine,
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
    // Each one's line says what to do with it, then its ask.
    expect(brief.needs.map((n) => n.line)).toEqual(['Decide: Revoke the old token?', 'Decide: Approve a real iPhone test?']);
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

  it('To read is under Needs you, sorted and counted with it; no To read group, chip or count', () => {
    const tasks = [
      ...team(),
      task('result', { us: { state: 'read', toRead: 'result', waitingOn: 'The result is ready', at: ago(20) } }),
      // An older server stored To read as Waiting with toRead: it is under Needs you too.
      task('legacy', { us: { state: 'waiting', toRead: 'answer', waitingOn: 'It answered your question', at: ago(5) } }),
      // A snoozed one stays Waiting / snoozed.
      task('snoozed', { us: { state: 'waiting', toRead: 'result', waitingOn: 'Its result', snoozed: { until: ago(-600) }, at: ago(1) } }),
    ];
    const b = buildStatusBoard({ ownerId: 'lead', tasks, now: NOW, doneWindowDays: 7 });
    expect(b.counts).toEqual({ needs: 4, working: 3, waiting: 4, done: 1 });
    expect(Object.keys(b.groups).sort()).toEqual(['done', 'needs', 'waiting', 'working']);
    // Newest first, by the same rule as the asks.
    expect(b.groups.needs.map((r) => r.task.id)).toEqual(['legacy', 'result', 'vm', 'stt']);
    // The row keeps its own state (its line and its calm mark read it); only the group moved.
    expect(b.groups.needs.map((r) => r.status.state)).toEqual(['read', 'read', 'needs', 'needs']);
    expect(b.groups.waiting.map((r) => r.task.id)).toContain('snoozed');
    expect(filteredRows(b, 'needs').map((r) => r.task.id)).toEqual(['legacy', 'result', 'vm', 'stt']);
    expect(filteredRows(b, 'open').map((r) => r.status.state).slice(0, 5)).toEqual(['read', 'read', 'needs', 'needs', 'working']);
    const brief = statusBrief(b);
    expect(brief.needs.map((n) => n.id)).toEqual(['legacy', 'result', 'vm', 'stt']);
    expect(brief.needs.map((n) => n.line)).toEqual([
      'Take a look: It answered your question', 'Can close: The result is ready',
      'Decide: Revoke the old token?', 'Decide: Approve a real iPhone test?',
    ]);
    expect(briefCountsLine(brief)).toBe('3 Working, 4 Waiting / snoozed (1 with nothing to wake it, 1 not started), 1 Completed in the last 7 days.');
    expect(briefCountsLine(brief)).not.toContain('To read');
  });

  it('a Needs you row has one line: its category, then what it asks or has to read', () => {
    expect(needsRowLine({ state: 'read', toRead: 'result', waitingOn: 'The result is ready' })).toEqual({ category: 'close', label: 'Can close', text: 'The result is ready' });
    expect(needsRowLine({ state: 'read', toRead: 'answer', waitingOn: 'It answered your question' })).toMatchObject({ label: 'Take a look', text: 'It answered your question' });
    expect(needsRowLine({ state: 'needs', source: 'session', ask: 'Pick a\n vendor?' })).toMatchObject({ label: 'Decide', text: 'Pick a vendor?' });
    expect(needsRowLine({ state: 'needs', source: 'error', ask: 'Its session failed' })).toMatchObject({ label: 'Take a look' });
    // The category the server stored wins.
    expect(needsRowLine({ state: 'read', toRead: 'result', waitingOn: 'The result is ready', category: 'review' })).toMatchObject({ label: 'Review' });
    expect(needsRowLine({ state: 'working', now: 'x' })).toBeNull();
  });

  it('a To read filter an older build kept opens as Needs you', () => {
    expect(isStatusFilter('read')).toBe(true);
    expect(statusFilterShown('read')).toBe('needs');
    expect(statusFilterShown('working')).toBe('working');
    expect(isStatusFilter('bogus')).toBe(false);
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
