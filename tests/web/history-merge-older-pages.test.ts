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
import fs from 'node:fs';
import { stitchHeldOlder, prependOlderPage, foldFullPayload, planDeltaMerge, mergeHistoryBackfill, cacheBehindScreen, heldForkPrefixIsStale, boundaryAfterFold } from '../../web/src/hooks/history-merge';

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

describe('mergeHistoryBackfill', () => {
  it('keeps a newer turn that arrived while an older full snapshot was in flight', () => {
    expect(ids(mergeHistoryBackfill(range(50, 102), range(0, 100)))).toEqual(ids(range(0, 102)));
  });

  it('refuses a stale snapshot after a compaction replaced the transcript', () => {
    const held = range(1000, 1020);
    expect(mergeHistoryBackfill(held, range(0, 100))).toBe(held);
  });

  it('does not undo tool revisions that arrived while backfill was in flight', () => {
    const held = range(50, 100);
    held[10].text = 'Tool completed';
    expect(mergeHistoryBackfill(held, range(0, 100))[60].text).toBe('Tool completed');
  });

  it('accepts a full response newer than the concurrently refreshed tail', () => {
    expect(ids(mergeHistoryBackfill(range(50, 101), range(0, 102)))).toEqual(ids(range(0, 102)));
  });

  it('adopts a complete snapshot at the same newest row without duplicates', () => {
    expect(ids(mergeHistoryBackfill(range(50, 100), range(0, 100)))).toEqual(ids(range(0, 100)));
  });
});

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

describe('a full read never takes away rows already shown (2026-11-17)', () => {
  // The shape of the open that lost rows: 207 rows shown (81 older-page rows above a
  // 126-row window), the full read's 126-row window opens with the later half of a message
  // its start cut through, parsed with another timestamp than the held row of that message.
  function shapes() {
    const held = range(0, 207);
    const cutMsg = held[81]!;
    const half = { ...cutMsg, timestamp: new Date(Date.parse(cutMsg.timestamp!) + 500).toISOString(), text: 'later half' };
    return { held, windowAt81: [half, ...range(82, 207)], windowAt81Grown: [half, ...range(82, 212)] };
  }

  it('the seam half heading the window still finds where it touches the held rows', () => {
    const { held, windowAt81 } = shapes();
    const out = stitchHeldOlder(held, windowAt81);
    expect(out).toHaveLength(207);
    expect(ids(out)).toEqual(ids(held));
    expect(out[81]!.text).toBe('later half');
  });

  it.each([
    ['the same window', 'windowAt81'],
    ['a window grown by a turn', 'windowAt81Grown'],
  ] as const)('a windowed full read of %s keeps every shown row (foldFullPayload)', (_name, key) => {
    const s = shapes();
    const incoming = s[key];
    const folded = foldFullPayload(s.held, { messages: incoming, cursor: incoming.length, windowed: true });
    expect(folded.messages.length).toBeGreaterThanOrEqual(s.held.length);
    const shown = new Set(folded.messages.map((m) => m.msgId));
    expect(s.held.every((m) => shown.has(m.msgId))).toBe(true);
    expect(folded.kept).toBe(81);
  });

  it('a window that slid forward as the transcript grew keeps the rows that fell off its top (40697029 shape)', () => {
    // 2026-11-17 03:01Z, a 140 MB local session served as its 4 MB tail: the open showed 214 rows
    // (the 212-row window of 02:39 plus the 2 rows a delta appended), the file had grown 37 KB, so
    // the window start moved forward and now cut through a message (its later tool_use line, parsed
    // with that line's timestamp). The full read answered 212 rows and the 2 rows above them vanished.
    const held = range(0, 214);
    const cutMsg = held[2]!;
    const half = { ...cutMsg, timestamp: new Date(Date.parse(cutMsg.timestamp!) + 900).toISOString(), text: 'tool_use line' };
    const incoming = [half, ...range(3, 214)];
    expect(incoming).toHaveLength(212);
    const folded = foldFullPayload(held, { messages: incoming, cursor: incoming.length, windowed: true });
    expect(folded.messages).toHaveLength(214);
    expect(ids(folded.messages)).toEqual(ids(held));
    expect(folded.kept).toBe(2);
    expect(folded.cursor).toBe(214);
  });

  it('for every window start inside what is held, and every head row cut or not, no shown row is lost', () => {
    const held = range(0, 120);
    for (let start = 1; start < 110; start++) {
      for (const cut of [false, true]) {
        const head = cut ? { ...held[start]!, timestamp: new Date(Date.parse(held[start]!.timestamp!) + 250).toISOString() } : held[start]!;
        const incoming = [head, ...range(start + 1, 125)];
        const folded = foldFullPayload(held, { messages: incoming, cursor: incoming.length, windowed: true });
        const shown = new Set(folded.messages.map((m) => m.msgId));
        expect(held.filter((m) => !shown.has(m.msgId)).map((m) => m.msgId), `start ${start} cut ${cut}`).toEqual([]);
        expect(new Set(folded.messages.map((m) => `${m.msgId}|${m.timestamp}`)).size).toBe(folded.messages.length);
      }
    }
  });
});

describe('a cached copy behind the click\'s own screen is not what the open shows (2026-11-17)', () => {
  // 3cad5ec9: the IndexedDB copy ended 5 h before the open, its last rows machine turns folded out
  // of sight; it won the race at 77 ms and the chat showed nothing until the 5.8 s full read.
  it('the screen\'s newest row missing from the copy means the copy is behind', () => {
    const copy = range(0, 400);
    expect(cacheBehindScreen(copy, range(420, 460))).toBe(true);
    expect(cacheBehindScreen(copy, range(360, 400))).toBe(false);
    expect(cacheBehindScreen(range(0, 460), range(420, 460))).toBe(false);
    expect(cacheBehindScreen(copy, [])).toBe(false);
    expect(cacheBehindScreen(copy, [{ role: 'user', text: 'no id' }])).toBe(false);
  });

  it('the IndexedDB race asks before it adopts the copy, and keeps the copy as the fallback', () => {
    const hook = fs.readFileSync('web/src/hooks/useSessionHistory.ts', 'utf8');
    const race = hook.slice(hook.indexOf("stage('idbReady')"));
    const check = race.indexOf('cacheBehindScreen(persisted.messages, screen.messages)');
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(race.indexOf("choose('cache')"));
    expect(race.slice(check, race.indexOf("choose('cache')"))).toMatch(/startNetworkLoad\(firstScreenRead[\s\S]*lateCache = persisted/);
    // The fallback after a failed full read never puts that older copy over newer rows on screen.
    const fallback = hook.slice(hook.indexOf('const fallBackToLateCache'), hook.indexOf('adoptCachedRows(held)'));
    expect(fallback).toContain('cacheBehindScreen(held.messages, messagesRef.current)');
  });
});

describe('a windowed fork\'s refresh (2026-11-17)', () => {
  // fe01eb83, 2f146a91: an older server answered [parent][4 MB window], the fix answers the window.
  it('rows held from the older [ancestors][window] answer are not kept above the fork\'s own window', () => {
    const fresh = { windowed: true, forkedFromSessionId: 'parent' };
    expect(heldForkPrefixIsStale(fresh, 3, false)).toBe(true);
    // Paged to the fork's start: the ancestors above are whole, they stay.
    expect(heldForkPrefixIsStale(fresh, 3, true)).toBe(false);
    expect(heldForkPrefixIsStale({ ...fresh, forkBoundaryIndex: 3 }, 3, false)).toBe(false);
    expect(heldForkPrefixIsStale({ windowed: true }, 3, false)).toBe(false);
    expect(heldForkPrefixIsStale(fresh, undefined, false)).toBe(false);
  });

  it('a fork start paged in keeps its divider through the next refresh', () => {
    expect(boundaryAfterFold(undefined, 40, 12)).toBe(12);
    expect(boundaryAfterFold(undefined, 10, 12)).toBeUndefined();
    expect(boundaryAfterFold(5, 40, 12)).toBe(45);
  });
});
