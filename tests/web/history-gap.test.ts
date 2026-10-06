/**
 * A turn bigger than the server can reach back through: the refetch is a window
 * that shares no row with what the client holds. Reported 2026-10-05 (a 336 MB
 * session of screenshots): swapping the window in wiped every earlier reply and
 * piled the user's messages at the bottom until a reload.
 *
 * Pinned here: the held rows and the window are laid end to end with a gap
 * between them only when the window is provably later; older pages fill the gap
 * from the window's side, never doubling a row, and close it once they reach
 * the held side; a delivered bubble whose row is in the gap is accounted for.
 */
import { describe, it, expect } from 'vitest';
import { appendAcrossGap, fillGap, gapIndex, liveGaps, type HistoryGap } from '@/hooks/history-gap';
import { dedupeOptimisticMessages, BUBBLE_CLOCK_SLACK_MS } from '@/components/sessions/optimistic-dedup';
import { foldFullPayload, planDeltaMerge } from '@/hooks/history-merge';

type Row = { msgId: string; role: 'user' | 'assistant'; text: string; timestamp: string };
const T0 = Date.parse('2026-10-05T10:00:00.000Z');
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const row = (id: string, s: number, role: Row['role'] = 'assistant', text = id): Row => ({ msgId: id, role, text, timestamp: at(s) });
const ids = (rows: { msgId?: string }[]) => rows.map((r) => r.msgId);

// Held: turns 1-2. The turn-3 refetch is a window holding only its last rows.
const held = [row('u1', 0, 'user'), row('a1', 5), row('u2', 60, 'user'), row('a2', 65)];
const window3 = [row('t3-shot-40', 400), row('a3', 405)];

describe('appendAcrossGap', () => {
  it('keeps every held row and puts the window after a gap', () => {
    const got = appendAcrossGap(held, window3)!;
    expect(ids(got.messages)).toEqual(['u1', 'a1', 'u2', 'a2', 't3-shot-40', 'a3']);
    expect(got.gap).toEqual({ afterKey: 't3-shot-40|' + at(400) + '|assistant', beforeTs: at(65), afterTs: at(400) });
    expect(gapIndex(got.messages, got.gap)).toBe(4);
  });

  it('refuses when the two share a row (the ordinary stitch handles an overlap)', () => {
    expect(appendAcrossGap(held, [row('a2', 65), row('a3', 405)])).toBeNull();
  });

  it('refuses a window that is not later than the held rows (rewritten history)', () => {
    expect(appendAcrossGap(held, [row('other', 30), row('a3', 405)])).toBeNull();
  });

  it('refuses an empty side or an undated one', () => {
    expect(appendAcrossGap([], window3)).toBeNull();
    expect(appendAcrossGap(held, [])).toBeNull();
    expect(appendAcrossGap(held, [{ msgId: 'x', role: 'assistant', text: 'x', timestamp: '' }])).toBeNull();
  });
});

describe('fillGap', () => {
  const start = appendAcrossGap(held, window3)!;

  it('a page that reaches the held side closes the gap with every missing row once, in order', () => {
    const page = [row('a2', 65), row('u3', 120, 'user'), row('t3-shot-1', 125), row('t3-shot-39', 395)];
    const got = fillGap(start.messages, start.gap, page, false);
    expect(ids(got.messages)).toEqual(['u1', 'a1', 'u2', 'a2', 'u3', 't3-shot-1', 't3-shot-39', 't3-shot-40', 'a3']);
    expect(got.inserted).toBe(3);
    expect(got.gap).toBeNull();
  });

  it('a page that does not reach it shrinks the gap to before its oldest row, and the next page closes it', () => {
    const first = fillGap(start.messages, start.gap, [row('t3-shot-20', 300), row('t3-shot-39', 395)], false);
    expect(first.gap?.afterKey).toBe('t3-shot-20|' + at(300) + '|assistant');
    expect(gapIndex(first.messages, first.gap!)).toBe(4);
    const second = fillGap(first.messages, first.gap!, [row('u3', 120, 'user'), row('t3-shot-19', 295)], true);
    expect(ids(second.messages)).toEqual(['u1', 'a1', 'u2', 'a2', 'u3', 't3-shot-19', 't3-shot-20', 't3-shot-39', 't3-shot-40', 'a3']);
    expect(second.gap).toBeNull();
  });

  it('a row older than the held side closes the gap without being placed in it', () => {
    const got = fillGap(start.messages, start.gap, [row('a1', 5), row('u3', 120, 'user')], false);
    expect(ids(got.messages)).toEqual(['u1', 'a1', 'u2', 'a2', 'u3', 't3-shot-40', 'a3']);
    expect(got.gap).toBeNull();
  });

  it('an empty page closes the gap: nothing is left between the sides', () => {
    const got = fillGap(start.messages, start.gap, [], false);
    expect(got.messages).toEqual(start.messages);
    expect(got.gap).toBeNull();
  });

  it('a gap whose after row is gone does nothing', () => {
    const gone: HistoryGap = { afterKey: 'missing|x|assistant', beforeTs: at(65), afterTs: at(400) };
    expect(fillGap(start.messages, gone, [row('u3', 120, 'user')], false)).toEqual({ messages: start.messages, inserted: 0, gap: null });
  });
});

describe('liveGaps', () => {
  it('drops a gap whose after row left the array and re-reads the sides of one that stayed', () => {
    const start = appendAcrossGap(held, window3)!;
    // Older page prepended above everything: the gap moves, its sides do not change.
    const moved = [row('u0', -60, 'user'), ...start.messages];
    expect(liveGaps(moved, [start.gap])).toEqual([start.gap]);
    expect(liveGaps(held, [start.gap])).toEqual([]);
    expect(liveGaps(moved, undefined)).toEqual([]);
  });
});

describe('a delivered bubble whose row is in the gap', () => {
  type Bubble = { text: string; status: string; queueId: string; timestamp?: string };
  const bubble = (queueId: string, s: number, status = 'delivered'): Bubble => ({ text: queueId, status, queueId, timestamp: at(s) });
  const start = appendAcrossGap(held, window3)!;
  const gaps = liveGaps(start.messages, [start.gap]);
  const open = (bs: Bubble[], g = gaps) => dedupeOptimisticMessages(bs, start.messages, start.messages.length, { historyFromStart: true, gaps: g }).map((b) => b.queueId);

  it('is accounted for; without the gap it would stay pinned at the bottom', () => {
    expect(open([bubble('turn-3 ask', 118)])).toEqual([]);
    expect(open([bubble('turn-3 ask', 118)], [])).toEqual(['turn-3 ask']);
  });

  it('stays when it is not delivered yet, or was enqueued too close to the row after the gap', () => {
    expect(open([bubble('queued', 118, 'received')])).toEqual(['queued']);
    expect(open([bubble('late', 400 - BUBBLE_CLOCK_SLACK_MS / 1000 + 1)])).toEqual(['late']);
  });

  it('stays when it was enqueued before the held side: its row belongs among the held rows', () => {
    expect(open([bubble('old', 65 - BUBBLE_CLOCK_SLACK_MS / 1000 - 5)])).toEqual(['old']);
  });
});

describe('foldFullPayload across a gap', () => {
  it('a windowed payload with nothing in common is laid after the held rows; the cursor counts them', () => {
    const out = foldFullPayload(held, { messages: window3, cursor: 2, windowed: true }, { acrossGap: true });
    expect(ids(out.messages)).toEqual(['u1', 'a1', 'u2', 'a2', 't3-shot-40', 'a3']);
    expect(out.cursor).toBe(6);
    expect(out.kept).toBe(4);
    expect(out.gaps).toHaveLength(1);
    // The next anchored delta extends the client's array: since + slice.
    const plan = planDeltaMerge(out.messages, { messages: [row('u4', 500, 'user')], cursor: 7 }, out.cursor, { baseOffset: 0 });
    expect(plan.kind).toBe('merged');
  });

  it('without acrossGap (held is not the transcript parse) the window stands alone', () => {
    const out = foldFullPayload(held, { messages: window3, cursor: 2, windowed: true });
    expect(ids(out.messages)).toEqual(['t3-shot-40', 'a3']);
    expect(out.gaps).toEqual([]);
  });

  it('a window that touches what is held keeps a gap above its head and closes one inside it', () => {
    const first = foldFullPayload(held, { messages: window3, cursor: 2, windowed: true }, { acrossGap: true });
    // The next window starts at the gap's after row: the gap above it stays open.
    const grown = foldFullPayload(first.messages, { messages: [...window3, row('a4', 410)], cursor: 3, windowed: true }, { acrossGap: true, gaps: first.gaps });
    expect(ids(grown.messages)).toEqual(['u1', 'a1', 'u2', 'a2', 't3-shot-40', 'a3', 'a4']);
    expect(grown.gaps).toEqual(first.gaps);
    // A window starting inside the held side and running past the gap proves the
    // rows between are what it holds: the gap is closed.
    const covered = foldFullPayload(first.messages, { messages: [row('a2', 65), row('u3', 120, 'user'), ...window3], cursor: 4, windowed: true }, { acrossGap: true, gaps: first.gaps });
    expect(ids(covered.messages)).toEqual(['u1', 'a1', 'u2', 'a2', 'u3', 't3-shot-40', 'a3']);
    expect(covered.gaps).toEqual([]);
  });

  it('a complete payload closes every gap', () => {
    const first = foldFullPayload(held, { messages: window3, cursor: 2, windowed: true }, { acrossGap: true });
    const full = foldFullPayload(first.messages, { messages: [...held, row('u3', 120, 'user'), ...window3], cursor: 7 }, { acrossGap: true, gaps: first.gaps });
    expect(full.gaps).toEqual([]);
    expect(full.messages).toHaveLength(7);
  });

  it('a second gap keeps the first', () => {
    const first = foldFullPayload(held, { messages: window3, cursor: 2, windowed: true }, { acrossGap: true });
    const next = [row('t5-shot-9', 900), row('a5', 905)];
    const second = foldFullPayload(first.messages, { messages: next, cursor: 2, windowed: true }, { acrossGap: true, gaps: first.gaps });
    expect(second.gaps.map((g) => g.afterKey)).toEqual([first.gaps[0].afterKey, 't5-shot-9|' + at(900) + '|assistant']);
    expect(second.cursor).toBe(8);
  });
});
