/**
 * Round 4 fixes that are pure logic: the lanes row's overflow cue (R3-19) and
 * the composer's placeholder (R3-24, spec 6.1).
 */
import { describe, expect, it } from 'vitest';
import { scrollEdges } from '../../web/src/components/board/kanban/useScrollEdges';
import { cutTitle } from '../../web/src/components/board/kanban/kanban-changes-model';

describe('R3-19: the lanes row says which edge hides lanes', () => {
  it('three lanes that fill the row exactly, a fourth past it: more on the right only', () => {
    expect(scrollEdges({ scrollLeft: 0, scrollWidth: 1400, clientWidth: 859 })).toEqual({ left: false, right: true });
  });
  it('scrolled to the middle: both; to the end: left only; everything fits: neither', () => {
    expect(scrollEdges({ scrollLeft: 200, scrollWidth: 1400, clientWidth: 859 })).toEqual({ left: true, right: true });
    expect(scrollEdges({ scrollLeft: 541, scrollWidth: 1400, clientWidth: 859 })).toEqual({ left: true, right: false });
    expect(scrollEdges({ scrollLeft: 0, scrollWidth: 859, clientWidth: 859 })).toEqual({ left: false, right: false });
    // A sub-pixel remainder is not a hidden lane.
    expect(scrollEdges({ scrollLeft: 0, scrollWidth: 861, clientWidth: 859 })).toEqual({ left: false, right: false });
  });
});

describe('R3-24: the composer names the worker, cut at 30', () => {
  it('a title that starts with its ticket keeps the words after it', () => {
    expect(`Message ${cutTitle('V1000000102 settlement batch stuck in the ledger export', 30)}`)
      .toBe('Message V1000000102 settlement batch s\u2026');
    expect(`Message ${cutTitle('Short title', 30)}`).toBe('Message Short title');
  });
});
