import { describe, expect, it } from 'vitest';
import type { Task } from '@open-walnut/core';
import { descendantsNeedingYou, needYouLabel, taskNeedsYou, tasksByIdOf } from '../../web/src/components/tasks/needs-you';

function task(id: string, over: Partial<Task> = {}): Task {
  return { id, title: id, status: 'todo', phase: 'TODO', project: '', ...over } as Task;
}

describe('descendantsNeedingYou', () => {
  it('is empty for a parent with no subtasks waiting on the user', () => {
    const parent = task('p');
    const map = tasksByIdOf([parent, task('c1', { parent_task_id: 'p' }), task('c2', { parent_task_id: 'p', phase: 'IN_PROGRESS' })]);
    expect(descendantsNeedingYou(parent, map)).toEqual([]);
  });

  it('finds one NEED_ACTION worker', () => {
    const parent = task('p');
    const worker = task('w', { parent_task_id: 'p', phase: 'NEED_ACTION' });
    const map = tasksByIdOf([parent, worker, task('x', { parent_task_id: 'p' })]);
    expect(descendantsNeedingYou(parent, map).map((t) => t.id)).toEqual(['w']);
    expect(needYouLabel(1)).toBe('1 Needs you');
  });

  it('walks every level, in tree order, and through a finished child', () => {
    const parent = task('p');
    const list = [
      parent,
      task('a', { parent_task_id: 'p', phase: 'NEED_ACTION' }),
      task('a1', { parent_task_id: 'a', phase: 'NEED_ACTION' }),
      task('b', { parent_task_id: 'p', phase: 'COMPLETE', status: 'done' }),
      task('b1', { parent_task_id: 'b', phase: 'NEED_ACTION' }),
      task('c', { parent_task_id: 'p' }),
      task('c1', { parent_task_id: 'c' }),
      task('c11', { parent_task_id: 'c1', phase: 'NEED_ACTION' }),
    ];
    expect(descendantsNeedingYou(parent, tasksByIdOf(list)).map((t) => t.id)).toEqual(['a', 'a1', 'b1', 'c11']);
  });

  it('never counts a completed descendant, whatever its phase reads', () => {
    const parent = task('p');
    const map = tasksByIdOf([
      parent,
      task('done', { parent_task_id: 'p', phase: 'COMPLETE', status: 'done' }),
      task('done-status', { parent_task_id: 'p', phase: 'NEED_ACTION', status: 'done' }),
    ]);
    expect(descendantsNeedingYou(parent, map)).toEqual([]);
  });

  it('counts a worker blocked on a prompt through the live reading', () => {
    const parent = task('p');
    const map = tasksByIdOf([parent, task('w', { parent_task_id: 'p', phase: 'IN_PROGRESS' })]);
    const isWaiting = (t: Task) => t.id === 'w';
    expect(descendantsNeedingYou(parent, map, { isWaiting }).map((t) => t.id)).toEqual(['w']);
    expect(taskNeedsYou(task('w', { phase: 'COMPLETE', status: 'done' }), { isWaiting })).toBe(false);
  });

  it('resolves a parent ref given as an id prefix and survives a cycle', () => {
    const parent = task('parent-0001');
    const list = [
      parent,
      task('kid', { parent_task_id: 'parent-0', phase: 'NEED_ACTION' }),
      task('loop-a', { parent_task_id: 'loop-b' }),
      task('loop-b', { parent_task_id: 'loop-a' }),
    ];
    expect(descendantsNeedingYou(parent, tasksByIdOf(list)).map((t) => t.id)).toEqual(['kid']);
    expect(descendantsNeedingYou(list[2], tasksByIdOf(list))).toEqual([]);
  });
});
