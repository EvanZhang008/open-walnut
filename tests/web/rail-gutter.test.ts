/**
 * The question gutter of a file view outlives a layer that lets go of it for a moment
 * (web/src/utils/rail-gutter.ts; 2026-11-09: a flip on send reflowed a long file and the
 * passage slid 250px at its end), and goes at once when the view shows another file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RAIL_GUTTER_GRACE_MS, holdRailGutter, railGutterFileShown, releaseRailGutter } from '../../web/src/utils/rail-gutter';

const A = 'data-file-rail';
function view() {
  const attrs = new Set<string>();
  const log: string[] = [];
  return {
    attrs, log,
    setAttribute(n: string) { attrs.add(n); log.push('set'); },
    removeAttribute(n: string) { attrs.delete(n); log.push('remove'); },
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('the file view question gutter', () => {
  it('a layer that lets go and holds again within the grace never flips it', () => {
    const v = view();
    holdRailGutter(v, A);
    releaseRailGutter(v, A, 'README.md');
    vi.advanceTimersByTime(RAIL_GUTTER_GRACE_MS - 1);
    holdRailGutter(v, A);
    vi.advanceTimersByTime(RAIL_GUTTER_GRACE_MS * 2);
    expect(v.attrs.has(A)).toBe(true);
    expect(v.log).not.toContain('remove');
  });

  it('a release nobody takes back ends after the grace', () => {
    const v = view();
    holdRailGutter(v, A);
    releaseRailGutter(v, A, 'README.md');
    expect(v.attrs.has(A)).toBe(true);
    vi.advanceTimersByTime(RAIL_GUTTER_GRACE_MS);
    expect(v.attrs.has(A)).toBe(false);
  });

  it('another file drops it at once; the same file keeps the grace', () => {
    const v = view();
    holdRailGutter(v, A);
    releaseRailGutter(v, A, 'README.md');
    railGutterFileShown(v, A, 'README.md');
    expect(v.attrs.has(A)).toBe(true);
    railGutterFileShown(v, A, 'app.ts');
    expect(v.attrs.has(A)).toBe(false);
    vi.advanceTimersByTime(RAIL_GUTTER_GRACE_MS * 2);
    expect(v.log.filter(x => x === 'remove')).toHaveLength(1);
  });

  it('two releases in a row end once', () => {
    const v = view();
    holdRailGutter(v, A);
    releaseRailGutter(v, A, 'README.md');
    releaseRailGutter(v, A, 'README.md');
    vi.advanceTimersByTime(RAIL_GUTTER_GRACE_MS * 2);
    expect(v.log.filter(x => x === 'remove')).toHaveLength(1);
  });
});
