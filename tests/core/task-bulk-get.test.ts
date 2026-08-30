import { describe, it, expect } from 'vitest';
import {
  BulkGetError,
  DEFAULT_BULK_GET_FIELDS,
  MAX_BULK_GET_IDS,
  bulkGetFromTasks,
  resolveBulkGetFields,
} from '../../src/core/task-bulk-get.js';
import type { Task } from '../../src/core/types.js';

function task(overrides: Partial<Task> & { id: string }): Task {
  return {
    id: overrides.id,
    title: `Task ${overrides.id}`,
    project: 'walnut',
    status: 'todo',
    phase: 'TODO',
    priority: 'none',
    source: 'local',
    session_ids: [],
    summary: '',
    note: '',
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-02T00:00:00.000Z',
    ...overrides,
  } as Task;
}

const NOTE = '## Executive Summary\nsummary text\n\n## Progress\n- [DONE] shipped\n- [WIP] wiring\n\n'
  + '## Work Log\n- a very long log entry nobody triaging wants\n';

const TASKS: Task[] = [
  task({ id: 'a1b2c3', title: 'Alpha', phase: 'IN_PROGRESS', status: 'in_progress', note: NOTE, pinned: true, focus_tier: 'focus', due_date: '2026-09-01' }),
  task({ id: 'd4e5f6', title: 'Beta', summary: 'beta summary', last_session_update: '2026-08-29T12:00:00.000Z' }),
  task({ id: 'a1b2ff', title: 'Alpha twin' }),
  task({ id: 'zz9999', title: 'Zeta', pinned: false }),
];

describe('resolveBulkGetFields', () => {
  it('defaults to the triage set and expands the dates group', () => {
    expect(resolveBulkGetFields(undefined)).toEqual([...DEFAULT_BULK_GET_FIELDS]);
    expect(resolveBulkGetFields([])).toEqual([...DEFAULT_BULK_GET_FIELDS]);
    expect(resolveBulkGetFields(['dates']))
      .toEqual(['start_date', 'due_date', 'created_at', 'updated_at', 'completed_at']);
    // Case-insensitive, deduped, order preserved.
    expect(resolveBulkGetFields(['Title', 'title', 'phase'])).toEqual(['title', 'phase']);
  });

  it('REJECTS an unknown field instead of dropping it silently', () => {
    // A dropped field would read as "the task has no such value", which is the
    // wrong answer rather than a missing one.
    expect(() => resolveBulkGetFields(['title', 'nope'])).toThrow(BulkGetError);
    expect(() => resolveBulkGetFields(['nope'])).toThrow(/Unknown field "nope"/);
  });
});

describe('bulkGetFromTasks', () => {
  it('answers in INPUT order and projects only the named fields', () => {
    const result = bulkGetFromTasks(['d4e5f6', 'a1b2c3'], TASKS, ['title', 'phase']);
    expect(result.fields).toEqual(['title', 'phase']);
    expect(result.items.map((i) => i.id)).toEqual(['d4e5f6', 'a1b2c3']);
    expect(result.items[0]).toEqual({ id: 'd4e5f6', title: 'Beta', phase: 'TODO' });
    // `note` and `summary` were not asked for, so they are absent — that is the
    // whole point of the projection.
    expect(result.items[1]).not.toHaveProperty('note');
    expect(result.items[1]).not.toHaveProperty('summary');
  });

  it('derives progress from the note WITHOUT returning the note', () => {
    const [item] = bulkGetFromTasks(['a1b2c3'], TASKS, ['progress']).items;
    expect(item.progress).toEqual([
      { status: 'DONE', text: 'shipped' },
      { status: 'WIP', text: 'wiring' },
    ]);
    expect(item.progress_counts).toEqual({ DONE: 1, WIP: 1, WAIT: 0, TODO: 0, BLOCKED: 0 });
    expect(item).not.toHaveProperty('note');
  });

  it('returns an empty progress board for a task with no note', () => {
    const [item] = bulkGetFromTasks(['zz9999'], TASKS, ['progress']).items;
    expect(item.progress).toEqual([]);
    expect(item.error).toBeUndefined();
  });

  it('reports a bad id per item and keeps the good rows', () => {
    const result = bulkGetFromTasks(['a1b2c3', 'nosuchid', 'd4e5f6'], TASKS, ['title']);
    expect(result.items.map((i) => i.id)).toEqual(['a1b2c3', 'nosuchid', 'd4e5f6']);
    expect(result.items[1]).toEqual({ id: 'nosuchid', error: 'not found' });
    expect(result.items[0].title).toBe('Alpha');
    expect(result.items[2].title).toBe('Beta');
    expect(result.errors).toBe(1);
  });

  it('resolves a unique prefix, flags an ambiguous one, and prefers an exact hit', () => {
    const result = bulkGetFromTasks(['d4e5', 'a1b2', 'a1b2c3'], TASKS, ['title']);
    expect(result.items[0].title).toBe('Beta');
    expect(result.items[1].error).toMatch(/ambiguous/i);
    // 'a1b2c3' is a full id that also prefixes nothing else — exact wins.
    expect(result.items[2].title).toBe('Alpha');
    expect(result.errors).toBe(1);
  });

  it('projects board and session fields a triage pass reads', () => {
    const [alpha] = bulkGetFromTasks(['a1b2c3'], TASKS,
      ['pinned', 'focus_tier', 'due_date', 'last_session_update']).items;
    expect(alpha).toEqual({ id: 'a1b2c3', pinned: true, focus_tier: 'focus', due_date: '2026-09-01' });
    const [beta] = bulkGetFromTasks(['d4e5f6'], TASKS, ['pinned', 'last_session_update']).items;
    expect(beta).toEqual({ id: 'd4e5f6', pinned: false, last_session_update: '2026-08-29T12:00:00.000Z' });
  });

  it('rejects an empty or oversized id list', () => {
    expect(() => bulkGetFromTasks([], TASKS)).toThrow(/at least one/);
    const many = Array.from({ length: MAX_BULK_GET_IDS + 1 }, (_, i) => `id${i}`);
    expect(() => bulkGetFromTasks(many, TASKS)).toThrow(new RegExp(`at most ${MAX_BULK_GET_IDS}`));
  });
});
