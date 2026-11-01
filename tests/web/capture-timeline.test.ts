/**
 * The per-second capture timeline the mic logs at stop
 * (web/src/utils/capture-timeline.ts). It names which clock fell behind when a
 * recording holds less audio than it ran (2026-11-01, the Mac app).
 */
import { describe, it, expect } from 'vitest';
import { captureSeconds, describeShortSeconds, secondIsShort, MAX_DESCRIBED_SECONDS, type CaptureSample } from '../../web/src/utils/capture-timeline.js';

/** One sample per 100 ms; `stall(sec)` freezes the audio clocks and reads zeros. */
function run(secs: number, stall: (s: number) => boolean = () => false): CaptureSample[] {
  const out: CaptureSample[] = [];
  let pcm = 0, ctx = 0, rec = 0;
  for (let i = 0; i < secs * 10; i++) {
    const wallMs = i * 100;
    const stalled = stall(Math.floor(wallMs / 1000));
    if (!stalled) { pcm += 100; ctx += 100; rec += 50; }
    out.push({ wallMs, pcmMs: pcm, ctxMs: ctx, zero: stalled, recBytes: rec });
  }
  return out;
}

describe('capture timeline', () => {
  it('a clean recording has no short second', () => {
    const secs = captureSeconds(run(10));
    expect(secs).toHaveLength(10);
    expect(describeShortSeconds(secs)).toBe('');
  });

  it('a mid-recording stall names its seconds with one second of context either side', () => {
    const secs = captureSeconds(run(12, (s) => s === 5 || s === 6));
    expect(secondIsShort(secs[5])).toBe(true);
    expect(describeShortSeconds(secs).split(' | ').map((p) => p.split(' ')[0])).toEqual(['s=4', 's=5', 's=6', 's=7']);
    expect(describeShortSeconds(secs)).toContain('s=5 t10 z10 pcm0 ctx0 rec0');
  });

  it('the capture coming up (short seconds before the first clean one) is left to the start line', () => {
    expect(describeShortSeconds(captureSeconds(run(8, (s) => s < 2)))).toBe('');
    // A stall after it came up is still reported.
    expect(describeShortSeconds(captureSeconds(run(10, (s) => s < 1 || s === 5)))).toContain('s=5 ');
  });

  it('the last, partial second is never reported', () => {
    const samples = run(5).slice(0, 43);
    expect(describeShortSeconds(captureSeconds(samples))).toBe('');
  });

  it('a sampler that stopped running (main thread blocked) shows as missing ticks', () => {
    const samples = run(6).filter((x) => !(x.wallMs >= 2000 && x.wallMs < 2800));
    const secs = captureSeconds(samples);
    expect(secs[2].ticks).toBe(2);
    expect(secondIsShort(secs[2])).toBe(true);
  });

  it('a long run of short seconds stays one bounded line', () => {
    const line = describeShortSeconds(captureSeconds(run(200, (s) => s >= 2 && s % 2 === 0)));
    expect(line.split(' | ')).toHaveLength(MAX_DESCRIBED_SECONDS + 1);
    expect(line).toMatch(/\+\d+ more seconds$/);
  });
});
