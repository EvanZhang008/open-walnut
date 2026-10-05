import { describe, it, expect } from 'vitest';
import { isCrowdedRow, syncRowPillCrowd } from '../../web/src/hooks/useRowPillFold';

type Kind = 'tags' | 'pill' | 'other';
const CLASS: Record<Kind, string> = { tags: 'task-tag-pills', pill: 'task-row-pill', other: 'todo-item-title' };

function fakeRow(kinds: Kind[], rowClass = 'todo-item-title-row') {
  const attrs = new Set<string>();
  return {
    children: kinds.map((k) => ({ classList: { contains: (c: string) => c === CLASS[k] } })),
    matches: (selector: string) => selector.split(',').map((s) => s.trim()).includes(`.${rowClass}`),
    toggleAttribute: (name: string, on: boolean) => { if (on) attrs.add(name); else attrs.delete(name); return on; },
    attrs,
  };
}

const permutations = <T,>(xs: T[]): T[][] =>
  xs.length <= 1 ? [xs] : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((rest) => [x, ...rest]));

describe('isCrowdedRow', () => {
  it('leaves a row with a lone pill, or only tags, alone', () => {
    expect(isCrowdedRow(fakeRow(['other', 'pill']) as unknown as Element)).toBe(false);
    expect(isCrowdedRow(fakeRow(['other', 'tags']) as unknown as Element)).toBe(false);
    expect(isCrowdedRow(fakeRow(['other']) as unknown as Element)).toBe(false);
  });

  it('crowds a row with two pills, or a tag group beside a pill, in any order', () => {
    for (const order of permutations<Kind>(['other', 'pill', 'pill'])) {
      expect(isCrowdedRow(fakeRow(order) as unknown as Element), order.join()).toBe(true);
    }
    for (const order of permutations<Kind>(['other', 'tags', 'pill'])) {
      expect(isCrowdedRow(fakeRow(order) as unknown as Element), order.join()).toBe(true);
    }
    expect(isCrowdedRow(fakeRow(['other', 'tags', 'pill', 'pill', 'pill']) as unknown as Element)).toBe(true);
  });
});

describe('syncRowPillCrowd', () => {
  it('sets and clears data-pill-crowd as the pills come and go', () => {
    const row = fakeRow(['other', 'pill', 'pill']);
    syncRowPillCrowd(row as unknown as Element);
    expect(row.attrs.has('data-pill-crowd')).toBe(true);
    row.children.pop();
    syncRowPillCrowd(row as unknown as Element);
    expect(row.attrs.has('data-pill-crowd')).toBe(false);
  });

  it('ignores a parent that is not a task row (the session header draws the same pills)', () => {
    const header = fakeRow(['pill', 'pill'], 'session-panel-title-meta');
    syncRowPillCrowd(header as unknown as Element);
    expect(header.attrs.size).toBe(0);
  });

  it('covers the list row, the Focus card and the pinned card', () => {
    for (const cls of ['todo-item-title-row', 'todo-focus-card', 'todo-pinned-card']) {
      const row = fakeRow(['pill', 'pill'], cls);
      syncRowPillCrowd(row as unknown as Element);
      expect(row.attrs.has('data-pill-crowd'), cls).toBe(true);
    }
  });
});
