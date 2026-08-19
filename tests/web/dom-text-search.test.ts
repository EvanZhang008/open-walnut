/**
 * Unit tests for the pure parts of web/src/utils/dom-text-search.ts —
 * the offset scanner behind in-file search on DOM surfaces, and the
 * symbol charset shared with cmd+click reference lookup.
 */
import { describe, it, expect } from 'vitest';
import { findMatchOffsets, SYMBOL_RE } from '../../web/src/utils/dom-text-search';

describe('findMatchOffsets', () => {
  it('finds all case-insensitive matches by default', () => {
    expect(findMatchOffsets('Foo foo FOO', 'foo', false)).toEqual([0, 4, 8]);
  });

  it('respects case sensitivity', () => {
    expect(findMatchOffsets('Foo foo FOO', 'foo', true)).toEqual([4]);
  });

  it('empty query → no matches', () => {
    expect(findMatchOffsets('anything', '', false)).toEqual([]);
  });

  it('no hit → empty', () => {
    expect(findMatchOffsets('abc', 'zzz', false)).toEqual([]);
  });

  it('non-overlapping: advances past each match', () => {
    // "aaa" in "aaaa" matches at 0 only (next scan starts at 3).
    expect(findMatchOffsets('aaaa', 'aaa', false)).toEqual([0]);
  });

  it('caps the number of matches', () => {
    const hay = 'ab'.repeat(100);
    expect(findMatchOffsets(hay, 'ab', false, 10)).toHaveLength(10);
  });

  it('matches across what would be DOM token boundaries (plain text level)', () => {
    // The DOM walker concatenates text nodes; at this layer it's one string.
    expect(findMatchOffsets('factory.HasSynced()', 'factory.HasSynced', false)).toEqual([0]);
  });

  // Offsets are mapped back onto the ORIGINAL string to build DOM Ranges, so a
  // case fold that changes LENGTH would drift every later highlight off its word.
  it('case-insensitive offsets stay valid when lowercasing would expand a character', () => {
    const hay = 'aİb needle'; // 'İ'.toLowerCase() is TWO code units
    expect(hay.toLowerCase().length).toBeGreaterThan(hay.length); // the trap
    const [at] = findMatchOffsets(hay, 'NEEDLE', false);
    expect(at).toBe(hay.indexOf('needle'));
    expect(hay.slice(at!, at! + 6)).toBe('needle');
  });

  it('still folds ordinary accented text', () => {
    expect(findMatchOffsets('Café CAFÉ', 'café', false)).toEqual([0, 5]);
  });
});

describe('SYMBOL_RE', () => {
  it('accepts identifiers', () => {
    for (const ok of ['HasSyncedForGVRs', '_private', '$jq', 'x1', 'snake_case']) {
      expect(SYMBOL_RE.test(ok)).toBe(true);
    }
  });

  it('rejects non-identifiers', () => {
    for (const bad of ['1abc', 'a-b', 'a.b', 'a b', '', 'a'.repeat(129)]) {
      expect(SYMBOL_RE.test(bad)).toBe(false);
    }
  });
});
