/**
 * readSessionHistoryBefore with `endByte`: the caller already holds every line from
 * that byte on (a tail window), so a page reads only before it. 2026-11-16: a 53 MB
 * remote session's 10-turn backfill read window 12 (wholly inside the 4 MB tail it had
 * just pulled) and most of window 11 again, 4.4 s of a 10.5 s full read.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const MB = 1024 * 1024;
const FILE = 9 * MB;
const ranges = vi.hoisted(() => [] as Array<[number, number]>);
vi.mock('../../src/core/session-history.js', () => ({
  readSessionHistoryRange: vi.fn(async (_sid: string, _cwd: unknown, _host: unknown, start: number, end: number) => {
    ranges.push([start, end]);
    if (start >= end) return { messages: [], fileSize: FILE, epoch: 'e1' };
    // One message per window, stamped by its window number (time grows with the offset).
    const n = Math.floor(start / (4 * MB));
    return { messages: [{ role: 'user', text: `w${n}`, timestamp: `2026-01-0${n + 1}T00:00:00Z` }], fileSize: FILE, epoch: 'e1' };
  }),
}));

import { readSessionHistoryBefore, _resetHistoryPagesForTests } from '../../src/core/session-history-pages.js';

const want = { minMessages: 1, minText: 1, isText: () => true };

describe('readSessionHistoryBefore endByte', () => {
  beforeEach(() => { ranges.length = 0; _resetHistoryPagesForTests(); });

  it('starts at the window holding the byte before endByte and never reads past it', async () => {
    const page = await readSessionHistoryBefore('s', undefined, 'h', '2026-01-09T00:00:00Z', want, { byte: 7 * MB, epoch: 'e1' });
    const reads = ranges.filter(([a, b]) => b > a);
    expect(reads[0]).toEqual([4 * MB, 7 * MB]);
    expect(reads.every(([, b]) => b <= 7 * MB)).toBe(true);
    expect(page?.windowsRead).toBe(1);
    expect(page?.messages.map(m => m.text)).toEqual(['w1']);
  });

  it('without endByte it still starts at the file\'s last window (the phone\'s before= pages)', async () => {
    await readSessionHistoryBefore('s', undefined, 'h', '2026-01-09T00:00:00Z', want);
    expect(ranges.filter(([a, b]) => b > a)[0]).toEqual([8 * MB, 12 * MB]);
  });

  it('maxWindows bounds one page to that many window reads', async () => {
    const many = { minMessages: 50, minText: 50, isText: () => true };
    const capped = await readSessionHistoryBefore('s', undefined, 'h', '2026-01-09T00:00:00Z', { ...many, maxWindows: 1 }, { byte: 9 * MB - 1 });
    expect(capped?.windowsRead).toBe(1);
    expect(capped?.reachedStart).toBe(false);
    ranges.length = 0; _resetHistoryPagesForTests();
    const full = await readSessionHistoryBefore('s', undefined, 'h', '2026-01-09T00:00:00Z', many, { byte: 9 * MB - 1 });
    expect(full?.windowsRead).toBe(3);
  });

  it('a held start from another file incarnation is ignored', async () => {
    await readSessionHistoryBefore('s', undefined, 'h', '2026-01-09T00:00:00Z', want, { byte: 7 * MB, epoch: 'old' });
    expect(ranges.filter(([a, b]) => b > a)[0]).toEqual([8 * MB, 12 * MB]);
  });

  it('an endByte past the file or at zero is ignored', async () => {
    await readSessionHistoryBefore('s', undefined, 'h', '2026-01-09T00:00:00Z', want, { byte: 20 * MB });
    expect(ranges.filter(([a, b]) => b > a)[0]).toEqual([8 * MB, 12 * MB]);
  });
});
