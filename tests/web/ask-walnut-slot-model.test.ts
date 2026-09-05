/**
 * The Ask Walnut slot's selection model.
 *
 * Two decisions, both invisible from the DOM until they regress:
 *  - WHICH tasks are Ask Walnut tasks (the per-task `walnut_agent` flag, never
 *    the project name — an ordinary dev task filed under 'Ask Walnut' must not
 *    become a tab);
 *  - WHICH tab survives a task-list change (the persisted pick while it exists,
 *    else the newest, else nothing).
 *
 * (WHICH session a task's panel mounts is `resolveTaskSessionId` in
 * web/src/utils/session-status.ts — one precedence for every surface. This module
 * used to carry a second copy of it plus a session-list fallback nobody fed.)
 *
 * The ordering assertions are the ones a browser spec cannot make: a streaming
 * ask must not slide out from under the cursor, and two tasks stamped in the same
 * millisecond must not swap places between refetches.
 */

import { describe, it, expect } from 'vitest';
import type { Task } from '@open-walnut/core';
import { resolveSelection, selectAskWalnutTasks } from '@/components/chat/ask-walnut-slot-model';

function task(over: Partial<Task> & { id: string }): Task {
  return {
    title: `task ${over.id}`,
    status: 'todo',
    priority: 'none',
    phase: 'TODO',
    session_ids: [],
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-01T00:00:00.000Z',
    source: 'local',
    note: '',
    summary: '',
    description: '',
    ...over,
  } as unknown as Task;
}

const walnut = (id: string, over: Partial<Task> = {}) =>
  task({ id, walnut_agent: true, ...over });

describe('selectAskWalnutTasks', () => {
  it('keeps only tasks carrying the walnut_agent flag', () => {
    const tasks = [
      walnut('a'),
      task({ id: 'b' }),
      task({ id: 'c', walnut_agent: false }),
      task({ id: 'd', project: 'Ask Walnut' }),   // project name is NOT the marker
    ];
    expect(selectAskWalnutTasks(tasks).map((t) => t.id)).toEqual(['a']);
  });

  it('sorts by created_at descending', () => {
    const tasks = [
      walnut('old', { created_at: '2026-09-01T00:00:00.000Z' }),
      walnut('new', { created_at: '2026-09-03T00:00:00.000Z' }),
      walnut('mid', { created_at: '2026-09-02T00:00:00.000Z' }),
    ];
    expect(selectAskWalnutTasks(tasks).map((t) => t.id)).toEqual(['new', 'mid', 'old']);
  });

  // THE REGRESSION THIS ORDER EXISTS FOR: `updated_at` moves on every streamed
  // turn, so ordering on it slid the answering ask toward the front while the
  // user was aiming at a tab — the click landed on whatever took its place. Tab
  // position is birth order, which nothing can change after the fact.
  it('does NOT reorder when an older ask is updated (a streaming turn)', () => {
    const tasks = [
      walnut('born-first', { created_at: '2026-09-01T00:00:00.000Z', updated_at: '2026-09-09T00:00:00.000Z' }),
      walnut('born-second', { created_at: '2026-09-02T00:00:00.000Z', updated_at: '2026-09-02T00:00:00.000Z' }),
    ];
    expect(selectAskWalnutTasks(tasks).map((t) => t.id)).toEqual(['born-second', 'born-first']);
  });

  it('breaks a created_at tie on updated_at, then on the id — deterministically', () => {
    const same = '2026-09-02T00:00:00.000Z';
    const tasks = [
      walnut('zz', { created_at: same, updated_at: same }),
      walnut('aa', { created_at: same, updated_at: same }),
      walnut('newer-touch', { created_at: same, updated_at: '2026-09-02T09:00:00.000Z' }),
    ];
    const first = selectAskWalnutTasks(tasks).map((t) => t.id);
    // Reversing the input must not change the answer — that is the whole point.
    const second = selectAskWalnutTasks([...tasks].reverse()).map((t) => t.id);
    expect(first).toEqual(['newer-touch', 'aa', 'zz']);
    expect(second).toEqual(first);
  });

  it('sorts a task with no usable stamps last instead of scrambling the list', () => {
    const tasks = [
      walnut('broken', { updated_at: '', created_at: '' } as Partial<Task>),
      walnut('good', { created_at: '2026-09-02T00:00:00.000Z' }),
    ];
    expect(selectAskWalnutTasks(tasks).map((t) => t.id)).toEqual(['good', 'broken']);
  });

  it('does not mutate the input array', () => {
    const tasks = [walnut('b', { created_at: '2026-09-01T00:00:00.000Z' }), walnut('a', { created_at: '2026-09-05T00:00:00.000Z' })];
    const order = tasks.map((t) => t.id);
    selectAskWalnutTasks(tasks);
    expect(tasks.map((t) => t.id)).toEqual(order);
  });
});

describe('resolveSelection', () => {
  const tasks = [
    walnut('new', { created_at: '2026-09-03T00:00:00.000Z' }),
    walnut('old', { created_at: '2026-09-01T00:00:00.000Z' }),
  ];

  it('keeps the persisted selection while its task exists', () => {
    expect(resolveSelection('old', tasks)).toBe('old');
  });

  it('falls back to the newest task when the selection is gone', () => {
    expect(resolveSelection('deleted', tasks)).toBe('new');
    expect(resolveSelection(null, tasks)).toBe('new');
    expect(resolveSelection(undefined, tasks)).toBe('new');
  });

  it('finds the newest task regardless of the input order', () => {
    expect(resolveSelection(null, [...tasks].reverse())).toBe('new');
  });

  // The reload regression: the task store is EMPTY at first paint and fills a
  // tick later, so an empty list must not be read as "the task is gone". Clearing
  // the pick there erased the persisted id too, and the selected tab never came
  // back after a reload (caught by tests/e2e/browser/ask-walnut-slot.spec.ts).
  it('keeps the persisted pick when there are no candidates yet', () => {
    expect(resolveSelection('anything', [])).toBe('anything');
  });

  it('resolves to null with no tasks and nothing persisted', () => {
    expect(resolveSelection(null, [])).toBeNull();
    expect(resolveSelection(undefined, [])).toBeNull();
  });
});
