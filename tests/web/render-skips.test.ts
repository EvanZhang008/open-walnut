/**
 * Render skips (web/src/components/sessions/render-skips.ts): a jump far back
 * renders the target's turn and leaves the stretch up to the window out,
 * instead of rendering everything in between.
 */
import { describe, it, expect } from 'vitest';
import { MIN_SKIP_ROWS, planSkipsForReveal, resolveSkips } from '@/components/sessions/render-skips';

type Row = { msgId?: string; role: 'user' | 'assistant' };
/** `turns` turns of one user row and two assistant rows each. */
function rows(turns: number): Row[] {
  const out: Row[] = [];
  for (let t = 0; t < turns; t++) {
    out.push({ msgId: `u${t}`, role: 'user' }, { msgId: `a${t}x`, role: 'assistant' }, { msgId: `a${t}y`, role: 'assistant' });
  }
  return out;
}
const isTurn = (m: Row) => m.role === 'user';

describe('planSkipsForReveal', () => {
  it('a target above the window leaves out the rows from its turn end to the window start', () => {
    const m = rows(20); // 60 rows; window starts at turn 15 (row 45)
    const skips = planSkipsForReveal(m, [], 45, 6, isTurn); // row 6 = turn 2's user row
    expect(skips).toEqual([{ from: 'u3', resume: 'u15' }]);
    const [r] = resolveSkips(m, skips, isTurn);
    expect(r).toMatchObject({ start: 9, end: 45, turns: 12 });
  });

  it('a target just above the window leaves nothing out (too short to bother)', () => {
    const m = rows(20);
    expect(planSkipsForReveal(m, [], 45, 42, isTurn)).toEqual([]);
    expect(MIN_SKIP_ROWS).toBeGreaterThan(1);
  });

  it('a target inside a skip splits it around its own turn', () => {
    const m = rows(20);
    const first = planSkipsForReveal(m, [], 45, 6, isTurn);
    // Turn 9 (rows 27..29), inside [9, 45): before = [9, 27), after = [30, 45).
    const next = planSkipsForReveal(m, first, 6, 28, isTurn);
    expect(next).toEqual([{ from: 'u3', resume: 'u9' }, { from: 'u10', resume: 'u15' }]);
  });

  it('a target outside every skip keeps them', () => {
    const m = rows(20);
    const first = planSkipsForReveal(m, [], 45, 6, isTurn);
    expect(planSkipsForReveal(m, first, 6, 50, isTurn)).toEqual(first);
  });
});

describe('resolveSkips', () => {
  it('drops a skip whose rows left, and overlapping ones', () => {
    const m = rows(20);
    expect(resolveSkips(m, [{ from: 'gone', resume: 'u15' }], isTurn)).toEqual([]);
    const both = resolveSkips(m, [{ from: 'u3', resume: 'u15' }, { from: 'u5', resume: 'u12' }], isTurn);
    expect(both).toHaveLength(1);
    expect(both[0]!.skip.from).toBe('u3');
  });

  it('follows its rows when older history is prepended (ids, not indexes)', () => {
    const m = rows(20);
    const skips = planSkipsForReveal(m, [], 45, 6, isTurn);
    const grown = [...rows(5).map((r) => ({ ...r, msgId: `old-${r.msgId}` })), ...m];
    expect(resolveSkips(grown, skips, isTurn)[0]).toMatchObject({ start: 24, end: 60 });
  });
});
