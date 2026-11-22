/**
 * Where a take still recording is cut into pieces heard ahead
 * (src/core/stt/take-settle.ts): pieces of at most 30 s at quiet spots, the
 * last segment left open, nothing cut in the final 5 s, a short take cut
 * nowhere, and a piece of silence alone never heard.
 */
import { describe, it, expect } from 'vitest';
import { settleCuts, KEEP_OPEN_SEC, PIECE_MAX_SEC, SETTLE_MIN_SEC } from '../../src/core/stt/take-settle.js';
import { hasSound } from '../../src/core/stt/long-silence.js';
import { joinSegmentTexts } from '../../src/core/stt/wav-segment.js';
import { speechPcm, RATE } from '../helpers/speech-pcm.js';

describe('settleCuts', () => {
  it('a take under 40 s settles nothing', () => {
    expect(settleCuts(speechPcm(39.9), 0)).toEqual([]);
    expect(settleCuts(speechPcm(SETTLE_MIN_SEC - 0.01), 0)).toEqual([]);
  });

  it('cuts pieces of at most 30 s at quiet spots, keeps the last segment open and never cuts in the final 5 s', () => {
    for (const seconds of [40, 45, 61, 95, 180, 301]) {
      const pcm = speechPcm(seconds, seconds);
      const cuts = settleCuts(pcm, 0);
      expect(cuts.length, `${seconds} s`).toBeGreaterThan(0);
      let from = 0;
      for (const end of cuts) {
        expect(end - from).toBeLessThanOrEqual(PIECE_MAX_SEC * RATE);
        expect(end - from).toBeGreaterThan(10 * RATE);
        // A cut sits in a pause between words (the synthetic pauses are near silence).
        expect(Math.abs(pcm[end]!)).toBeLessThan(200);
        from = end;
      }
      expect(cuts[cuts.length - 1]!).toBeLessThanOrEqual(pcm.length - KEEP_OPEN_SEC * RATE);
      // Something stays open for the stop.
      expect(pcm.length - cuts[cuts.length - 1]!).toBeGreaterThanOrEqual(KEEP_OPEN_SEC * RATE);
    }
  });

  it('continues from what is settled, and waits again until 40 s are unsettled', () => {
    const pcm = speechPcm(120, 7);
    const first = settleCuts(pcm.subarray(0, 50 * RATE), 0);
    const settled = first[first.length - 1]!;
    expect(settleCuts(pcm.subarray(0, settled + 39 * RATE), settled)).toEqual([]);
    const next = settleCuts(pcm, settled);
    expect(next[0]!).toBeGreaterThan(settled);
    expect(next[0]! - settled).toBeLessThanOrEqual(PIECE_MAX_SEC * RATE);
  });
});

describe('a piece with no sound is not heard', () => {
  it('by the measure that shortens long silences: no 10 ms block above the silence level', () => {
    expect(hasSound(new Int16Array(30 * RATE), RATE)).toBe(false);
    // A quiet room: noise far under the level a word reaches.
    const room = Int16Array.from({ length: 30 * RATE }, (_, i) => Math.round(60 * Math.sin(i * 1.7) * Math.sin(i * 0.013)));
    expect(hasSound(room, RATE)).toBe(false);
    expect(hasSound(speechPcm(30, 4), RATE)).toBe(true);
    // One short word in 30 s of silence is sound.
    const word = new Int16Array(30 * RATE);
    word.set(speechPcm(0.5, 5), 12 * RATE);
    expect(hasSound(word, RATE)).toBe(true);
    // Under 10 ms holds no block at all.
    expect(hasSound(new Int16Array(100), RATE)).toBe(false);
  });
});

describe('the pieces and the tail join as one text', () => {
  it('a space between Latin pieces, none between CJK pieces, empty pieces dropped', () => {
    expect(joinSegmentTexts(['first part.', '', 'second part', 'tail'])).toBe('first part. second part tail');
    // Two Chinese pieces: no space where they meet.
    expect(joinSegmentTexts(['\u4f60\u597d', '\u4e16\u754c'])).toBe('\u4f60\u597d\u4e16\u754c');
  });
});
