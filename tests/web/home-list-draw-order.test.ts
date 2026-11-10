/**
 * The Home list draws a change it takes at once in the same render (`orderToDraw`): no commit draws
 * the old order and moves rows the next (a task that arrived, a drop in a manual project, new sort
 * settings), while a plain re-sort still waits for the list's 3 s hold.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { orderToDraw } from '@/components/tasks/draw-order';

const none = { settingsChanged: false, manual: new Set<string>() };

describe('orderToDraw', () => {
  it('draws the live order when a task arrived or left', () => {
    expect(orderToDraw(['a', 'b'], ['new', 'a', 'b'], none)).toEqual(['new', 'a', 'b']);
    expect(orderToDraw(['a', 'b', 'c'], ['c', 'a'], none)).toEqual(['c', 'a']);
  });

  it('draws the live order for new sort settings', () => {
    expect(orderToDraw(['a', 'b'], ['b', 'a'], { ...none, settingsChanged: true })).toEqual(['b', 'a']);
  });

  it('draws the live order when manually sorted tasks moved, and only then', () => {
    const manual = new Set(['m1', 'm2']);
    expect(orderToDraw(['m1', 'm2', 'x', 'y'], ['m2', 'm1', 'x', 'y'], { ...none, manual })).toEqual(['m2', 'm1', 'x', 'y']);
    // Tasks sorted by a rule moved, the manual ones did not: that re-sort waits.
    const held = ['m1', 'm2', 'x', 'y'];
    expect(orderToDraw(held, ['m1', 'm2', 'y', 'x'], { ...none, manual })).toBe(held);
  });

  it('keeps the held order for a re-sort of the same tasks', () => {
    const held = ['b', 'a', 'c'];
    expect(orderToDraw(held, ['a', 'b', 'c'], none)).toBe(held);
  });

  it('never sorts again for a task neither order holds (a parent cycle)', () => {
    // The cycle's tasks are in the task list but in neither order; nothing arrived.
    const held = ['a', 'b'];
    expect(orderToDraw(held, ['b', 'a'], none)).toBe(held);
  });
});

describe('the Home list draws through it', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../web/src/components/tasks/TodoPanel.tsx'), 'utf8');

  it('reads its rows from orderToDraw over the held and the live order', () => {
    const memo = src.slice(src.indexOf('const sortedLive = useMemo('), src.indexOf('const sorted = usePhoneHomeList('));
    expect(memo).toMatch(/orderToDraw\(sortOrder, liveOrder,/);
    expect(memo).not.toMatch(/for \(const id of sortOrder\)/);
  });

  it('sorts once per change: the effect takes the live order instead of sorting again', () => {
    const start = src.indexOf('// --- Debounced sort order ---');
    const section = src.slice(start, src.indexOf('const sorted = usePhoneHomeList(', start));
    expect(section.match(/computeSortOrder\(filtered\)/g)).toHaveLength(2); // the initial state and liveOrder
    expect(section).toMatch(/const liveOrder = useMemo\(\(\) => computeSortOrder\(filtered\)/);
  });
});
