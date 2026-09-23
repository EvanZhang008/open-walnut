/**
 * Row batching in the home task list (web/src/components/tasks/list-batch.ts).
 *
 * An open project draws its first rows and a "Show more" row. These pin the cut: the
 * slack that avoids a "Show more" for a few tasks, the kept (located or focused) row that
 * is never cut off yet never drags the whole list in with it, and the folded-folder
 * members that ride along without using up the batch.
 */
import { describe, it, expect } from 'vitest';
import {
  LIST_BATCH, LIST_BATCH_SLACK, cutListBatch, isPastBatch,
} from '../../web/src/components/tasks/list-batch';

const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `t${i}` }));
const ids = (list: { id: string }[]) => list.map(r => r.id);
const all = () => true;
const none = () => false;
const keep = (...keptIds: string[]) => (id: string) => keptIds.includes(id);

describe('cutListBatch', () => {
  it('draws everything when the overflow is within the slack', () => {
    const list = rows(LIST_BATCH + LIST_BATCH_SLACK);
    expect(cutListBatch(list, LIST_BATCH, none, all)).toEqual({ head: list, tail: [], hidden: 0 });
  });

  it('cuts a long list to the batch and counts what is left', () => {
    const cut = cutListBatch(rows(100), LIST_BATCH, none, all);
    expect(ids(cut.head)).toEqual(ids(rows(LIST_BATCH)));
    expect(cut.tail).toEqual([]);
    expect(cut.hidden).toBe(100 - LIST_BATCH);
  });

  it('extends the cut to a kept row just past it', () => {
    const cut = cutListBatch(rows(100), LIST_BATCH, keep('t45'), all);
    expect(cut.head.at(-1)!.id).toBe('t45');
    expect(cut.tail).toEqual([]);
    expect(cut.hidden).toBe(54);
  });

  it('draws a kept row far past the cut on its own, not the rows before it', () => {
    const cut = cutListBatch(rows(3000), LIST_BATCH, keep('t2000'), all);
    expect(cut.head).toHaveLength(LIST_BATCH);
    expect(ids(cut.tail)).toEqual(['t2000']);
    expect(cut.hidden).toBe(3000 - LIST_BATCH - 1);
  });

  it('keeps several far rows in list order', () => {
    const cut = cutListBatch(rows(3000), LIST_BATCH, keep('t2500', 't900'), all);
    expect(ids(cut.tail)).toEqual(['t900', 't2500']);
  });

  it('draws everything once a kept row leaves only the slack undrawn', () => {
    // 47 rows, kept row 45: the cut reaches it and two rows would be left behind a "Show more".
    const list = rows(47);
    expect(cutListBatch(list, LIST_BATCH, keep('t45'), all)).toEqual({ head: list, tail: [], hidden: 0 });
  });

  it('ignores a kept id that is not in this list', () => {
    expect(cutListBatch(rows(100), LIST_BATCH, keep('elsewhere'), all).head).toHaveLength(LIST_BATCH);
  });

  it('lets unseen rows ride along without using up the batch', () => {
    // Every odd row is a folded folder member: 200 rows, 100 seen.
    const seen = (r: { id: string }) => Number(r.id.slice(1)) % 2 === 0;
    const cut = cutListBatch(rows(200), LIST_BATCH, none, seen);
    expect(cut.head.filter(seen)).toHaveLength(LIST_BATCH);
    // The unseen row right after the last seen one comes along, so a folder member is
    // never left undrawn right under its drawn neighbour.
    expect(cut.head.at(-1)!.id).toBe(`t${LIST_BATCH * 2 - 1}`);
    expect(cut.hidden).toBe(100 - LIST_BATCH);
  });

  it('grows with the limit', () => {
    expect(cutListBatch(rows(100), LIST_BATCH * 2, none, all).head).toHaveLength(LIST_BATCH * 2);
    expect(cutListBatch(rows(100), LIST_BATCH * 3, none, all).hidden).toBe(0);
  });

  it('folds a far kept row back into the head once the limit reaches it', () => {
    const cut = cutListBatch(rows(3000), 2010, keep('t2000'), all);
    expect(cut.tail).toEqual([]);
    expect(cut.head).toHaveLength(2010);
  });

  it('handles an empty list', () => {
    expect(cutListBatch([], LIST_BATCH, keep('x'), all)).toEqual({ head: [], tail: [], hidden: 0 });
  });
});

describe('isPastBatch', () => {
  it('is false inside the batch and true past it', () => {
    expect(isPastBatch(rows(100), LIST_BATCH, 't29', all)).toBe(false);
    expect(isPastBatch(rows(100), LIST_BATCH, 't30', all)).toBe(true);
  });

  it('counts only seen rows before the target', () => {
    const seen = (r: { id: string }) => Number(r.id.slice(1)) % 2 === 0;
    // t58 is the 30th seen row (index 29): still inside the first batch.
    expect(isPastBatch(rows(200), LIST_BATCH, 't58', seen)).toBe(false);
    expect(isPastBatch(rows(200), LIST_BATCH, 't60', seen)).toBe(true);
  });

  it('is false for a row that is not in the list', () => {
    expect(isPastBatch(rows(100), LIST_BATCH, 'elsewhere', all)).toBe(false);
  });
});
