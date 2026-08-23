/**
 * Group chip sentinels in the pinned tiers (2026-08-22 fix).
 *
 * The chip that heads a virtual group is a real dnd-kit sortable unit, and its id has
 * to be in the tier's SortableContext items for dnd-kit to displace it and to measure
 * it. These are the pure pieces that build and prune that id list; the on-screen half
 * lives in tests/e2e/browser/pinned-group-drag.spec.ts.
 */
import { describe, it, expect } from 'vitest';
import type { Task } from '@open-walnut/core';
import {
  groupSortableId, parseGroupSentinelGid, isGroupSentinel, taskIdsOnly,
  withGroupSentinels, pruneOrphanSentinels,
} from '@/components/tasks/tier-group-sentinels';

function task(id: string, group_id?: string): Task {
  return { id, title: id, status: 'todo', source: 'local', created_at: '', updated_at: '', ...(group_id ? { group_id } : {}) } as Task;
}

const byId = (tasks: Task[]) => new Map(tasks.map((t) => [t.id, t]));

describe('sentinel ids', () => {
  it('round-trips a gid through a built-in tier', () => {
    const id = groupSortableId('g_abc', 'focus');
    expect(id).toBe('group:g_abc:focus');
    expect(isGroupSentinel(id)).toBe(true);
    expect(parseGroupSentinelGid(id)).toBe('g_abc');
  });

  it('round-trips through a custom tier id', () => {
    expect(parseGroupSentinelGid(groupSortableId('g_abc', 'ct_12345678'))).toBe('g_abc');
  });

  it('taskIdsOnly keeps real ids and their order', () => {
    expect(taskIdsOnly(['group:g1:focus', 'a', 'b', 'group:g2:focus', 'c'])).toEqual(['a', 'b', 'c']);
  });
});

describe('withGroupSentinels', () => {
  it('inserts one sentinel immediately before each group run', () => {
    const tasks = [task('a'), task('b', 'g1'), task('c', 'g1'), task('d')];
    expect(withGroupSentinels(['a', 'b', 'c', 'd'], tasks, 'focus'))
      .toEqual(['a', 'group:g1:focus', 'b', 'c', 'd']);
  });

  it('gives a one-member group a sentinel too (a lone member still shows its chip)', () => {
    const tasks = [task('a', 'g1'), task('b')];
    expect(withGroupSentinels(['a', 'b'], tasks, 'wait'))
      .toEqual(['group:g1:wait', 'a', 'b']);
  });

  it('handles two adjacent groups without merging them', () => {
    const tasks = [task('a', 'g1'), task('b', 'g1'), task('c', 'g2'), task('d', 'g2')];
    expect(withGroupSentinels(['a', 'b', 'c', 'd'], tasks, 'focus'))
      .toEqual(['group:g1:focus', 'a', 'b', 'group:g2:focus', 'c', 'd']);
  });

  it('is idempotent — re-running does not double up sentinels', () => {
    const tasks = [task('a'), task('b', 'g1'), task('c', 'g1')];
    const once = withGroupSentinels(['a', 'b', 'c'], tasks, 'focus');
    expect(withGroupSentinels(once, tasks, 'focus')).toEqual(once);
  });

  it('encodes the tier, so the same group in two tiers gets distinct ids', () => {
    const tasks = [task('a', 'g1'), task('b', 'g1')];
    expect(withGroupSentinels(['a'], tasks, 'focus')[0]).toBe('group:g1:focus');
    expect(withGroupSentinels(['b'], tasks, 'backlog')[0]).toBe('group:g1:backlog');
  });

  it('leaves an ungrouped tier untouched', () => {
    const tasks = [task('a'), task('b')];
    expect(withGroupSentinels(['a', 'b'], tasks, 'focus')).toEqual(['a', 'b']);
  });
});

describe('pruneOrphanSentinels', () => {
  const tasks = [task('a'), task('b', 'g1'), task('c', 'g1')];

  it('keeps a sentinel that still heads its run', () => {
    const ids = ['a', 'group:g1:focus', 'b', 'c'];
    expect(pruneOrphanSentinels(ids, byId(tasks), null)).toEqual(ids);
  });

  it('drops a sentinel whose members were all filtered out', () => {
    // A search or project scope hid b and c; the chip would otherwise be an items
    // entry with no element (no rect) and a header above nothing.
    expect(pruneOrphanSentinels(['a', 'group:g1:focus'], byId(tasks), null)).toEqual(['a']);
  });

  it('keeps the sentinel being dragged even with no members after it', () => {
    // Collapse-on-drag deliberately removes the members; the chip IS the cluster.
    expect(pruneOrphanSentinels(['a', 'group:g1:focus'], byId(tasks), 'group:g1:focus'))
      .toEqual(['a', 'group:g1:focus']);
  });

  it('drops a sentinel followed by a DIFFERENT group', () => {
    const two = [...tasks, task('d', 'g2')];
    expect(pruneOrphanSentinels(['group:g1:focus', 'group:g2:focus', 'd'], byId(two), null))
      .toEqual(['group:g2:focus', 'd']);
  });

  it('returns the same array identity when there is nothing to prune', () => {
    // SortableContext re-registers every item on a new `items` identity (React #185).
    const ids = ['a', 'b'];
    expect(pruneOrphanSentinels(ids, byId(tasks), null)).toBe(ids);
  });
});
