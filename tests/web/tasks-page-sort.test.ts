/**
 * /tasks table sort + group helpers (web/src/components/tasks/tasks-page-sort.ts).
 * Pure logic — no React mount.
 */
import { describe, it, expect } from 'vitest';
import {
  sortTasks,
  groupTasksByProject,
  reorderProjectsByDrag,
  type TpSort,
} from '../../web/src/components/tasks/tasks-page-sort';
import type { Task } from '@open-walnut/core';

let seq = 0;
function task(over: Partial<Task>): Task {
  seq += 1;
  return {
    id: `t-${seq}`,
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

describe('sortTasks', () => {
  it('null sort returns the input order untouched', () => {
    const a = task({ title: 'zzz' });
    const b = task({ title: 'aaa' });
    expect(sortTasks([a, b], null).map((t) => t.id)).toEqual([a.id, b.id]);
  });

  it('sorts by title asc/desc', () => {
    const a = task({ title: 'banana' });
    const b = task({ title: 'apple' });
    const asc: TpSort = { key: 'title', dir: 'asc' };
    expect(sortTasks([a, b], asc).map((t) => t.title)).toEqual(['apple', 'banana']);
    expect(sortTasks([a, b], { key: 'title', dir: 'desc' }).map((t) => t.title)).toEqual(['banana', 'apple']);
  });

  it('priority: none sinks to the bottom in BOTH directions', () => {
    const p0 = task({ priority: 'immediate' });
    const p2 = task({ priority: 'backlog' });
    const none = task({ priority: 'none' });
    const asc = sortTasks([none, p2, p0], { key: 'priority', dir: 'asc' });
    expect(asc.map((t) => t.priority)).toEqual(['immediate', 'backlog', 'none']);
    const desc = sortTasks([none, p2, p0], { key: 'priority', dir: 'desc' });
    expect(desc.map((t) => t.priority)).toEqual(['backlog', 'immediate', 'none']);
  });

  it('due: dateless tasks stay last in both directions', () => {
    const early = task({ due_date: '2026-08-01' });
    const late = task({ due_date: '2026-09-01' });
    const never = task({});
    const asc = sortTasks([never, late, early], { key: 'due', dir: 'asc' });
    expect(asc.map((t) => t.id)).toEqual([early.id, late.id, never.id]);
    const desc = sortTasks([never, late, early], { key: 'due', dir: 'desc' });
    expect(desc.map((t) => t.id)).toEqual([late.id, early.id, never.id]);
  });

  it('session: running first, sessionless last regardless of direction', () => {
    const running = task({ session_status: { process_status: 'running' } } as Partial<Task>);
    const idle = task({ session_status: { process_status: 'idle' } } as Partial<Task>);
    const bare = task({});
    const asc = sortTasks([bare, idle, running], { key: 'session', dir: 'asc' });
    expect(asc.map((t) => t.id)).toEqual([running.id, idle.id, bare.id]);
    const desc = sortTasks([bare, idle, running], { key: 'session', dir: 'desc' });
    expect(desc.map((t) => t.id)).toEqual([idle.id, running.id, bare.id]);
  });
});

describe('groupTasksByProject', () => {
  it('orders by projectOrder first, then alphabetical; Inbox pinned last', () => {
    const t1 = task({ project: 'Zeta' });
    const t2 = task({ project: 'Alpha' });
    const t3 = task({ project: '' });
    const t4 = task({ project: 'Marina' });
    const groups = groupTasksByProject([t1, t2, t3, t4], ['Marina']);
    expect(groups.map((g) => g.project)).toEqual(['Marina', 'Alpha', 'Zeta', '']);
  });

  it('projectOrder matching is case-insensitive', () => {
    const t1 = task({ project: 'beta' });
    const t2 = task({ project: 'Acme' });
    const groups = groupTasksByProject([t1, t2], ['BETA']);
    expect(groups.map((g) => g.project)).toEqual(['beta', 'Acme']);
  });

  it('no Inbox group when no project-less tasks', () => {
    const t1 = task({ project: 'Acme' });
    expect(groupTasksByProject([t1], []).map((g) => g.project)).toEqual(['Acme']);
  });
});

describe('reorderProjectsByDrag', () => {
  it('moves active before target within the explicit order', () => {
    expect(reorderProjectsByDrag(['A', 'B', 'C'], ['A', 'B', 'C'], 'C', 'A'))
      .toEqual(['C', 'A', 'B']);
  });

  it('handles projects missing from the explicit order (appended from view order)', () => {
    // Order only knows A; view shows A, B, C. Dragging C above A must work.
    expect(reorderProjectsByDrag(['A'], ['A', 'B', 'C'], 'C', 'A'))
      .toEqual(['C', 'A', 'B']);
  });

  it('no-ops on self-drop and unknown names', () => {
    expect(reorderProjectsByDrag(['A', 'B'], ['A', 'B'], 'A', 'A')).toBeNull();
    expect(reorderProjectsByDrag(['A', 'B'], ['A', 'B'], 'X', 'A')).toBeNull();
  });

  it('matches case-insensitively', () => {
    expect(reorderProjectsByDrag(['Alpha', 'Beta'], ['Alpha', 'Beta'], 'beta', 'ALPHA'))
      .toEqual(['Beta', 'Alpha']);
  });
});
