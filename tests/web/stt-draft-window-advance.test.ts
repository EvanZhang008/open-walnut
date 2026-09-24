/**
 * The draft window must ADVANCE whenever a bound is exceeded.
 *
 * Pinned incident (2026-09-01): `POST /api/stt/draft` grew monotonically from
 * 0.1MB to 15.7MB during one dictation, at one request every 2s, because the
 * window boundary only moved after a SUCCESSFUL upload. Two bounds were missing
 * or toothless — the commit slice had no size cap at all, and the preview slice
 * skipped on its cap without moving the boundary — so audio piled up behind a
 * frozen position and each tick's body was strictly bigger than the last.
 *
 * Every assertion below is one of those two shapes: over a bound → no upload,
 * and `nextWindowStart > windowStart`.
 */
import { describe, it, expect } from 'vitest';
import { decideDraftTick, type DraftTickInput } from '../../web/src/utils/stt-draft-window.js';

const RATE = 48000;                       // AudioContext rate, not the 16k upload rate
const s = (ms: number) => (ms / 1000) * RATE;
const MB = 1024 * 1024;

function input(over: Partial<DraftTickInput> = {}): DraftTickInput {
  return {
    windowStart: s(10_000),
    totalSamples: s(18_000),               // 8s open window
    sampleRate: RATE,
    commitAt: null,
    sliceBytes: 300_000,
    maxBytes: 4 * MB,
    maxWindowMs: 20_000,
    ...over,
  };
}

describe('decideDraftTick — the normal cases', () => {
  it('uploads a preview of a short open window', () => {
    const d = decideDraftTick(input());
    expect(d.action).toBe('preview-upload');
    expect(d.nextWindowStart).toBe(s(10_000));   // preview never moves the window
    expect(Math.round(d.windowMs)).toBe(8000);
  });

  it('uploads a commit slice and moves the window to the commit point', () => {
    const d = decideDraftTick(input({ commitAt: s(16_000), sliceBytes: 250_000 }));
    expect(d.action).toBe('commit-upload');
    expect(d.nextWindowStart).toBe(s(16_000));
  });

  it('skips a preview when nothing has been captured in the window', () => {
    // Not an over-bound case: there is no position to advance to.
    const d = decideDraftTick(input({ totalSamples: s(10_000), sliceBytes: 0 }));
    expect(d.action).toBe('preview-skip');
    expect(d.nextWindowStart).toBe(s(10_000));
  });
});

describe('decideDraftTick — a bound is exceeded, so the window advances', () => {
  it('advances past a commit slice over the byte cap WITHOUT uploading it', () => {
    // The exact incident shape: an uncapped commit slice was uploaded, 413'd,
    // and the window stayed put. Now the segment is abandoned instead.
    const windowStart = s(10_000);
    const d = decideDraftTick(input({
      windowStart,
      totalSamples: s(130_000),
      commitAt: s(125_000),
      sliceBytes: 15 * MB,
    }));
    expect(d.action).toBe('commit-skip');
    expect(d.nextWindowStart).toBe(s(125_000));
    expect(d.nextWindowStart).toBeGreaterThan(windowStart);
  });

  it('force-advances a window held open past the wall-clock bound', () => {
    // findCommitPoint returns null forever when the window holds no speech (a
    // mic left on): 4m19s of exactly this ran in the incident, silently.
    const windowStart = s(10_000);
    const d = decideDraftTick(input({
      windowStart,
      totalSamples: s(270_000),             // 4m20s open
      commitAt: null,
      sliceBytes: 0,                        // caller skipped the encode, as the hook does
    }));
    expect(d.action).toBe('force-advance');
    expect(d.nextWindowStart).toBeGreaterThan(windowStart);
    // Exactly maxWindowMs of audio is kept.
    expect(Math.round((s(270_000) - d.nextWindowStart) / (RATE / 1000))).toBe(20_000);
  });

  it('advances when a preview slice is over the byte cap', () => {
    // Reachable only with a loose wall-clock bound, but the invariant may not
    // depend on one bound to save another.
    const windowStart = s(10_000);
    const d = decideDraftTick(input({
      windowStart,
      totalSamples: s(130_000),
      commitAt: null,
      sliceBytes: 12 * MB,
      maxWindowMs: 600_000,                 // deliberately toothless
    }));
    expect(d.action).toBe('preview-skip');
    expect(d.nextWindowStart).toBeGreaterThan(windowStart);
    // What is kept fits the byte budget: 4MB of a 12MB slice = a third of it.
    const keptSamples = s(130_000) - d.nextWindowStart;
    expect(keptSamples).toBeCloseTo((s(130_000) - windowStart) / 3, -3);
  });

  it('never returns an upload action once a byte bound is exceeded', () => {
    for (const commitAt of [null, s(120_000)]) {
      const d = decideDraftTick(input({
        windowStart: s(10_000), totalSamples: s(130_000), commitAt, sliceBytes: 9 * MB,
      }));
      expect(d.action).not.toBe('commit-upload');
      expect(d.action).not.toBe('preview-upload');
      expect(d.nextWindowStart).toBeGreaterThan(s(10_000));
    }
  });

  it('cannot be starved by repetition: repeated over-bound ticks keep shrinking the window', () => {
    // The property that actually failed in production. Feed the decision back
    // into itself with audio still arriving and the open window must NOT grow.
    let windowStart = 0;
    let totalSamples = s(30_000);
    let previousOpen = Infinity;
    for (let tick = 0; tick < 25; tick++) {
      const d = decideDraftTick(input({
        windowStart, totalSamples, commitAt: null, sliceBytes: 0, maxWindowMs: 20_000,
      }));
      windowStart = d.nextWindowStart;
      totalSamples += s(2000);              // 2s of new audio per tick
      const open = totalSamples - windowStart;
      expect(open).toBeLessThanOrEqual(s(22_000));   // bound + one tick of new audio
      previousOpen = open;
    }
    expect(previousOpen).toBeLessThanOrEqual(s(22_000));
  });
});
