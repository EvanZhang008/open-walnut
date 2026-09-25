/**
 * The leader/subtask index behind the Leader pill (web/src/components/tasks/subtask-index.ts).
 *
 * Pinned: a parent_task_id may be a PREFIX of the parent's id (legacy data), a
 * subtask in another project counts (the board nests only inside one project,
 * the pill lists everything), finished work sorts last, the index is built once
 * per task array, and the place label names another project or the Inbox and
 * stays silent for the leader's own project (case-insensitively).
 */
import { describe, expect, it } from 'vitest';
import type { Task } from '@open-walnut/core';
import { leaderPillTitle, subtaskPlaceLabel, subtasksOf } from '../../web/src/components/tasks/subtask-index';

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

describe('leaderPillTitle', () => {
  it('counts the subtasks and notes how many are still open', () => {
    const open = task({ id: 'a' });
    const done = task({ id: 'b', phase: 'COMPLETE' });
    expect(leaderPillTitle([open])).toBe('Leads 1 subtask. Click to list them.');
    expect(leaderPillTitle([open, open])).toBe('Leads 2 subtasks. Click to list them.');
    expect(leaderPillTitle([open, done])).toBe('Leads 2 subtasks (1 open). Click to list them.');
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
