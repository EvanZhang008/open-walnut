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

describe('mergeFetchedTasks with tasks inserted after the snapshot was taken', () => {
  // Live repro (2026-09-11): the first list fetch of ~6.4k tasks took 5.9s; an
  // Ask Walnut launched meanwhile arrived over WS, then the stale snapshot
  // landed and deleted it. The slot re-resolved onto an OLDER ask and, since
  // that pick is persisted, stayed there.
  it('keeps a retained task the fetched list does not know about, at the head', () => {
    const old = task({ id: 'old' });
    const fresh = task({ id: 'fresh' });
    const prev = [fresh, old];
    const next = mergeFetchedTasks(prev, [{ ...old }], new Set(['fresh']));
    expect(next.map((t) => t.id)).toEqual(['fresh', 'old']);
    expect(next[0]).toBe(fresh);
    expect(next[1]).toBe(old);
  });

  it('a retained task the fetched list DOES carry is adopted from the fetch when the fetch is newer', () => {
    const old = task({ id: 'old' });
    const fresh = task({ id: 'fresh', updated_at: '2026-09-11T00:00:00Z' });
    const freshFromServer = { ...fresh, title: 'server title', updated_at: '2026-09-11T00:00:01Z' };
    const next = mergeFetchedTasks([fresh, old], [freshFromServer, { ...old }], new Set(['fresh']));
    expect(next.map((t) => t.id)).toEqual(['fresh', 'old']);
    expect(next[0]).toBe(freshFromServer);
  });

  it('a retained task keeps its WS state when the snapshot carries an OLDER row', () => {
    // The snapshot was taken between the create and the session link: it has the
    // task but no session_id. Adopting it blanked the slot's panel until the next
    // event ("no session yet" card for ~7s in the live repro).
    const old = task({ id: 'old' });
    const linked = task({ id: 'fresh', session_id: 'sid-1', updated_at: '2026-09-11T00:00:02Z' });
    const snapshotRow = { ...linked, session_id: undefined, updated_at: '2026-09-11T00:00:01Z' };
    const next = mergeFetchedTasks([linked, old], [snapshotRow, { ...old }], new Set(['fresh']));
    expect(next[0]).toBe(linked);
    expect(next[0].session_id).toBe('sid-1');
  });

  it('a task that is NOT retained never uses the updated_at tie-break (the fetch is authoritative)', () => {
    const newerLocally = task({ id: 'a', title: 'optimistic', updated_at: '2026-09-11T00:00:05Z' });
    const snapshotRow = { ...newerLocally, title: 'server', updated_at: '2026-09-11T00:00:01Z' };
    const next = mergeFetchedTasks([newerLocally], [snapshotRow]);
    expect(next[0]).toBe(snapshotRow);
  });

  it('a task NOT retained is still dropped when the fetch lacks it (a deletion must win)', () => {
    const old = task({ id: 'old' });
    const gone = task({ id: 'gone' });
    const next = mergeFetchedTasks([gone, old], [{ ...old }], new Set(['somebody-else']));
    expect(next.map((t) => t.id)).toEqual(['old']);
  });

  it('an empty retain set behaves exactly like no retain set', () => {
    const a = task({ id: 'a' });
    const prev = [a];
    expect(mergeFetchedTasks(prev, [{ ...a }], new Set())).toBe(prev);
  });
});
