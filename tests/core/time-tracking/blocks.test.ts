/**
 * Time tracking — the PURE day-timeline fold: gap merge, the sub-minute
 * threshold, lane separation, and midnight clipping.
 *
 * Every timestamp is built from LOCAL wall-clock fields (`at()`), never from a
 * hardcoded UTC string: the fold's day bounds are local midnights, so a literal
 * `…T09:00:00Z` would land on a different day depending on the machine and the
 * suite would pass or fail by timezone.
 */

import { describe, it, expect } from 'vitest';
import {
  dayBoundsMs, foldDayBlocks, MERGE_GAP_MS, MIN_BLOCK_MS,
} from '../../../src/core/time-tracking/blocks.js';
import type { TimeRecord } from '../../../src/core/time-tracking/types.js';

const DATE = '2026-08-22';

/** ISO instant for a local wall time on DATE (or a day offset from it). */
function at(hour: number, minute = 0, second = 0, dayOffset = 0): string {
  return new Date(2026, 7, 22 + dayOffset, hour, minute, second, 0).toISOString();
}

function rec(over: Partial<TimeRecord> = {}): TimeRecord {
  return {
    date: DATE,
    ts: at(9, 0),
    durationMs: 60_000,
    kind: 'session',
    taskId: 't_alpha',
    ...over,
  };
}

/** Local HH:MM of an ISO instant — what the timeline would draw. */
function localHm(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

describe('dayBoundsMs', () => {
  it('spans exactly one local calendar day', () => {
    const bounds = dayBoundsMs(DATE)!;
    expect(new Date(bounds.startMs).getHours()).toBe(0);
    expect(new Date(bounds.startMs).getDate()).toBe(22);
    expect(new Date(bounds.endMs).getDate()).toBe(23);
    // 23h on spring-forward, 25h on fall-back — never assumed to be 24.
    const hours = (bounds.endMs - bounds.startMs) / 3_600_000;
    expect([23, 24, 25]).toContain(hours);
  });

  it('rejects anything that is not a real YYYY-MM-DD', () => {
    for (const bad of ['2026-02-31', '2026-13-01', '2026-8-22', '20260822', '', 'today', '../../etc/passwd']) {
      expect(dayBoundsMs(bad)).toBeNull();
    }
  });

  it('answers empty for an unreal date instead of throwing', () => {
    expect(foldDayBlocks([rec()], { date: '2026-02-31' })).toEqual({
      date: '2026-02-31', blocks: [], unplacedMs: 0,
    });
  });
});

describe('gap merge', () => {
  it('joins back-to-back windows of one task into a single block', () => {
    const records = [
      rec({ ts: at(9, 0), durationMs: 60_000 }),
      rec({ ts: at(9, 1), durationMs: 60_000 }),
      rec({ ts: at(9, 2), durationMs: 60_000 }),
    ];
    const { blocks } = foldDayBlocks(records, { date: DATE });
    expect(blocks).toHaveLength(1);
    expect(localHm(blocks[0]!.startTs)).toBe('09:00');
    expect(localHm(blocks[0]!.endTs)).toBe('09:03');
    expect(blocks[0]!.ms).toBe(180_000);
    // No gap was bridged, so the drawn span and the tracked time agree exactly.
    expect(blocks[0]!.trackedMs).toBe(180_000);
  });

  it('bridges a gap at the threshold and splits one millisecond past it', () => {
    const merged = foldDayBlocks([
      rec({ ts: at(9, 0), durationMs: 60_000 }),
      rec({ ts: new Date(new Date(at(9, 1)).getTime() + MERGE_GAP_MS).toISOString(), durationMs: 60_000 }),
    ], { date: DATE });
    expect(merged.blocks).toHaveLength(1);
    // The bridged gap counts toward the SPAN but never toward tracked time.
    expect(merged.blocks[0]!.ms).toBe(120_000 + MERGE_GAP_MS);
    expect(merged.blocks[0]!.trackedMs).toBe(120_000);

    const split = foldDayBlocks([
      rec({ ts: at(9, 0), durationMs: 60_000 }),
      rec({ ts: new Date(new Date(at(9, 1)).getTime() + MERGE_GAP_MS + 1).toISOString(), durationMs: 60_000 }),
    ], { date: DATE });
    expect(split.blocks).toHaveLength(2);
    expect(split.blocks.map((b) => b.trackedMs)).toEqual([60_000, 60_000]);
  });

  it('never merges different tasks, even when they are adjacent', () => {
    const { blocks } = foldDayBlocks([
      rec({ ts: at(9, 0), durationMs: 120_000, taskId: 't_alpha' }),
      rec({ ts: at(9, 2), durationMs: 120_000, taskId: 't_beta' }),
    ], { date: DATE });
    expect(blocks.map((b) => b.taskId)).toEqual(['t_alpha', 't_beta']);
  });

  it('caps tracked time at the span when records of one task overlap', () => {
    const { blocks } = foldDayBlocks([
      rec({ ts: at(9, 0), durationMs: 600_000 }),
      rec({ ts: at(9, 5), durationMs: 300_000 }),
    ], { date: DATE });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.ms).toBe(600_000);
    expect(blocks[0]!.trackedMs).toBe(600_000); // not 900_000
  });
});

describe('sub-minute threshold', () => {
  it('drops a block shorter than the floor and reports its time as unplaced', () => {
    const { blocks, unplacedMs } = foldDayBlocks([
      rec({ ts: at(9, 0), durationMs: MIN_BLOCK_MS - 1 }),
    ], { date: DATE });
    expect(blocks).toHaveLength(0);
    expect(unplacedMs).toBe(MIN_BLOCK_MS - 1);
  });

  it('keeps a block exactly at the floor', () => {
    const { blocks, unplacedMs } = foldDayBlocks([
      rec({ ts: at(9, 0), durationMs: MIN_BLOCK_MS }),
    ], { date: DATE });
    expect(blocks).toHaveLength(1);
    expect(unplacedMs).toBe(0);
  });

  it('keeps fragments that merge past the floor together', () => {
    const records = Array.from({ length: 4 }, (_, i) => rec({ ts: at(9, 0, i * 20), durationMs: 20_000 }));
    const { blocks, unplacedMs } = foldDayBlocks(records, { date: DATE });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.ms).toBe(80_000);
    expect(unplacedMs).toBe(0);
  });
});

describe('lane separation', () => {
  it('keeps agent time in its own blocks, never folded into a human one', () => {
    const { blocks } = foldDayBlocks([
      rec({ ts: at(9, 0), durationMs: 120_000, kind: 'session' }),
      rec({ ts: at(9, 1), durationMs: 120_000, kind: 'agent', sessionId: 's1' }),
    ], { date: DATE });
    expect(blocks).toHaveLength(2);
    expect(blocks.map((b) => b.kind).sort()).toEqual(['agent', 'session']);
    for (const b of blocks) expect(b.trackedMs).toBe(120_000);
  });

  it('keeps the three human kinds apart too', () => {
    const { blocks } = foldDayBlocks([
      rec({ ts: at(9, 0), durationMs: 120_000, kind: 'session' }),
      rec({ ts: at(9, 0), durationMs: 120_000, kind: 'triage' }),
      rec({ ts: at(9, 0), durationMs: 120_000, kind: 'chat' }),
    ], { date: DATE });
    expect(blocks).toHaveLength(3);
  });

  it('filters to the requested kinds', () => {
    const records = [
      rec({ ts: at(9, 0), durationMs: 120_000, kind: 'session' }),
      rec({ ts: at(9, 0), durationMs: 120_000, kind: 'agent', sessionId: 's1' }),
      rec({ ts: at(9, 0), durationMs: 120_000, kind: 'chat' }),
    ];
    expect(foldDayBlocks(records, { date: DATE, kinds: ['session'] }).blocks.map((b) => b.kind))
      .toEqual(['session']);
    expect(foldDayBlocks(records, { date: DATE, kinds: ['session', 'chat'] }).blocks).toHaveLength(2);
    // An empty list means "no filter", not "nothing" — the route treats junk the same.
    expect(foldDayBlocks(records, { date: DATE, kinds: [] }).blocks).toHaveLength(3);
  });

  it('keeps taskless time under the empty id rather than inventing a task', () => {
    const { blocks } = foldDayBlocks([
      rec({ ts: at(9, 0), durationMs: 120_000, kind: 'chat', taskId: undefined }),
    ], { date: DATE });
    expect(blocks[0]!.taskId).toBe('');
  });
});

describe('midnight', () => {
  it('clips a window that runs past the end of the day', () => {
    const { blocks } = foldDayBlocks([
      rec({ ts: at(23, 50), durationMs: 30 * 60_000 }),
    ], { date: DATE });
    expect(blocks).toHaveLength(1);
    expect(localHm(blocks[0]!.startTs)).toBe('23:50');
    // Ends at the day boundary — the rest belongs to the next day's timeline.
    expect(new Date(blocks[0]!.endTs).getTime()).toBe(dayBoundsMs(DATE)!.endMs);
    expect(blocks[0]!.ms).toBe(10 * 60_000);
  });

  it('clips an agent turn that started the previous day', () => {
    // Filed under DATE (the day the result arrived) with a ts before midnight —
    // exactly the shape agent-time.ts writes for a turn that straddled midnight.
    const { blocks } = foldDayBlocks([
      rec({ ts: at(23, 30, 0, -1), durationMs: 90 * 60_000, kind: 'agent', sessionId: 's1' }),
    ], { date: DATE });
    expect(blocks).toHaveLength(1);
    expect(new Date(blocks[0]!.startTs).getTime()).toBe(dayBoundsMs(DATE)!.startMs);
    expect(localHm(blocks[0]!.endTs)).toBe('01:00');
  });

  it('reports a window entirely outside the day as unplaced, not as a block', () => {
    const { blocks, unplacedMs } = foldDayBlocks([
      rec({ ts: at(9, 0, 0, -3), durationMs: 60_000 }),
    ], { date: DATE });
    expect(blocks).toHaveLength(0);
    expect(unplacedMs).toBe(60_000);
  });
});

describe('records that cannot be drawn', () => {
  it('reports a compacted day as unplaced time instead of an invented hour', () => {
    // What store.ts compactDay leaves behind: the day's total at UTC midnight.
    const { blocks, unplacedMs } = foldDayBlocks([
      { date: DATE, ts: `${DATE}T00:00:00.000Z`, durationMs: 3 * 3_600_000, kind: 'session', taskId: 't_alpha' },
      { date: DATE, ts: `${DATE}T00:00:00.000Z`, durationMs: 3_600_000, kind: 'agent' },
    ], { date: DATE });
    expect(blocks).toHaveLength(0);
    expect(unplacedMs).toBe(4 * 3_600_000);
  });

  it('drops a malformed kind silently — it is in no total, so it is not "unplaced"', () => {
    const { blocks, unplacedMs } = foldDayBlocks([
      { date: DATE, ts: at(9, 0), durationMs: 600_000, kind: 'nonsense' as TimeRecord['kind'] },
    ], { date: DATE });
    expect(blocks).toHaveLength(0);
    expect(unplacedMs).toBe(0);
  });

  it('skips a torn or empty timestamp and a non-positive duration', () => {
    const { blocks, unplacedMs } = foldDayBlocks([
      rec({ ts: '', durationMs: 60_000 }),
      rec({ ts: 'not-a-date', durationMs: 60_000 }),
      rec({ ts: at(9, 0), durationMs: 0 }),
      rec({ ts: at(9, 0), durationMs: -5 }),
    ], { date: DATE });
    expect(blocks).toHaveLength(0);
    expect(unplacedMs).toBe(120_000); // the two bad timestamps; a zero duration adds nothing
  });
});

describe('ordering', () => {
  it('returns blocks ascending by start, whatever order the records arrived in', () => {
    const { blocks } = foldDayBlocks([
      rec({ ts: at(16, 0), durationMs: 600_000, taskId: 't_c' }),
      rec({ ts: at(9, 0), durationMs: 600_000, taskId: 't_a' }),
      rec({ ts: at(12, 0), durationMs: 600_000, taskId: 't_b' }),
    ], { date: DATE });
    expect(blocks.map((b) => b.taskId)).toEqual(['t_a', 't_b', 't_c']);
    expect(blocks.map((b) => localHm(b.startTs))).toEqual(['09:00', '12:00', '16:00']);
  });
});
