/**
 * Older pages of a windowed transcript: the pure folds behind "Load earlier messages"
 * on a session past the full read's byte ceiling (2026-10-04: a 38 MB session whose
 * button re-served the same tail on every click).
 *
 * Pinned here: a fresh tail never throws away pages the reader loaded above it, a
 * page only joins where it provably touches, and the cursor (a count of the array the
 * client holds, which the next anchored delta extends) moves with the pages.
 */
import { describe, it, expect } from 'vitest';
import { stitchHeldOlder, prependOlderPage, foldFullPayload, planDeltaMerge } from '../../web/src/hooks/history-merge';

interface Row { msgId?: string; timestamp?: string; role?: string; text?: string }

function row(i: number, extra: Partial<Row> = {}): Row {
  return {
    msgId: `m${i}`,
    role: i % 2 === 0 ? 'user' : 'assistant',
    text: `message ${i}`,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    ...extra,
  };
}
const range = (from: number, to: number): Row[] => Array.from({ length: to - from }, (_, k) => row(from + k));
const ids = (rows: Row[]) => rows.map((r) => r.msgId);

describe('stitchHeldOlder', () => {
  it('keeps the pages above a fresh tail when the tail head is a row already held', () => {
    const held = range(0, 300);          // pages 0..199 + the old tail 200..299
    const incoming = range(200, 310);    // the server's tail, grown by 10 rows
    const out = stitchHeldOlder(held, incoming);
    expect(out).toHaveLength(310);
    expect(ids(out)[0]).toBe('m0');
    expect(ids(out)[309]).toBe('m309');
  });

  it('drops what is held when the window slid past it (no shared row, so the gap is unknown)', () => {
    const held = range(0, 100);
    const incoming = range(500, 600);
    expect(stitchHeldOlder(held, incoming)).toEqual(incoming);
  });

  it('a tail that starts where the held rows start adds nothing above it', () => {
    const held = range(200, 300);
    const incoming = range(200, 305);
    expect(stitchHeldOlder(held, incoming)).toEqual(incoming);
  });

  it('an empty tail, or one whose head has no msgId, stands alone', () => {
    const held = range(0, 50);
    expect(stitchHeldOlder(held, [])).toEqual([]);
    const idless = [{ role: 'user', text: 'x', timestamp: '2026-01-01T00:00:00.000Z' }];
    expect(stitchHeldOlder(held, idless)).toEqual(idless);
  });

  it('tells the two halves of a message split across a seam apart by timestamp', () => {
    // One assistant message written as two lines: the earlier line fell in the older
    // page, the later one opens the tail window. Same msgId, different timestamps.
    const first = row(10, { msgId: 'split', timestamp: '2026-01-01T00:00:10.000Z', role: 'assistant' });
    const second = row(11, { msgId: 'split', timestamp: '2026-01-01T00:00:11.000Z', role: 'assistant' });
    const held = [...range(0, 10), first, second, ...range(12, 20)];
    const incoming = [second, ...range(12, 25)];
    const out = stitchHeldOlder(held, incoming);
    expect(out.filter((r) => r.msgId === 'split')).toHaveLength(2);
    expect(out).toHaveLength(10 + 1 + incoming.length);
  });
});

describe('prependOlderPage', () => {
  it('puts the page above the rows held, oldest first', () => {
    const out = prependOlderPage(range(100, 150), range(50, 100));
    expect(ids(out)[0]).toBe('m50');
    expect(ids(out)[99]).toBe('m149');
    expect(out).toHaveLength(100);
  });

  it('a page fetched twice cannot double a row', () => {
    const held = [...range(50, 100), ...range(100, 150)];
    const out = prependOlderPage(held, range(50, 100));
    expect(out).toHaveLength(100);
    expect(prependOlderPage(held, range(50, 100))).toBe(held);
  });

  it('an empty page returns the same array (no re-render)', () => {
    const held = range(0, 10);
    expect(prependOlderPage(held, [])).toBe(held);
  });
});

describe('foldFullPayload', () => {
  it('a non-windowed payload is the whole answer', () => {
    const incoming = range(0, 40);
    const out = foldFullPayload(range(0, 500), { messages: incoming, cursor: 40 });
    expect(out.messages).toBe(incoming);
    expect(out.cursor).toBe(40);
    expect(out.kept).toBe(0);
  });

  it('a windowed payload keeps the loaded pages and the cursor counts them', () => {
    const held = range(0, 300);
    const out = foldFullPayload(held, { messages: range(200, 300), cursor: 100, windowed: true });
    expect(out.messages).toHaveLength(300);
    expect(out.cursor).toBe(300);
    expect(out.kept).toBe(200);
  });

  it('with nothing in common the cursor is the payload cursor, untouched', () => {
    const out = foldFullPayload(range(0, 10), { messages: range(500, 600), cursor: 100, windowed: true });
    expect(out.messages).toHaveLength(100);
    expect(out.cursor).toBe(100);
    expect(out.kept).toBe(0);
  });

  it('the next anchored delta still lines up after a page was added (no rebuild)', () => {
    // The client holds 300 rows (100 tail + 200 pages); the server's delta cursor is
    // client-anchored: `since + slice.length`. The length guard must accept it.
    const held = range(0, 300);
    const delta = range(300, 302);
    const plan = planDeltaMerge(held, { messages: delta, cursor: 300 + delta.length }, 300, { baseOffset: 0 });
    expect(plan.kind).toBe('merged');
    if (plan.kind === 'merged') expect(plan.messages).toHaveLength(302);
  });
});
