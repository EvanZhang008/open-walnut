/**
 * The fire dedup window (src/core/cron/trigger-apply.ts).
 *
 * Fires are NOT processed in order: the daemon replays every unacked fire, the
 * server's in-flight guard is per seq, and a delivery runs with the store lock
 * released. A plain high-water mark therefore mistook a slow retry of an earlier
 * seq for a duplicate, acked it and threw its items away. These cases pin the
 * window that replaced it - each one is a scenario that mark got wrong.
 */
import { describe, it, expect } from 'vitest';
import { FIRE_SEQ_WINDOW_MAX, isDuplicateFire, recordFireSeq } from '../../../src/core/cron/trigger-apply.js';

type State = { lastFireSeq?: number; lastFireEpoch?: string; fireSeqsDone?: number[] };

const fire = (seq: number, epoch = 'e1') => ({ seq, epoch });

describe('the fire dedup window', () => {
  it('advances the watermark and stores nothing while fires arrive in order', () => {
    const state: State = {};
    for (const seq of [1, 2, 3]) {
      expect(isDuplicateFire(state, fire(seq))).toBe(false);
      recordFireSeq(state, fire(seq));
    }
    expect(state.lastFireSeq).toBe(3);
    expect(state.fireSeqsDone).toBeUndefined();
    expect(isDuplicateFire(state, fire(3))).toBe(true);
    expect(isDuplicateFire(state, fire(4))).toBe(false);
  });

  // THE bug: seq 5's delivery fails transiently while seq 6 succeeds. Its replay
  // must still be delivered - the daemon marked those items seen at fire time, so
  // dropping the fire loses them for good.
  it('keeps an out-of-order fire deliverable after a later one was recorded', () => {
    const state: State = { lastFireSeq: 4, lastFireEpoch: 'e1' };
    recordFireSeq(state, fire(6));
    expect(state.lastFireSeq).toBe(4);
    expect(state.fireSeqsDone).toEqual([6]);
    expect(isDuplicateFire(state, fire(5))).toBe(false);
    expect(isDuplicateFire(state, fire(6))).toBe(true);

    // When 5 finally lands, the watermark absorbs both and the gap list empties.
    recordFireSeq(state, fire(5));
    expect(state.lastFireSeq).toBe(6);
    expect(state.fireSeqsDone).toBeUndefined();
    expect(isDuplicateFire(state, fire(5))).toBe(true);
  });

  it('never lets the watermark go backwards when fires land out of order', () => {
    const state: State = { lastFireSeq: 9, lastFireEpoch: 'e1' };
    recordFireSeq(state, fire(7));
    expect(state.lastFireSeq).toBe(9);
    // A recorded fire below the mark stays a duplicate: re-delivering it would
    // repeat a message the session already got.
    expect(isDuplicateFire(state, fire(7))).toBe(true);
  });

  it('starts over on a new epoch without claiming that epoch\'s earlier seqs', () => {
    const state: State = { lastFireSeq: 40, lastFireEpoch: 'old', fireSeqsDone: [42] };
    // The daemon recreated its state file: seq 3 of the NEW epoch is not covered
    // by the old mark, and seqs 1-2 of the new epoch may still be owed.
    expect(isDuplicateFire(state, fire(3, 'new'))).toBe(false);
    recordFireSeq(state, fire(3, 'new'));
    expect(state.lastFireSeq).toBe(0);
    expect(state.fireSeqsDone).toEqual([3]);
    expect(state.lastFireEpoch).toBe('new');
    expect(isDuplicateFire(state, fire(1, 'new'))).toBe(false);
    expect(isDuplicateFire(state, fire(3, 'new'))).toBe(true);
    // The old epoch's mark is gone, which is correct: those seqs mean nothing now.
    recordFireSeq(state, fire(1, 'new'));
    recordFireSeq(state, fire(2, 'new'));
    expect(state.lastFireSeq).toBe(3);
    expect(state.fireSeqsDone).toBeUndefined();
  });

  it('treats a pre-epoch daemon (no epoch at all) as one epoch', () => {
    const state: State = {};
    recordFireSeq(state, { seq: 1 });
    expect(state.lastFireSeq).toBe(1);
    expect(isDuplicateFire(state, { seq: 1 })).toBe(true);
    expect(isDuplicateFire(state, { seq: 2 })).toBe(false);
  });

  it('bounds the gap list, forgetting the OLDEST seq rather than a recent one', () => {
    const state: State = { lastFireSeq: 0, lastFireEpoch: 'e1' };
    // Every seq is a gap (1 never arrives), so the list grows to its bound.
    for (let seq = 2; seq < FIRE_SEQ_WINDOW_MAX + 12; seq++) recordFireSeq(state, fire(seq));
    expect(state.fireSeqsDone).toHaveLength(FIRE_SEQ_WINDOW_MAX);
    expect(state.lastFireSeq).toBe(0);
    // The newest are still known duplicates; a forgotten one would be delivered
    // again, which is the safe direction (at-least-once, never at-most-once).
    expect(isDuplicateFire(state, fire(FIRE_SEQ_WINDOW_MAX + 11))).toBe(true);
    expect(isDuplicateFire(state, fire(2))).toBe(false);
  });

  it('a state the window has never touched is not a duplicate of anything', () => {
    expect(isDuplicateFire({}, fire(1))).toBe(false);
    expect(isDuplicateFire({ fireSeqsDone: [] }, fire(1))).toBe(false);
  });
});
