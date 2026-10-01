/**
 * The leader/subtask index behind the Leader pill (web/src/components/tasks/subtask-index.ts).
 *
 * Pinned: a parent_task_id may be a PREFIX of the parent's id (legacy data), a
 * subtask in another project counts (the board nests only inside one project,
 * the pill lists everything open), finished work sorts last, the Leader pill
 * counts and lists only the OPEN subtasks, the index is built once per task
 * array, and the place label names another project or the Inbox and stays
 * silent for the leader's own project (case-insensitively).
 */
import { describe, expect, it } from 'vitest';
import type { Task } from '@open-walnut/core';
import {
  doneSubtaskCount, leaderPillTitle, openSubtasksOf, subtaskPlaceLabel, subtasksOf,
} from '../../web/src/components/tasks/subtask-index';

function task(over: Partial<Task> & { id: string }): Task {
  return { title: over.id, project: 'Walnut', phase: 'TODO', status: 'open', created_at: '', updated_at: '', ...over } as unknown as Task;
}

describe('subtasksOf', () => {
  const leader = task({ id: 'muabcdef-1234', title: 'GitLab token expiry' });
  const near = task({ id: 'c1', parent_task_id: 'muabcdef-1234' });
  const far = task({ id: 'c2', parent_task_id: 'muabcdef', project: 'Ops' });
  const done = task({ id: 'c0', parent_task_id: 'muabcdef-1234', phase: 'COMPLETE' });
  const other = task({ id: 'x1', parent_task_id: 'zz' });
  const tasks = [done, leader, near, far, other];

  it('finds the subtasks by full id and by prefix, in any project, open ones first', () => {
    expect(subtasksOf(tasks, leader.id).map((t) => t.id)).toEqual(['c1', 'c2', 'c0']);
  });

  it('answers [] for a task that leads nothing, and for an unknown id', () => {
    expect(subtasksOf(tasks, 'c1')).toEqual([]);
    expect(subtasksOf(tasks, 'nope')).toEqual([]);
    expect(subtasksOf([], 'nope')).toEqual([]);
  });

  it('builds the index once per task array and again for a new array', () => {
    const a = subtasksOf(tasks, leader.id);
    expect(subtasksOf(tasks, leader.id)).toBe(a);
    const b = subtasksOf([...tasks], leader.id);
    expect(b).not.toBe(a);
    expect(b.map((t) => t.id)).toEqual(a.map((t) => t.id));
  });
});

describe('openSubtasksOf (what the Leader pill counts and lists)', () => {
  // The 2026-10-01 report: a leader read `Leader · 8` and listed all eight
  // subtasks while most of them were done. Only open work counts.
  const leader = task({ id: 'mulead00-0001' });
  const subs = [
    task({ id: 's1', parent_task_id: leader.id, phase: 'COMPLETE' }),
    task({ id: 's2', parent_task_id: leader.id, phase: 'NEED_ACTION' }),
    task({ id: 's3', parent_task_id: leader.id, phase: 'COMPLETE' }),
    task({ id: 's4', parent_task_id: 'mulead00', phase: 'IN_PROGRESS', project: 'Ops' }),
    task({ id: 's5', parent_task_id: leader.id, phase: 'WAITING' }),
    task({ id: 's6', parent_task_id: leader.id, phase: 'TODO', status: 'done' }),
  ];
  const tasks = [leader, ...subs];

  it('keeps every phase but COMPLETE (and a legacy done status), in any project', () => {
    expect(openSubtasksOf(tasks, leader.id).map((t) => t.id).sort()).toEqual(['s2', 's4', 's5']);
    expect(doneSubtaskCount(tasks, leader.id)).toBe(3);
  });

  it('answers [] when every subtask is done, so the pill is not drawn', () => {
    const allDone = [leader, task({ id: 'd1', parent_task_id: leader.id, phase: 'COMPLETE' })];
    expect(openSubtasksOf(allDone, leader.id)).toEqual([]);
    expect(doneSubtaskCount(allDone, leader.id)).toBe(1);
    expect(openSubtasksOf([leader], leader.id)).toEqual([]);
  });
});

describe('leaderPillTitle', () => {
  it('counts the open subtasks and notes how many are done', () => {
    const open = task({ id: 'a' });
    expect(leaderPillTitle([open])).toBe('Leads 1 open subtask. Click to list them.');
    expect(leaderPillTitle([open, open])).toBe('Leads 2 open subtasks. Click to list them.');
    expect(leaderPillTitle([open, open], 6)).toBe('Leads 2 open subtasks (6 done). Click to list them.');
  });
});

describe('subtaskPlaceLabel', () => {
  it('names another project, says Inbox for none, and stays silent at home', () => {
    expect(subtaskPlaceLabel({ project: 'Ops' }, 'Walnut')).toBe('Ops');
    expect(subtaskPlaceLabel({ project: '' }, 'Walnut')).toBe('Inbox');
    expect(subtaskPlaceLabel({ project: 'walnut' }, 'Walnut')).toBe('');
    expect(subtaskPlaceLabel({ project: '' }, '')).toBe('');
    expect(subtaskPlaceLabel({ project: 'Ops' }, undefined)).toBe('Ops');
  });
});
