/**
 * Watching's drag order (2026-11-09, the user: "I want this watch to be able to reorder by drag").
 * The order is each task's own `watched_at`, so every surface that lists the watch (Home on every
 * device, the Org page, the phone) follows a drag with no list of its own. watchReorder writes the
 * moved row a time between its new neighbours; a new watch, stamped now, lands at the bottom.
 */
import { describe, expect, it } from 'vitest';
import type { Task } from '../../src/core/types';
import { sortSectionTasks, watchReorder } from '../../web/src/components/tasks/status-sections';

const T0 = Date.parse('2026-11-09T10:00:00.000Z');
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const row = (id: string, watched_at: string) => ({ id, title: id, status: 'todo', phase: 'TODO', priority: 'none', project: 'P', watched_at, created_at: at(0), updated_at: at(0) }) as unknown as Task;
const rows = () => [row('a', at(0)), row('b', at(10)), row('c', at(20)), row('d', at(30))];
/** Apply the writes and read Watching's order back, the way every surface sorts it. */
const after = (list: Task[], writes: { id: string; watched_at: string }[]) => {
  const byId = new Map(writes.map((w) => [w.id, w.watched_at]));
  return sortSectionTasks('watching', list.map((t) => (byId.has(t.id) ? { ...t, watched_at: byId.get(t.id) } as Task : t))).map((t) => t.id);
};
const NOW = T0 + 3600_000;

describe('watchReorder', () => {
  it('a row dropped between two others takes one write between their times', () => {
    const w = watchReorder(rows(), 'd', 1, NOW);
    expect(w).toHaveLength(1);
    expect(after(rows(), w)).toEqual(['a', 'd', 'b', 'c']);
    expect(after(rows(), watchReorder(rows(), 'a', 2, NOW))).toEqual(['b', 'c', 'a', 'd']);
  });

  it('to the top and to the bottom', () => {
    expect(after(rows(), watchReorder(rows(), 'c', 0, NOW))).toEqual(['c', 'a', 'b', 'd']);
    const bottom = watchReorder(rows(), 'a', 3, NOW);
    expect(after(rows(), bottom)).toEqual(['b', 'c', 'd', 'a']);
    // At the bottom it is stamped now, so a watch made later still lands below it.
    expect(Date.parse(bottom[0].watched_at)).toBe(NOW);
  });

  it('a new watch lands at the bottom, after a drag', () => {
    const list = rows();
    const moved = after(list, watchReorder(list, 'd', 0, NOW));
    expect(moved).toEqual(['d', 'a', 'b', 'c']);
    const fresh = row('e', new Date(NOW + 1000).toISOString());
    expect(sortSectionTasks('watching', [...list, fresh]).map((t) => t.id).pop()).toBe('e');
  });

  it('no room between the same millisecond: only the tied run after it moves on', () => {
    const same = [row('a', at(0)), row('b', at(0)), row('c', at(0)), row('d', at(40))];
    const w = watchReorder(same, 'c', 1, NOW);
    expect(after(same, w)).toEqual(['a', 'c', 'b', 'd']);
    expect(w.map((x) => x.id).sort()).toEqual(['b', 'c']);
  });

  it('a drop on the last row shown lands there, not past the rows behind Show more', () => {
    const many = Array.from({ length: 40 }, (_, i) => row(`r${i}`, at(i * 10)));
    // The top row dropped on row 30 (index 29): 29 rows above it, the other 10 still below.
    const order = after(many, watchReorder(many, 'r0', 29, NOW));
    expect(order.indexOf('r0')).toBe(29);
    expect(order.slice(30)).toEqual(many.slice(30).map((t) => t.id));
  });

  it('a row with no readable time still gets a place', () => {
    const odd = [row('a', 'not a time'), row('b', at(0)), row('c', at(10))];
    expect(after(odd, watchReorder(odd, 'c', 0, NOW))).toEqual(['c', 'a', 'b']);
  });

  it('a drop on its own place, or outside the list, writes nothing', () => {
    expect(watchReorder(rows(), 'b', 1, NOW)).toEqual([]);
    expect(watchReorder(rows(), 'b', 9, NOW)).toEqual([]);
    expect(watchReorder(rows(), 'x', 0, NOW)).toEqual([]);
  });

  it('Watching sorts by the instant, whatever the ISO text looks like', () => {
    const mixed = [row('late', '2026-11-09T10:00:05Z'), row('early', '2026-11-09T10:00:01.500Z')];
    expect(sortSectionTasks('watching', mixed).map((t) => t.id)).toEqual(['early', 'late']);
  });
});
