/**
 * Identity-preserving refetch merge (2026-08-23 UI-freeze fix).
 *
 * A background refetch used to replace the whole tasks array with ~6k FRESH
 * objects, re-rendering every memoized row even when nothing changed. The merge
 * must (a) reuse the previous object for visibly-unchanged tasks, (b) return
 * the previous ARRAY when nothing changed at all, and (c) still adopt fetched
 * content, order, additions and removals.
 */
import { describe, it, expect } from 'vitest';
import type { Task } from '@open-walnut/core';
import { mergeFetchedTasks, listRowEqual } from '@/hooks/task-list-merge';

let seq = 0;
function task(over: Partial<Task> = {}): Task {
  seq++;
  return {
    id: over.id ?? `t-${seq}`,
    title: `Task ${seq}`,
    status: 'todo',
    phase: 'TODO',
    priority: 'none',
    project: '',
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
    ...over,
  } as Task;
}

describe('mergeFetchedTasks', () => {
  it('returns the previous ARRAY identity when nothing changed', () => {
    const a = task({ id: 'a' });
    const b = task({ id: 'b' });
    const prev = [a, b];
    const fetched = [{ ...a }, { ...b }];
    expect(mergeFetchedTasks(prev, fetched)).toBe(prev);
  });

  it('reuses previous objects for unchanged tasks, adopts the changed one', () => {
    const a = task({ id: 'a' });
    const b = task({ id: 'b' });
    const prev = [a, b];
    const bChanged = { ...b, title: 'renamed', updated_at: '2026-08-02T00:00:00Z' };
    const next = mergeFetchedTasks(prev, [{ ...a }, bChanged]);
    expect(next).not.toBe(prev);
    expect(next[0]).toBe(a); // identity preserved → memoized row skips
    expect(next[1]).toBe(bChanged); // fresh object carries the change
  });

  it('adopts the fetched ORDER even when every task is individually unchanged', () => {
    const a = task({ id: 'a' });
    const b = task({ id: 'b' });
    const next = mergeFetchedTasks([a, b], [{ ...b }, { ...a }]);
    expect(next.map((t) => t.id)).toEqual(['b', 'a']);
    expect(next[0]).toBe(b);
    expect(next[1]).toBe(a);
  });

  it('drops removed tasks and inserts new ones', () => {
    const a = task({ id: 'a' });
    const b = task({ id: 'b' });
    const c = task({ id: 'c' });
    const next = mergeFetchedTasks([a, b], [{ ...a }, c]);
    expect(next.map((t) => t.id)).toEqual(['a', 'c']);
    expect(next[0]).toBe(a);
    expect(next[1]).toBe(c);
  });

  it('first load (empty prev) returns fetched as-is', () => {
    const fetched = [task(), task()];
    expect(mergeFetchedTasks([], fetched)).toBe(fetched);
  });

  it('detects changes in list-payload extras outside the shallow-equal core', () => {
    const a = task({ id: 'a' });
    const prev = [a];
    const withNote = { ...a, has_note: true } as Task;
    const next = mergeFetchedTasks(prev, [withNote]);
    expect(next[0]).toBe(withNote); // has_note flip must not be swallowed
  });

  it('detects is_blocked flips (blocked badge must heal on refetch)', () => {
    const a = task({ id: 'a' });
    const blocked = { ...a, is_blocked: true } as unknown as Task;
    expect(listRowEqual(a, blocked)).toBe(false);
    expect(listRowEqual(blocked, { ...blocked } as Task)).toBe(true);
  });

  it('detects session_ids changes (search-results join key)', () => {
    const a = { ...task({ id: 'a' }), session_ids: ['s1'] } as unknown as Task;
    const same = { ...a, session_ids: ['s1'] } as unknown as Task;
    const grown = { ...a, session_ids: ['s1', 's2'] } as unknown as Task;
    const swapped = { ...a, session_ids: ['s2'] } as unknown as Task;
    expect(listRowEqual(a, same)).toBe(true);
    expect(listRowEqual(a, grown)).toBe(false);
    expect(listRowEqual(a, swapped)).toBe(false);
  });

  it('detects milestones changes (deep compare, not identity)', () => {
    const withM = { ...task({ id: 'a' }), milestones: [{ label: 'x', done: false }] } as unknown as Task;
    const sameM = { ...withM, milestones: [{ label: 'x', done: false }] } as unknown as Task;
    const doneM = { ...withM, milestones: [{ label: 'x', done: true }] } as unknown as Task;
    expect(listRowEqual(withM, sameM)).toBe(true);
    expect(listRowEqual(withM, doneM)).toBe(false);
  });
});
