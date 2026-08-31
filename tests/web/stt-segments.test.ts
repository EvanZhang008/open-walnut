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

  // Escalation: the field failure was a 27s dictation where no gap ever reached
  // 800ms, so the window never advanced and each tick re-transcribed everything.
  describe('escalation for continuous speech', () => {
    const ESC = { ...OPTS, relaxAfterMs: 5000, minSilenceFloorMs: 260, forceAfterMs: 12000 };

    it('still requires the full pause while the window is young', () => {
      // 6.3s window: the requirement has only eased to ~700ms, so a 300ms
      // breath is still not a cut point.
      const b = blocks([[5000, 0.1], [300, 0.001], [1000, 0.1]]);
      expect(findSilenceCommitPoint(b, 0, ESC)).toBeNull();
    });

    it('accepts a short breath once the window has run long', () => {
      // 10.5s window: the requirement has eased to ~376ms, so this 400ms breath
      // now qualifies where the strict 800ms rule would have ignored it.
      const b = blocks([[10000, 0.1], [400, 0.001], [100, 0.1]]);
      const cut = findSilenceCommitPoint(b, 0, ESC);
      expect(cut).toBe(s(10000) + s(400) / 2);
    });

    it('force-cuts at the quietest block when speech never pauses at all', () => {
      // Unbroken 16s of speech with one relatively quiet stretch at 8s.
      const b = blocks([[8000, 0.2], [200, 0.05], [8000, 0.2]]);
      const cut = findSilenceCommitPoint(b, 0, ESC);
      expect(cut).not.toBeNull();
      // Lands in the quiet dip, not at an arbitrary offset.
      expect(cut!).toBeGreaterThanOrEqual(s(8000));
      expect(cut!).toBeLessThan(s(8200));
    });

    it('never force-cuts into the last second (the word being spoken now)', () => {
      // Quietest stretch is at the very end — cutting there would slice the
      // live word, so the earlier dip must win instead.
      const b = blocks([[6000, 0.2], [200, 0.06], [9000, 0.2], [400, 0.03]]);
      const cut = findSilenceCommitPoint(b, 0, ESC);
      expect(cut).not.toBeNull();
      expect(cut!).toBeLessThan(s(15000));
    });

    it('does not force-cut before the minimum segment length', () => {
      const b = blocks([[2000, 0.2]]);
      expect(findSilenceCommitPoint(b, 0, ESC)).toBeNull();
    });

    it('measures the window from windowStart, not from capture start', () => {
      // 20s of capture but the window opened at 18s: only 2s is open, so the
      // escalation must not fire.
      const b = blocks([[18000, 0.1], [2000, 0.1]]);
      expect(findSilenceCommitPoint(b, s(18000), ESC)).toBeNull();
    });

    it('behaves exactly as before when escalation is not configured', () => {
      const b = blocks([[10000, 0.1], [400, 0.001], [100, 0.1]]);
      expect(findSilenceCommitPoint(b, 0, OPTS)).toBeNull();
    });
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
