/**
 * Segment-commit decisions for live dictation: where to cut the draft window
 * (silence gaps), and how committed text joins the next segment.
 */
import { describe, it, expect } from 'vitest';
import { findSilenceCommitPoint, joinSegments, type PcmBlockInfo } from '../../web/src/utils/stt-segments.js';

const RATE = 16000;
const OPTS = { sampleRate: RATE, voiceRms: 0.012, minSilenceMs: 800, minSegmentMs: 3000 };

/** Builds contiguous blocks from (durationMs, rms) runs. */
function blocks(runs: Array<[number, number]>, blockMs = 100): PcmBlockInfo[] {
  const out: PcmBlockInfo[] = [];
  let at = 0;
  for (const [ms, rms] of runs) {
    for (let done = 0; done < ms; done += blockMs) {
      const length = (Math.min(blockMs, ms - done) / 1000) * RATE;
      out.push({ startSample: at, length, rms });
      at += length;
    }
  }
  return out;
}

const s = (ms: number) => (ms / 1000) * RATE; // ms → samples

describe('findSilenceCommitPoint', () => {
  it('cuts at the midpoint of a long-enough pause after enough speech', () => {
    // 4s speech, 1s pause, 2s speech → cut in the middle of the pause.
    const b = blocks([[4000, 0.1], [1000, 0.001], [2000, 0.1]]);
    const cut = findSilenceCommitPoint(b, 0, OPTS);
    expect(cut).toBe(s(4000) + s(1000) / 2);
  });

  it('returns null while the user is still mid-sentence (no qualifying pause)', () => {
    const b = blocks([[5000, 0.1], [300, 0.001], [2000, 0.1]]); // 300ms breath ≠ pause
    expect(findSilenceCommitPoint(b, 0, OPTS)).toBeNull();
  });

  it('ignores pauses that would commit a segment shorter than the minimum', () => {
    // Only 1.5s of audio before the pause — not worth a commit pass.
    const b = blocks([[1500, 0.1], [1000, 0.001], [2000, 0.1]]);
    expect(findSilenceCommitPoint(b, 0, OPTS)).toBeNull();
  });

  it('requires speech before the pause — leading silence is not a segment', () => {
    const b = blocks([[4000, 0.001], [2000, 0.1]]);
    expect(findSilenceCommitPoint(b, 0, OPTS)).toBeNull();
  });

  it('picks the LATEST qualifying pause so one pass commits as much as possible', () => {
    const b = blocks([[4000, 0.1], [1000, 0.001], [4000, 0.1], [1000, 0.001], [1000, 0.1]]);
    const cut = findSilenceCommitPoint(b, 0, OPTS);
    expect(cut).toBe(s(9000) + s(1000) / 2);
  });

  it('counts a pause still in progress (user is pausing right now)', () => {
    const b = blocks([[4000, 0.1], [1200, 0.001]]); // recording ends mid-pause
    const cut = findSilenceCommitPoint(b, 0, OPTS);
    expect(cut).toBe(s(4000) + s(1200) / 2);
  });

  it('only looks at audio after windowStart (already-committed audio is gone)', () => {
    // The first pause is before windowStart; only the short trailing audio counts.
    const b = blocks([[4000, 0.1], [1000, 0.001], [2000, 0.1]]);
    expect(findSilenceCommitPoint(b, s(4500), OPTS)).toBeNull();
  });

  it('measures the segment from windowStart, not from block boundaries', () => {
    // After a commit at 5s: 4s more speech then a 1s pause → commit again.
    const b = blocks([[4000, 0.1], [1000, 0.001], [4000, 0.1], [1000, 0.001]]);
    const windowStart = s(4000) + s(1000) / 2;
    const cut = findSilenceCommitPoint(b, windowStart, OPTS);
    expect(cut).toBe(s(9000) + s(1000) / 2);
  });
});

describe('joinSegments', () => {
  it('returns the other side when one is empty', () => {
    expect(joinSegments('', '你好。')).toBe('你好。');
    expect(joinSegments('你好。', '')).toBe('你好。');
  });

  it('joins CJK sentences with no separator', () => {
    expect(joinSegments('今天天气不错。', '我们出去走走。')).toBe('今天天气不错。我们出去走走。');
  });

  it('separates two latin words so they do not fuse', () => {
    expect(joinSegments('deploy to prod', 'then verify')).toBe('deploy to prod then verify');
  });

  it('separates English sentences with a space after the period', () => {
    expect(joinSegments('Deploy it.', 'Then verify.')).toBe('Deploy it. Then verify.');
  });

  it('mixed zh/en boundary follows the CJK side (no space)', () => {
    expect(joinSegments('今天用了', 'Claude 很好用。')).toBe('今天用了Claude 很好用。');
  });

  it('trims stray whitespace at the boundary', () => {
    expect(joinSegments('你好。 ', ' 再见。')).toBe('你好。再见。');
  });
});
