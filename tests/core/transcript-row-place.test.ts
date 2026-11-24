/**
 * The one rule a page cursor's row is found by (src/core/transcript-row-place.ts), shared by the
 * transcript route's cut, the windows an older page is read in, and task_history's cuts.
 */
import { describe, it, expect } from 'vitest';
import { isTranscriptRowId, rowPlace } from '../../src/core/transcript-row-place.js';
import { transcriptSliceBounds } from '../../src/core/session-projection.js';

const row = (msgId: string | undefined, timestamp: string) => ({ role: 'assistant' as const, text: msgId ?? '', timestamp, ...(msgId ? { msgId } : {}) });

describe('rowPlace', () => {
  it('finds the row by its id, whatever its time on this read', () => {
    // A line without a time is stamped when it is parsed: the next read stamps it again.
    const rows = [row('a', 't1'), row('b', 't2-now'), row('c', 't3')];
    expect(rowPlace(rows, 'b', 't2-earlier')).toBe(1);
    expect(rowPlace(rows, 'zz', 't2')).toBe(-1);
  });
  it('of several rows with the id, the one stamped before, else the newest', () => {
    const rows = [row('a', 't1'), row('x', 't2'), row('b', 't3'), row('x', 't4')];
    expect(rowPlace(rows, 'x', 't2')).toBe(1);
    expect(rowPlace(rows, 'x', 't9')).toBe(3);
  });
  it('the route cuts at the same row', () => {
    const history = [row('a', 't1'), row('b', 't2'), row('c', 't3'), row('d', 't4')] as never[];
    expect(transcriptSliceBounds(history, { before: 't2-other', beforeId: 'b' }).end).toBe(1);
    // An id the file lost: the time decides.
    expect(transcriptSliceBounds(history, { before: 't3', beforeId: 'gone' }).end).toBe(2);
  });
});

describe('isTranscriptRowId', () => {
  it('takes the ids the parser makes and refuses anything else', () => {
    for (const ok of ['msg_01ABCdef', '0b6c1a7e-5d2f-4c1e-9d55-1b2a3c4d5e6f', 'queue-2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z-12']) expect(isTranscriptRowId(ok), ok).toBe(true);
    for (const bad of ['', 'a b', 'x'.repeat(201), 'a/b', 7, undefined]) expect(isTranscriptRowId(bad), String(bad)).toBe(false);
  });
});

describe('task_history cuts by place only with ids the route takes back', () => {
  it('rows whose ids are not cursors are cut by time, with no before_id', async () => {
    const { newestCounted } = await import('../../src/ops/history-time-cut.js');
    const rows = (ids: string[]) => ids.map((id, i) => ({ role: 'assistant', text: `r${i}`, timestamp: `2026-01-01T00:00:0${i}Z`, msgId: id }));
    const counts = () => true;
    expect(newestCounted(rows(['a', 'b', 'c', 'd']), 2, counts)).toMatchObject({ before: '2026-01-01T00:00:02Z', beforeId: 'c' });
    const bad = newestCounted(rows(['a', 'b c', 'c', 'd']), 2, counts);
    expect(bad.before).toBe('2026-01-01T00:00:02Z');
    expect(bad.beforeId).toBeUndefined();
  });
});
