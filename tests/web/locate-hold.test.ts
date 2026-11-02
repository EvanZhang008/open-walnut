/**
 * A locate holds its task on screen while it moves (web/src/components/tasks/locate-hold.ts):
 * the place key that tells a move, the ancestor and folder walks a locate opens, and the gesture
 * window that tells a click in the panel from a locate asked from outside it.
 */
import { describe, expect, it } from 'vitest';
import type { Task } from '../../src/core/types';
import {
  PANEL_GESTURE_MS,
  ancestorChain,
  foldersHolding,
  fromPanelGesture,
  locatePlaceSig,
  type PlaceFacts,
} from '../../web/src/components/tasks/locate-hold';

const task = (patch: Partial<Task> = {}): Task => ({
  id: 't1',
  title: 'Task',
  status: 'todo',
  phase: 'IN_PROGRESS',
  priority: 'none',
  project: 'Garden',
  created_at: '2026-10-01T00:00:00.000Z',
  updated_at: '2026-10-01T00:00:00.000Z',
  ...patch,
} as Task);
const facts: PlaceFacts = { tier: null, passes: true, held: false };

describe('locatePlaceSig', () => {
  const base = task();
  const sig = locatePlaceSig(base, facts);

  it('changes with everything that moves the row (the S4-11 move is a user status change)', () => {
    const moves: Array<[string, Task, PlaceFacts]> = [
      ['user status', task({ user_status: { state: 'waiting' } } as Partial<Task>), facts],
      ['phase', task({ phase: 'WAITING' }), facts],
      ['completed', task({ status: 'done', phase: 'COMPLETE' }), facts],
      ['snoozed', task({ user_status: { state: 'waiting', snoozed: true } } as Partial<Task>), facts],
      ['start date', task({ start_date: '2099-01-01' }), facts],
      ['watched', task({ watched_at: '2026-11-02T00:00:00.000Z' } as Partial<Task>), facts],
      ['project', task({ project: 'Kitchen' }), facts],
      ['folder', task({ group_id: 'g1' }), facts],
      ['parent', task({ parent_task_id: 'p1' }), facts],
      ['tier', base, { ...facts, tier: 'focus' }],
      ['a chip now hides it', base, { ...facts, passes: false }],
      ['its exit grace', base, { ...facts, held: true }],
    ];
    for (const [what, t, f] of moves) expect(locatePlaceSig(t, f), what).not.toBe(sig);
  });

  it('stays put for a change that moves nothing (a title, a new update time)', () => {
    expect(locatePlaceSig(task({ title: 'Renamed', updated_at: '2026-11-02T00:00:00.000Z' }), facts)).toBe(sig);
  });

  it('reads Inbox the same with or without a project field', () => {
    expect(locatePlaceSig(task({ project: '' }), facts)).toBe(locatePlaceSig(task({ project: undefined }), facts));
  });
});

describe('ancestorChain', () => {
  const parents: Record<string, string> = { leaf: 'mid', mid: 'top' };
  it('walks every ancestor, nearest first', () => {
    expect(ancestorChain('leaf', (id) => parents[id])).toEqual(['mid', 'top']);
    expect(ancestorChain('top', (id) => parents[id])).toEqual([]);
  });
  it('stops on a cycle and at the cap', () => {
    const loop: Record<string, string> = { a: 'b', b: 'c', c: 'a' };
    expect(ancestorChain('a', (id) => loop[id])).toEqual(['b', 'c']);
    const deep = (id: string) => `n${Number(id.slice(1)) + 1}`;
    expect(ancestorChain('n0', deep, 3)).toEqual(['n1', 'n2', 'n3']);
  });
});

describe('foldersHolding', () => {
  it('names the row\'s folder, its parents\' folders, and each folder above them, once', () => {
    const groups: Record<string, string> = { leaf: 'inner', mid: 'inner', top: 'other' };
    const above: Record<string, string[]> = { inner: ['outer'], other: [] };
    expect(foldersHolding(['leaf', 'mid', 'top'], (id) => groups[id], (g) => above[g] ?? []).sort())
      .toEqual(['inner', 'other', 'outer']);
  });
  it('is empty for rows in no folder', () => {
    expect(foldersHolding(['a'], () => undefined, () => [])).toEqual([]);
  });
});

describe('fromPanelGesture', () => {
  it('a focus right after a gesture in the panel came from the panel', () => {
    expect(fromPanelGesture(10_000, 9_900)).toBe(true);
  });
  it('a focus long after, or with no gesture at all, came from outside', () => {
    expect(fromPanelGesture(10_000, 10_000 - PANEL_GESTURE_MS)).toBe(false);
    expect(fromPanelGesture(10_000, 0)).toBe(false);
  });
});
